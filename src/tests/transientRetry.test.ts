import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {create, toBinary} from '@bufbuild/protobuf';
import {errorCodes} from '@impulsem/centrifuge/build/protobuf';

import type {ActiveAccountNumber} from '@lib/accounts/types';
import {apiErrorOf, transportApiError} from '@lib/impulse/fleet/fleetError';
import {TOKEN_EXPIRED_CODE} from '@lib/impulse/centrifugoCodes';
import {BoolResponseSchema} from '@lib/impulse/grpc/gen/v1/types_pb';
import {invokeWithTransientRetry, retryDelayMs, withTransientRetry} from '@appManagers/utils/transientRetry';
import {sharedFleetPoolHarness} from './helpers/fleetPoolStub';
import {sharedUpdateSocketHarness} from './helpers/updateSocketStub';
import {registerSessionIdentitySource} from './helpers/fleetIdentitySource';

vi.mock('@impulsem/centrifuge/build/protobuf', async(importActual) => {
  const actual = await importActual<typeof import('@impulsem/centrifuge/build/protobuf')>();
  const {sharedFleetPoolHarness} = await import('./helpers/fleetPoolStub');
  const {sharedUpdateSocketHarness} = await import('./helpers/updateSocketStub');
  return {...actual, RpcPool: sharedFleetPoolHarness().RpcPoolStub, Centrifuge: sharedUpdateSocketHarness().CentrifugeStub};
});

vi.mock('@lib/accounts/accountController', () => ({
  default: {
    get: vi.fn().mockResolvedValue({userId: 42, impulse_session_token: 'routing-session', impulse_refresh_token: 'refresh'}),
    update: vi.fn(),
    clearFields: vi.fn()
  }
}));

const ACCOUNT: ActiveAccountNumber = 1;
const SAVE_FILE_PART: string = 'upload.saveFilePart';
const SAVE_FILE_PART_PARAMS = {file_id: 1, file_part: 0, bytes: new Uint8Array([7, 7, 7])};
const MESSAGES_GET_DIALOGS: string = 'messages.getDialogs';
const CONNECTION_NOT_INITED_TYPE: ErrorType = 'CONNECTION_NOT_INITED';
const SDK_UNAVAILABLE_CODE: number = 100;
const REQUEST_TOO_LARGE_CODE: number = 106;
const OVERLOADED_CODE: number = 111;
const MAX_BACKOFF_MS: number = 8_000;
const FIRST_BACKOFF_MS: number = 500;
const SECOND_BACKOFF_MS: number = 1_000;
const ZERO_RANDOM: () => number = (): number => 0;
const HALF_RANDOM: () => number = (): number => 0.5;
const CEILING_RANDOM: () => number = (): number => 1;
const SUCCESS: string = 'uploaded';

function temporaryError(): ApiError {
  return transportApiError({code: errorCodes.timeout, message: 'timeout'});
}

function sdkRefusal(code: number): ApiError {
  return transportApiError({code, message: 'refused'});
}

function temporaryServerError(): ApiError {
  return transportApiError({
    code: SDK_UNAVAILABLE_CODE,
    message: 'INTERNAL_SERVER_ERROR',
    temporary: true,
    appCode: 500,
    appType: 'INTERNAL_SERVER_ERROR'
  });
}

