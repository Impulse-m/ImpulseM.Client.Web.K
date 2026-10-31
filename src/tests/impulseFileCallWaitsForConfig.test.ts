import {beforeEach, describe, expect, it, vi} from 'vitest';
import {create, toBinary} from '@bufbuild/protobuf';

import {UploadFileSchema, UploadFileValueSchema} from '@lib/impulse/grpc/gen/v1/types_pb';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import {FLEET_CONNECTION_PATH} from '@lib/impulse/fleet/fleetPath';
import type {FleetConfig} from '@lib/impulse/fleet/fleetRoute';
import {sharedFleetPoolHarness} from './helpers/fleetPoolStub';
import {sharedUpdateSocketHarness} from './helpers/updateSocketStub';
import {registerSessionIdentitySource} from './helpers/fleetIdentitySource';

/*
 * A file-transfer call has one carrier, the media fleet that the config names. A call issued before the config is
 * published waits for the config event that publishes it, and never travels the update socket in the meantime.
 */

const {accountGet, accountUpdate, accountClearFields} = vi.hoisted(() => ({
  accountGet: vi.fn(),
  accountUpdate: vi.fn(),
  accountClearFields: vi.fn()
}));

vi.mock('@lib/impulseLogger', () => ({
  getLogger: () => ({debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}),
  setLogAuthTokenProvider: vi.fn()
}));

vi.mock('@impulsem/centrifuge/build/protobuf', async(importActual) => {
  const actual = await importActual<typeof import('@impulsem/centrifuge/build/protobuf')>();
  const {sharedFleetPoolHarness: pools} = await import('./helpers/fleetPoolStub');
  const {sharedUpdateSocketHarness: sockets} = await import('./helpers/updateSocketStub');
  return {...actual, RpcPool: pools().RpcPoolStub, Centrifuge: sockets().CentrifugeStub};
});

vi.mock('@lib/accounts/accountController', () => ({
  default: {
    get: accountGet,
    update: accountUpdate,
    clearFields: accountClearFields
  }
}));

const fleetHarness = sharedFleetPoolHarness();
const socketHarness = sharedUpdateSocketHarness();

const ACCOUNT: ActiveAccountNumber = 1;
const CURRENT_DC: number = 2;
const GET_FILE: string = 'upload.getFile';
const MEDIA_URL: string = `wss://media.example.org:443${FLEET_CONNECTION_PATH}`;
const FILE_PAYLOAD: Uint8Array = new Uint8Array([7, 7, 7]);
const GET_FILE_PARAMS = {offset: 0, limit: 1024};

function withMediaOption(): FleetConfig {
  return {
    this_dc: CURRENT_DC,
    dc_options: [
      {id: CURRENT_DC, ip_address: '149.154.167.50', port: 443},
      {id: CURRENT_DC, ip_address: 'media.example.org', port: 443, pFlags: {media_only: true}}
    ]
  };
}

function withoutMediaOption(): FleetConfig {
  return {this_dc: CURRENT_DC, dc_options: [{id: CURRENT_DC, ip_address: '149.154.167.50', port: 443}]};
}

function uploadedFile(): {data: Uint8Array} {
  return {
    data: toBinary(UploadFileSchema, create(UploadFileSchema, {
      value: {case: 'uploadFile', value: create(UploadFileValueSchema, {bytes: FILE_PAYLOAD})}
    }))
  };
}

beforeEach(async() => {
  vi.resetModules();
  fleetHarness.reset();
  socketHarness.reset();
  accountGet.mockReset();
  accountUpdate.mockReset();
  accountClearFields.mockReset();
  accountGet.mockResolvedValue({userId: 42, impulse_session_token: 'fixture-session'});
  await registerSessionIdentitySource();
  const {restoreImpulseSession} = await import('@lib/impulse/session');
  await restoreImpulseSession(ACCOUNT);
});

describe('a file query issued before the config publishes its media option', () => {
  it('waits for the config event, then completes on the media lane and never touches the update socket', async() => {
    socketHarness.respondOnce(GET_FILE, uploadedFile);
    fleetHarness.respondOnce(GET_FILE, uploadedFile);
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
    const {fleetConfigWaiters, setFleetConfig} = await import('@lib/impulse/fleet/fleet');

    const reply = grpcInvoke(GET_FILE, GET_FILE_PARAMS, ACCOUNT);
    await vi.waitFor(() => expect(fleetConfigWaiters(ACCOUNT), 'the file query is held for the config').toBe(1));
    setFleetConfig(ACCOUNT, withMediaOption());

    await expect(reply, 'the file query completes once the config publishes its media option').resolves.toMatchObject({bytes: FILE_PAYLOAD});
    expect(fleetHarness.calls.map((call) => call.endpoint), 'the file query travels the media endpoint the config published').toEqual([MEDIA_URL]);
    expect(socketHarness.calls, 'a file query issued before the config must not travel the update socket').toHaveLength(0);
  });

  it('is refused with the typed transport error when the config publishes no media option, and touches no carrier', async() => {
    socketHarness.respondOnce(GET_FILE, uploadedFile);
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
    const {fleetConfigWaiters, setFleetConfig} = await import('@lib/impulse/fleet/fleet');

    const reply = grpcInvoke(GET_FILE, GET_FILE_PARAMS, ACCOUNT).then(() => 'resolved', (error: unknown) => error);
    await vi.waitFor(() => expect(fleetConfigWaiters(ACCOUNT), 'the file query is held for the config').toBe(1));
    setFleetConfig(ACCOUNT, withoutMediaOption());

    await expect(reply, 'a config without a media_only option fails the waiting file query with the typed error').resolves.toMatchObject({
      type: 'NETWORK_BAD_RESPONSE',
      code: 500
    });
    expect(socketHarness.calls, 'the file query never falls back to the update socket').toHaveLength(0);
    expect(fleetHarness.pools, 'no media pool is opened for a config that publishes none').toHaveLength(0);
  });

  it('is cancelled by its signal while it waits, and is not sent when the config arrives afterwards', async() => {
    const controller = new AbortController();
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
    const {fleetConfigWaiters, setFleetConfig} = await import('@lib/impulse/fleet/fleet');

    const reply = grpcInvoke(GET_FILE, GET_FILE_PARAMS, ACCOUNT, controller.signal).then(() => 'resolved', (error: unknown) => error);
    await vi.waitFor(() => expect(fleetConfigWaiters(ACCOUNT), 'the file query is held for the config').toBe(1));
    controller.abort();

    await expect(reply, 'the signal of the caller cancels the wait').resolves.toMatchObject({type: 'CANCELED'});
    expect(fleetConfigWaiters(ACCOUNT), 'the cancelled query has left the wait').toBe(0);
    setFleetConfig(ACCOUNT, withMediaOption());
    expect(fleetHarness.calls, 'a cancelled file query is never sent once the config arrives').toHaveLength(0);
    expect(socketHarness.calls, 'a cancelled file query never travels the update socket').toHaveLength(0);
  });
});
