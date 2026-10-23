import {describe, expect, it} from 'vitest';
import {errorCodes} from '@impulsem/centrifuge/build/protobuf';

import {isMediaFleetFallback, toMediaFleetApiError} from '@lib/impulse/media/mediaFleetError';
import type {MediaFleetRpcError} from '@lib/impulse/media/mediaFleetError';


const TEMPORARY_INTERNAL_ERROR: MediaFleetRpcError = {
  code: 100,
  message: 'INTERNAL_SERVER_ERROR',
  temporary: true,
  appCode: 500,
  appType: 'INTERNAL_SERVER_ERROR'
};

const TOKEN_EXPIRED: MediaFleetRpcError = {code: 109, message: 'token expired', temporary: true};

const AUTH_TOKEN_INVALID: MediaFleetRpcError = {
  code: 103,
  message: 'AUTH_TOKEN_INVALID',
  appCode: 400,
  appType: 'AUTH_TOKEN_INVALID'
};

const METHOD_INVALID: MediaFleetRpcError = {
  code: 104,
  message: 'METHOD_INVALID',
  appCode: 400,
  appType: 'METHOD_INVALID'
};

const FLOOD_WAIT: MediaFleetRpcError = {
  code: 107,
  message: 'FLOOD_WAIT_30',
  appCode: 420,
  appType: 'FLOOD_WAIT_30'
};

describe('a media fleet failure falls back to the gateway only when the transport failed', () => {
  it.each([
    ['a temporary internal error', TEMPORARY_INTERNAL_ERROR],
    ['an expired token, which the SDK refreshes and resends', TOKEN_EXPIRED],
    ['a lost connection', {code: errorCodes.connectionClosed, message: 'connection closed'}],
    ['a closed transport', {code: errorCodes.transportClosed, message: 'transport closed'}],
    ['a failed write', {code: errorCodes.transportWriteError, message: 'write error'}],
    ['a client disconnected for good', {code: errorCodes.clientDisconnected, message: 'client disconnected'}],
    ['a call over the wait queue bound', {code: errorCodes.limitExceeded, message: 'limit'}],
    ['a deadline', {code: errorCodes.timeout, message: 'timeout'}]
  ])('falls back on %s', (_name: string, error: MediaFleetRpcError) => {
    expect(
      isMediaFleetFallback(error),
      'a transport fault must reach the gateway path, so the file call is not lost'
    ).toBe(true);
  });

  it.each([
    ['AUTH_TOKEN_INVALID', AUTH_TOKEN_INVALID],
    ['METHOD_INVALID', METHOD_INVALID],
    ['FLOOD_WAIT_30', FLOOD_WAIT]
  ])('does not fall back on %s: it is an answer', (_name: string, error: MediaFleetRpcError) => {
    expect(
      isMediaFleetFallback(error),
      'a protocol or application answer is an error for the caller, never a silent second send'
    ).toBe(false);
  });
});

describe('an application error keeps the type and the code the server sent', () => {
  it('maps an error with an application type to that type and its application code', () => {
    const apiError = toMediaFleetApiError(FLOOD_WAIT);

    expect(
      apiError.type,
      'the catalog type FLOOD_WAIT_30 must reach the caller the way the gRPC trailer error-code does'
    ).toBe('FLOOD_WAIT_30');
    expect(apiError.code, 'the canon numeric code is the application code, 420 for a flood wait').toBe(420);
  });

  it('keeps AUTH_TOKEN_INVALID as its catalog type', () => {
    const apiError = toMediaFleetApiError(AUTH_TOKEN_INVALID);

    expect(apiError.type).toBe('AUTH_TOKEN_INVALID');
    expect(apiError.code).toBe(400);
  });

  it('keeps the server error as the original error for diagnostics', () => {
    expect(toMediaFleetApiError(METHOD_INVALID).originalError).toBe(METHOD_INVALID);
  });
});
