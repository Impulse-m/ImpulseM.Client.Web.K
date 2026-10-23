import {beforeEach, describe, expect, it, vi} from 'vitest';
import {create, fromBinary, toBinary} from '@bufbuild/protobuf';

import {ConfigSchema, UploadFileSchema, UploadFileValueSchema} from '@lib/impulse/grpc/gen/v1/types_pb';
import {GetFileRequestSchema} from '@lib/impulse/grpc/gen/upload_pb';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import {FLEET_CONNECTION_PATH} from '@lib/impulse/fleet/fleetRoute';
import type {FleetConfig} from '@lib/impulse/fleet/fleetRoute';
import {sharedFleetPoolHarness} from './helpers/fleetPoolStub';
import {sharedUpdateSocketHarness} from './helpers/updateSocketStub';

/*
 * Routing of a TL call to the carrier the client sends it on. The four file-transfer calls go to the media fleet when
 * the config publishes its media_only dcOption; every other call is an rpc on the one update socket, with no RPC pool.
 */

const warn = vi.hoisted(() => vi.fn());

vi.mock('@impulsem/centrifuge/build/protobuf', async(importActual) => {
  const actual = await importActual<typeof import('@impulsem/centrifuge/build/protobuf')>();
  const {sharedFleetPoolHarness: pools} = await import('./helpers/fleetPoolStub');
  const {sharedUpdateSocketHarness: sockets} = await import('./helpers/updateSocketStub');
  return {...actual, RpcPool: pools().RpcPoolStub, Centrifuge: sockets().CentrifugeStub};
});

vi.mock('@lib/accounts/accountController', () => ({
  default: {
    get: vi.fn(async() => undefined),
    update: vi.fn(),
    clearFields: vi.fn()
  }
}));

vi.mock('@lib/impulseLogger', () => ({
  getLogger: () => ({info: vi.fn(), warn, debug: vi.fn(), error: vi.fn()}),
  setLogAuthTokenProvider: vi.fn()
}));

const fleetHarness = sharedFleetPoolHarness();
const socketHarness = sharedUpdateSocketHarness();

const ACCOUNT: ActiveAccountNumber = 1;
const CURRENT_DC: number = 2;
const MEDIA_URL: string = `wss://media.impulsem.io:443${FLEET_CONNECTION_PATH}`;
const GET_FILE: string = 'upload.getFile';
const GET_CONFIG: string = 'help.getConfig';
const FILE_PAYLOAD: Uint8Array = new Uint8Array([7, 7, 7]);

function withMediaOption(): FleetConfig {
  return {
    this_dc: CURRENT_DC,
    dc_options: [
      {id: CURRENT_DC, ip_address: '149.154.167.50', port: 443},
      {id: CURRENT_DC, ip_address: 'media.impulsem.io', port: 443, pFlags: {media_only: true}}
    ]
  };
}

function withoutMediaOption(): FleetConfig {
  return {this_dc: CURRENT_DC, dc_options: [{id: CURRENT_DC, ip_address: '149.154.167.50', port: 443}]};
}

function uploadedFile(): Uint8Array {
  return toBinary(UploadFileSchema, create(UploadFileSchema, {
    value: {case: 'uploadFile', value: create(UploadFileValueSchema, {bytes: FILE_PAYLOAD})}
  }));
}

function configReply(): {data: Uint8Array} {
  return {data: toBinary(ConfigSchema, create(ConfigSchema, {}))};
}

beforeEach(async() => {
  vi.resetModules();
  fleetHarness.reset();
  socketHarness.reset();
  warn.mockClear();
  const {restoreImpulseSession} = await import('@lib/impulse/session');
  await restoreImpulseSession(ACCOUNT);
  const {setFleetConfig} = await import('@lib/impulse/fleet/fleet');
  setFleetConfig(ACCOUNT, withMediaOption());
});

