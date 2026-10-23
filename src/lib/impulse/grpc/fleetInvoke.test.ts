import {beforeEach, describe, expect, it, vi} from 'vitest';
import {create, fromBinary, toBinary} from '@bufbuild/protobuf';

import type {ActiveAccountNumber} from '@lib/accounts/types';
import {BoolResponseSchema, ConfigSchema, UploadFileSchema, UploadFileValueSchema} from './gen/v1/types_pb';
import {AuthorizationSchema} from './gen/v1/internal/impulse/auth/auth_types_pb';
import {GetFileRequestSchema} from './gen/upload_pb';
import {grpcInvoke} from './adapter';
import {sharedFleetPoolHarness} from '../../../tests/helpers/fleetPoolStub';

vi.mock('@impulsem/centrifuge/build/protobuf', async(importActual) => {
  const actual = await importActual<typeof import('@impulsem/centrifuge/build/protobuf')>();
  const {sharedFleetPoolHarness} = await import('../../../tests/helpers/fleetPoolStub');
  return {...actual, RpcPool: sharedFleetPoolHarness().RpcPoolStub};
});

vi.mock('@lib/accounts/accountController', () => ({
  default: {
    get: vi.fn(),
    update: vi.fn(),
    clearFields: vi.fn()
  }
}));


const fleetHarness = sharedFleetPoolHarness();

const ACCOUNT: ActiveAccountNumber = 1;
const FLEET_PAYLOAD: Uint8Array = new Uint8Array([7, 7, 7]);
const GET_FILE_PARAMS = {offset: 0, limit: 1024};
const TOKEN_EXPIRED: number = 109;
const STALE_SESSION_TOKEN: string = 'session-token-stale';
const RENEWED_TOKEN: string = 'session-token-renewed';
const MEDIA_URL: string = 'wss://media.impulsem.io:443/connection/websocket?cf_protocol=protobuf&cf_ws_frame_ping_pong=true';
const RPC_URL: string = 'wss://149.154.167.50:443/connection/websocket?cf_protocol=protobuf&cf_ws_frame_ping_pong=true';

function uploadFileBytes(payload: Uint8Array): Uint8Array {
  return toBinary(UploadFileSchema, create(UploadFileSchema, {
    value: {case: 'uploadFile', value: create(UploadFileValueSchema, {bytes: payload})}
  }));
}

describe('grpcInvoke sends the TL call to the fleet that carries it', () => {
  beforeEach(async() => {
    fleetHarness.reset();
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

    const result = await grpcInvoke('upload.getFile', GET_FILE_PARAMS, ACCOUNT);

    expect(fleetHarness.calls[0].endpoint, 'a file query travels the media fleet').toBe(MEDIA_URL);
    expect(fleetHarness.calls[0].method).toBe('upload.getFile');
    expect(fromBinary(GetFileRequestSchema, fleetHarness.calls[0].data).limit, 'the request is the protobuf GetFile request')
      .toBe(1024);
    expect(result.bytes).toEqual(FLEET_PAYLOAD);
  });

  it('sends every other method to the RPC fleet, not the media fleet', async() => {
    fleetHarness.respondOnce('help.getConfig', () => ({data: toBinary(ConfigSchema, create(ConfigSchema, {}))}));

    await grpcInvoke('help.getConfig', {}, ACCOUNT);

    expect(fleetHarness.calls[0].endpoint).toBe(RPC_URL);
  });

  it('answers a saveFilePart with the gRPC response message decoded to its TL value', async() => {
    fleetHarness.respondOnce('upload.saveFilePart', () => ({
      data: toBinary(BoolResponseSchema, create(BoolResponseSchema, {value: true}))
    }));

    await expect(grpcInvoke('upload.saveFilePart', {file_id: 1, file_part: 0, bytes: FLEET_PAYLOAD}, ACCOUNT)).resolves.toBe(true);
  });

  it('a refused session token renews the session and replays the call once, on a connection that presents the renewed token', async() => {
    const {restoreImpulseSession} = await import('@lib/impulse/session');
    const accountController = await import('@lib/accounts/accountController');
    vi.mocked(accountController.default.get).mockResolvedValue({
      userId: 42,
      impulse_session_token: STALE_SESSION_TOKEN,
      impulse_refresh_token: 'refresh-token-stored'
    } as never);
    await restoreImpulseSession(ACCOUNT);
    fleetHarness.respondOnce('help.getConfig', () => {
      throw {code: TOKEN_EXPIRED, message: 'token expired'};
    });
    fleetHarness.respondOnce('help.getConfig', () => ({data: toBinary(ConfigSchema, create(ConfigSchema, {}))}));
    fleetHarness.respond('impulse.auth.refreshSession', () => ({
      data: toBinary(AuthorizationSchema, create(AuthorizationSchema, {sessionToken: RENEWED_TOKEN, refreshToken: 'refresh-token-next'}))
    }));

    await grpcInvoke('help.getConfig', {}, ACCOUNT);

    expect(
      fleetHarness.calls.map((call) => call.method),
      'the refused call is renewed once through the refresh, then replayed'
    ).toEqual(['help.getConfig', 'impulse.auth.refreshSession', 'help.getConfig']);
    expect(fleetHarness.calls[2].presentedToken, 'the replay presents the renewed token, not the refused one').toBe(RENEWED_TOKEN);
  });
});
