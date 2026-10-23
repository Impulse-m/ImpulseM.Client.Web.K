import {beforeEach, describe, expect, it, vi} from 'vitest';
import {create, toBinary} from '@bufbuild/protobuf';

import type {ActiveAccountNumber} from '@lib/accounts/types';
import {BoolResponseSchema, FileHashListSchema, UploadFileSchema, UploadFileValueSchema} from './gen/v1/types_pb';
import {grpcInvoke} from './adapter';


const {callMediaFleet, hasMediaFleetPool, gatewayCall, refreshImpulseSession} = vi.hoisted(() => ({
  callMediaFleet: vi.fn(),
  hasMediaFleetPool: vi.fn(() => true),
  gatewayCall: vi.fn(),
  refreshImpulseSession: vi.fn()
}));

vi.mock('@lib/impulse/media/mediaFleet', () => ({callMediaFleet, hasMediaFleetPool}));

vi.mock('@connectrpc/connect', async(importActual) => {
  const actual = await importActual<typeof import('@connectrpc/connect')>();
  return {
    ...actual,
    createClient: vi.fn(() => ({
      saveFilePart: gatewayCall,
      getFile: gatewayCall,
      saveBigFilePart: gatewayCall,
      getWebFile: gatewayCall,
      getCdnFileHashes: gatewayCall
    }))
  };
});

vi.mock('@lib/impulse/grpc/transport', async(importActual) => {
  const actual = await importActual<typeof import('@lib/impulse/grpc/transport')>();
  return {...actual, getGrpcTransport: vi.fn(() => ({}))};
});

vi.mock('@lib/impulse/session', async(importActual) => {
  const actual = await importActual<typeof import('@lib/impulse/session')>();
  return {
    ...actual,
    whenImpulseSessionReady: vi.fn(async(): Promise<void> => {}),
    captureImpulseSessionToken: vi.fn(async(): Promise<boolean> => false),
    clearPendingToken: vi.fn(async(): Promise<void> => {}),
    persistPendingToken: vi.fn(async(): Promise<void> => {}),
    refreshImpulseSession
  };
});


const ACCOUNT: ActiveAccountNumber = 1;
const FLEET_PAYLOAD: Uint8Array = new Uint8Array([7, 7, 7]);
const GATEWAY_PAYLOAD: Uint8Array = new Uint8Array([9, 9, 9]);
const GET_FILE_PARAMS = {offset: 0, limit: 1024};

function uploadFileBytes(payload: Uint8Array): Uint8Array {
  return toBinary(UploadFileSchema, create(UploadFileSchema, {
    value: {case: 'uploadFile', value: create(UploadFileValueSchema, {bytes: payload})}
  }));
}

function gatewayUploadFile(payload: Uint8Array): unknown {
  return create(UploadFileSchema, {
    value: {case: 'uploadFile', value: create(UploadFileValueSchema, {bytes: payload})}
  });
}

describe('grpcInvoke sends the four file-transfer methods to the media fleet first', () => {
  beforeEach(() => {
    callMediaFleet.mockReset();
    hasMediaFleetPool.mockReset();
    hasMediaFleetPool.mockReturnValue(true);
    gatewayCall.mockReset();
    refreshImpulseSession.mockReset();
  });

  it('a gateway-only account never builds or sends a fleet call', async() => {
    hasMediaFleetPool.mockReturnValue(false);
    gatewayCall.mockResolvedValueOnce(gatewayUploadFile(GATEWAY_PAYLOAD));

    const result = await grpcInvoke('upload.getFile', GET_FILE_PARAMS, ACCOUNT);

    expect(callMediaFleet, 'with no media option the file part must not be encoded or offered to the fleet').not.toHaveBeenCalled();
    expect(result.bytes).toEqual(GATEWAY_PAYLOAD);
  });

  it('answers a file call from the fleet without touching the gateway', async() => {
    callMediaFleet.mockResolvedValueOnce(uploadFileBytes(FLEET_PAYLOAD));

    const result = await grpcInvoke('upload.getFile', GET_FILE_PARAMS, ACCOUNT);

    expect(callMediaFleet.mock.calls[0][1], 'the registry method must be the canon name').toBe('upload.getFile');
    expect(gatewayCall, 'a fleet answer is the answer: the gateway must not be asked as well').not.toHaveBeenCalled();
    expect(result.bytes).toEqual(FLEET_PAYLOAD);
  });

  it('answers a saveFilePart from the fleet with the gRPC response message', async() => {
    callMediaFleet.mockResolvedValueOnce(toBinary(BoolResponseSchema, create(BoolResponseSchema, {value: true})));

    await expect(grpcInvoke('upload.saveFilePart', {file_id: 1, file_part: 0, bytes: GATEWAY_PAYLOAD}, ACCOUNT)).resolves.toBe(true);
    expect(gatewayCall).not.toHaveBeenCalled();
  });

  it('falls back to the gateway when the fleet gives no answer', async() => {
    callMediaFleet.mockResolvedValueOnce(undefined);
    gatewayCall.mockResolvedValueOnce(gatewayUploadFile(GATEWAY_PAYLOAD));

    const result = await grpcInvoke('upload.getFile', GET_FILE_PARAMS, ACCOUNT);

    expect(gatewayCall, 'a transport fault must reach the gateway path for that call').toHaveBeenCalledTimes(1);
    expect(result.bytes).toEqual(GATEWAY_PAYLOAD);
  });

  it('refreshes the session once and replays the call when the fleet refuses the access token', async() => {
    callMediaFleet
    .mockRejectedValueOnce({type: 'AUTH_KEY_UNREGISTERED', code: 401})
    .mockResolvedValueOnce(uploadFileBytes(FLEET_PAYLOAD));
    refreshImpulseSession.mockResolvedValueOnce(true);

    const result = await grpcInvoke('upload.getFile', GET_FILE_PARAMS, ACCOUNT);

    expect(refreshImpulseSession, 'an expired access token is renewed the way every gRPC call renews it').toHaveBeenCalledTimes(1);
    expect(callMediaFleet, 'the replayed call goes back to the fleet').toHaveBeenCalledTimes(2);
    expect(result.bytes).toEqual(FLEET_PAYLOAD);
  });

  it('a method outside the four never reaches the fleet', async() => {
    gatewayCall.mockResolvedValueOnce(create(FileHashListSchema, {}));

    await grpcInvoke('upload.getCdnFileHashes', {}, ACCOUNT);

    expect(callMediaFleet, 'only the four registry calls may travel the fleet').not.toHaveBeenCalled();
    expect(gatewayCall).toHaveBeenCalledTimes(1);
  });
});