describe('a regular method is one rpc on the update socket', () => {
  it('sends it on the update socket, and opens no RPC pool for it', async() => {
    socketHarness.respondOnce(GET_CONFIG, configReply);
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');

    await grpcInvoke(GET_CONFIG, {}, ACCOUNT);

    expect(
      socketHarness.calls.map((call) => call.method),
      'a regular method travels the update socket, the one connection of the client'
    ).toEqual([GET_CONFIG]);
    expect(fleetHarness.pools, 'no separate RPC pool carries the regular methods').toHaveLength(0);
  });

  it('gets the reply bytes of the socket decoded to its TL value', async() => {
    socketHarness.respondOnce(GET_CONFIG, configReply);
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');

    await expect(grpcInvoke(GET_CONFIG, {}, ACCOUNT)).resolves.toMatchObject({_: 'config'});
  });

  it('a reply without data is a typed transport error, never an empty answer', async() => {
    socketHarness.respondOnce(GET_CONFIG, () => ({data: undefined}));
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');

    await expect(
      grpcInvoke(GET_CONFIG, {}, ACCOUNT),
      'a reply that carries no data is a fault of the socket, not an empty success'
    ).rejects.toMatchObject({type: 'NETWORK_BAD_RESPONSE', code: 500});
  });

  it('a server rejection is mapped by the one mapper, and 104 is traced with the method name', async() => {
    socketHarness.respondOnce(GET_CONFIG, () => {
      throw {code: 104, message: 'METHOD_INVALID', appCode: 400, appType: 'METHOD_INVALID'};
    });
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');

    await expect(grpcInvoke(GET_CONFIG, {}, ACCOUNT)).rejects.toMatchObject({type: 'METHOD_INVALID', code: 400});
    expect(
      warn.mock.calls.some(([, payload]) => payload?.code === 104 && payload?.method === GET_CONFIG),
      'the server lacks this method: the remote trace must name it so the server can add it'
    ).toBe(true);
    expect(socketHarness.calls, 'a METHOD_INVALID is not retried').toHaveLength(1);
  });
});

describe('a file-transfer method is carried by the media fleet when the config publishes it', () => {
  it('sends the file query to the media pool, not to the update socket', async() => {
    fleetHarness.respondOnce(GET_FILE, () => ({data: uploadedFile()}));
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');

    const result = await grpcInvoke(GET_FILE, {offset: 0, limit: 1024}, ACCOUNT);

    expect(fleetHarness.calls[0].endpoint, 'the file query travels the media fleet').toBe(MEDIA_URL);
    expect(fromBinary(GetFileRequestSchema, fleetHarness.calls[0].data).limit).toBe(1024);
    expect(result.bytes).toEqual(FILE_PAYLOAD);
    expect(socketHarness.calls, 'a file query published on the media fleet never touches the update socket').toHaveLength(0);
  });
});

describe('a file-transfer method is refused with a typed error when the config publishes no media option', () => {
  it('fails the call, and sends it on neither carrier', async() => {
    const {setFleetConfig} = await import('@lib/impulse/fleet/fleet');
    setFleetConfig(ACCOUNT, withoutMediaOption());
    socketHarness.respondOnce(GET_FILE, () => ({data: uploadedFile()}));
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');

    await expect(
      grpcInvoke(GET_FILE, {offset: 0, limit: 1024}, ACCOUNT),
      'a file query has no carrier without a media_only option: the update socket is not a fallback for it'
    ).rejects.toMatchObject({type: 'NETWORK_BAD_RESPONSE', code: 500});
    expect(socketHarness.calls, 'the file query never travels the update socket').toHaveLength(0);
    expect(fleetHarness.pools, 'no media pool is opened without a published endpoint').toHaveLength(0);
  });
});

describe('the counters name the carrier each call went over', () => {
  it('counts a socket rpc and a media call apart', async() => {
    const {fleetCounters} = await import('@lib/impulse/fleet/fleet');
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
    const before = fleetCounters(ACCOUNT);
    socketHarness.respondOnce(GET_CONFIG, configReply);
    fleetHarness.respondOnce(GET_FILE, () => ({data: uploadedFile()}));

    await grpcInvoke(GET_CONFIG, {}, ACCOUNT);
    await grpcInvoke(GET_FILE, {offset: 0, limit: 1024}, ACCOUNT);

    const after = fleetCounters(ACCOUNT);
    expect(
      {socket: after.socket - before.socket, media: after.media - before.media},
      'each carrier counts the calls it answered'
    ).toEqual({socket: 1, media: 1});
  });
});