describe('withTransientRetry retries a transient media-lane error on the fake clock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a timed-out part and completes the upload on the third attempt', async() => {
    const operation = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(temporaryError())
      .mockRejectedValueOnce(temporaryError())
      .mockResolvedValueOnce(SUCCESS);

    const settled = withTransientRetry(operation, ZERO_RANDOM);
    await vi.runAllTimersAsync();

    await expect(settled).resolves.toBe(SUCCESS);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('never makes a fourth attempt and rethrows the last transient error', async() => {
    const lastError: ApiError = temporaryError();
    const operation = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(temporaryError())
      .mockRejectedValueOnce(temporaryError())
      .mockRejectedValueOnce(lastError)
      .mockResolvedValue(SUCCESS);

    const settled = withTransientRetry(operation, ZERO_RANDOM).catch((error: unknown): unknown => error);
    await vi.runAllTimersAsync();

    await expect(settled).resolves.toBe(lastError);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['the SDK window refusal', sdkRefusal(errorCodes.limitExceeded)],
    ['a cancelled call', sdkRefusal(errorCodes.cancelled)],
    ['a request too large', sdkRefusal(REQUEST_TOO_LARGE_CODE)],
    ['an UNKNOWN server fault', transportApiError({code: SDK_UNAVAILABLE_CODE, message: 'UNKNOWN', temporary: false})],
    ['a connection declaration the adapter owns', apiErrorOf(CONNECTION_NOT_INITED_TYPE, 400, {code: SDK_UNAVAILABLE_CODE, message: 'x', temporary: true})],
    ['an expired token the adapter owns', transportApiError({code: TOKEN_EXPIRED_CODE, message: 'expired', temporary: true})]
  ])('fails %s at once, without a retry', async(_label: string, failure: ApiError) => {
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(failure);

    const settled = withTransientRetry(operation, ZERO_RANDOM).catch((error: unknown): unknown => error);
    await vi.runAllTimersAsync();

    await expect(settled).resolves.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an SDK timeout', temporaryError()],
    ['a server temporary error', temporaryServerError()],
    ['an overloaded server', sdkRefusal(OVERLOADED_CODE)],
    ['a closed connection', sdkRefusal(errorCodes.connectionClosed)]
  ])('retries %s', async(_label: string, failure: ApiError) => {
    const operation = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(SUCCESS);

    const settled = withTransientRetry(operation, ZERO_RANDOM);
    await vi.runAllTimersAsync();

    await expect(settled).resolves.toBe(SUCCESS);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('backs off within 500 ms before the first retry and within 1 s before the second', async() => {
    const operation = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(temporaryError())
      .mockRejectedValueOnce(temporaryError())
      .mockResolvedValueOnce(SUCCESS);

    const settled = withTransientRetry(operation, HALF_RANDOM);

    await vi.advanceTimersByTimeAsync(FIRST_BACKOFF_MS / 2 - 1);
    expect(operation).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(operation).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(SECOND_BACKOFF_MS / 2 - 1);
    expect(operation).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(operation).toHaveBeenCalledTimes(3);
    await expect(settled).resolves.toBe(SUCCESS);
  });
});

describe('retryDelayMs follows the budget of the transient retry', () => {
  it('caps the backoff at 8 s', () => {
    expect(retryDelayMs(10, CEILING_RANDOM)).toBe(MAX_BACKOFF_MS);
  });
});

describe('invokeWithTransientRetry wraps only the media-lane file methods', () => {
  it('does not retry a regular method, which keeps its own retry policy', async() => {
    const failure: ApiError = temporaryError();
    const invoke = vi.fn<() => Promise<string>>().mockRejectedValueOnce(failure).mockResolvedValueOnce(SUCCESS);

    await expect(invokeWithTransientRetry(MESSAGES_GET_DIALOGS, invoke)).rejects.toBe(failure);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe('invokeWithTransientRetry retries a media-lane part through a stubbed SDK pool', () => {
  const fleetHarness = sharedFleetPoolHarness();
  const socketHarness = sharedUpdateSocketHarness();

  beforeEach(async() => {
    vi.useRealTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const {stopImpulseRealtime} = await import('@lib/impulse/realtime');
    stopImpulseRealtime(ACCOUNT);
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('completes a saveFilePart that the SDK answered with a temporary error once', async() => {
    fleetHarness.respondOnce(SAVE_FILE_PART, () => {
      throw {code: SDK_UNAVAILABLE_CODE, message: 'INTERNAL_SERVER_ERROR', temporary: true, appCode: 500, appType: 'INTERNAL_SERVER_ERROR'};
    });
    fleetHarness.respondOnce(SAVE_FILE_PART, () => ({
      data: toBinary(BoolResponseSchema, create(BoolResponseSchema, {value: true}))
    }));
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');

    const result = await invokeWithTransientRetry(SAVE_FILE_PART, (): Promise<unknown> => grpcInvoke(SAVE_FILE_PART, SAVE_FILE_PART_PARAMS, ACCOUNT));

    expect(result).toBe(true);
    expect(fleetHarness.calls.filter((call): boolean => call.method === SAVE_FILE_PART)).toHaveLength(2);
  });
});
