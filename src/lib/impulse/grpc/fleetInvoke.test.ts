import {beforeEach, describe, expect, it, vi} from 'vitest';
import {create, fromBinary, toBinary} from '@bufbuild/protobuf';

import {backendHttpOrigin, backendWsOrigin} from '@config/backendOrigin';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import {CENTRIFUGO_CONNECTION_PATH, FLEET_CONNECTION_PATH} from '@lib/impulse/fleet/fleetPath';
import {BoolResponseSchema, ConfigSchema, UploadFileSchema, UploadFileValueSchema} from './gen/v1/types_pb';
import {AuthorizationSchema} from './gen/v1/internal/impulse/auth/auth_types_pb';
import {GetFileRequestSchema} from './gen/upload_pb';
import {grpcInvoke} from './adapter';
import {sharedFleetPoolHarness} from '../../../tests/helpers/fleetPoolStub';
import {sharedUpdateSocketHarness} from '../../../tests/helpers/updateSocketStub';
import {registerSessionIdentitySource} from '../../../tests/helpers/fleetIdentitySource';

vi.mock('@impulsem/centrifuge/build/protobuf', async(importActual) => {
  const actual = await importActual<typeof import('@impulsem/centrifuge/build/protobuf')>();
  const {sharedFleetPoolHarness} = await import('../../../tests/helpers/fleetPoolStub');
  const {sharedUpdateSocketHarness} = await import('../../../tests/helpers/updateSocketStub');
  return {...actual, RpcPool: sharedFleetPoolHarness().RpcPoolStub, Centrifuge: sharedUpdateSocketHarness().CentrifugeStub};
});

vi.mock('@lib/accounts/accountController', () => ({
  default: {
    get: vi.fn(),
    update: vi.fn(),
    clearFields: vi.fn()
  }
}));


const fleetHarness = sharedFleetPoolHarness();
const socketHarness = sharedUpdateSocketHarness();

const ACCOUNT: ActiveAccountNumber = 1;
const FLEET_PAYLOAD: Uint8Array = new Uint8Array([7, 7, 7]);
const GET_FILE_PARAMS = {offset: 0, limit: 1024};
const GET_CONFIG = 'help.getConfig';
const STALE_SESSION_TOKEN: string = 'session-token-stale';
const RENEWED_TOKEN: string = 'session-token-renewed';
const MEDIA_URL: string = `wss://media.impulsem.io:443${FLEET_CONNECTION_PATH}`;
const SOCKET_URL: string = `${backendWsOrigin(backendHttpOrigin())}${CENTRIFUGO_CONNECTION_PATH}`;
const TOKEN_EXPIRED: number = 109;

function uploadFileBytes(payload: Uint8Array): Uint8Array {
  return toBinary(UploadFileSchema, create(UploadFileSchema, {
    value: {case: 'uploadFile', value: create(UploadFileValueSchema, {bytes: payload})}
  }));
}

describe('grpcInvoke sends the TL call to the carrier that serves it', () => {
  beforeEach(async() => {
    fleetHarness.reset();
    socketHarness.reset();
    await registerSessionIdentitySource();
    const {restoreImpulseSession} = await import('@lib/impulse/session');
    await restoreImpulseSession(ACCOUNT);
    const {setFleetConfig} = await import('@lib/impulse/fleet/fleet');
    setFleetConfig(ACCOUNT, {
      this_dc: 2,
      dc_options: [
        {id: 2, ip_address: '149.154.167.50', port: 443},
        {id: 2, ip_address: 'media.impulsem.io', port: 443, pFlags: {media_only: true}}
      ]
    });
  });

  it('sends a file query to the media fleet under its canon name, with the protobuf request', async() => {
    fleetHarness.respondOnce('upload.getFile', () => ({data: uploadFileBytes(FLEET_PAYLOAD)}));
    const {grpcInvoke: invoke} = await import('./adapter');

    const result = await invoke('upload.getFile', GET_FILE_PARAMS, ACCOUNT);

    expect(fleetHarness.calls[0].endpoint, 'a file query travels the media fleet').toBe(MEDIA_URL);
    expect(fleetHarness.calls[0].method).toBe('upload.getFile');
    expect(fromBinary(GetFileRequestSchema, fleetHarness.calls[0].data).limit, 'the request is the protobuf GetFile request')
      .toBe(1024);
    expect(result.bytes).toEqual(FLEET_PAYLOAD);
  });

  it('sends every other method as an rpc on the update socket, not the media fleet', async() => {
    socketHarness.respondOnce(GET_CONFIG, () => ({data: toBinary(ConfigSchema, create(ConfigSchema, {}))}));

    await grpcInvoke(GET_CONFIG, {}, ACCOUNT);

    expect(socketHarness.calls[0].endpoint, 'a regular method travels the update socket of the slot').toBe(SOCKET_URL);
    expect(fleetHarness.pools, 'no RPC pool carries a regular method').toHaveLength(0);
  });

  it('answers a saveFilePart with the gRPC response message decoded to its TL value', async() => {
    fleetHarness.respondOnce('upload.saveFilePart', () => ({
      data: toBinary(BoolResponseSchema, create(BoolResponseSchema, {value: true}))
    }));

    await expect(grpcInvoke('upload.saveFilePart', {file_id: 1, file_part: 0, bytes: FLEET_PAYLOAD}, ACCOUNT)).resolves.toBe(true);
  });

  it('a refused session token renews the session and replays the call once, on a socket that presents the renewed token', async() => {
    const {restoreImpulseSession} = await import('@lib/impulse/session');
    const accountController = await import('@lib/accounts/accountController');
    vi.mocked(accountController.default.get).mockResolvedValue({
      userId: 42,
      impulse_session_token: STALE_SESSION_TOKEN,
      impulse_refresh_token: 'refresh-token-stored'
    } as never);
    await restoreImpulseSession(ACCOUNT);
    socketHarness.respondOnce(GET_CONFIG, () => {
      throw {code: TOKEN_EXPIRED, message: 'token expired'};
    });
    socketHarness.respondOnce(GET_CONFIG, () => ({data: toBinary(ConfigSchema, create(ConfigSchema, {}))}));
    fleetHarness.respond('impulse.auth.refreshSession', () => ({
      data: toBinary(AuthorizationSchema, create(AuthorizationSchema, {sessionToken: RENEWED_TOKEN, refreshToken: 'refresh-token-next'}))
    }));

    await grpcInvoke(GET_CONFIG, {}, ACCOUNT);

    expect(
      socketHarness.calls.map((call) => call.method),
      'the refused call is sent on the update socket, and replayed there once the session is renewed'
    ).toEqual([GET_CONFIG, GET_CONFIG]);
    expect(fleetHarness.calls.map((call) => call.method), 'the renewal is one call of the refresh pool').toEqual(['impulse.auth.refreshSession']);
    expect(socketHarness.calls[1].presentedToken, 'the replay presents the renewed token, not the refused one').toBe(RENEWED_TOKEN);
  });
});
