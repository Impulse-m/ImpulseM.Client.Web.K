import {describe, expect, it} from 'vitest';
import {errorCodes} from '@impulsem/centrifuge/build/protobuf';

import {isMediaFleetFallback, mediaFleetApiError} from '@lib/impulse/media/mediaFleetError';
import type {MediaFleetRpcError} from '@lib/impulse/media/mediaFleetError';


const TEMPORARY_INTERNAL_ERROR: MediaFleetRpcError = {
  code: 100,
  message: 'INTERNAL_SERVER_ERROR',
  appCode: 500,
  appType: 'INTERNAL_SERVER_ERROR'
};

const OVERLOADED: MediaFleetRpcError = {
  code: 111,
  message: 'INTERNAL_SERVER_ERROR',
  appCode: 500,
  appType: 'INTERNAL_SERVER_ERROR'
};

const TOKEN_EXPIRED: MediaFleetRpcError = {code: 109, message: 'token expired'};

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
    ['a lost connection', {code: errorCodes.connectionClosed, message: 'connection closed'}],
    ['a closed transport', {code: errorCodes.transportClosed, message: 'transport closed'}],
    ['a failed write', {code: errorCodes.transportWriteError, message: 'write error'}],
    ['a client disconnected for good', {code: errorCodes.clientDisconnected, message: 'client disconnected'}],
    ['a closed pool, torn down by logout or a new option', {code: errorCodes.clientClosed, message: 'rpc pool is closed'}],
    ['a deadline', {code: errorCodes.timeout, message: 'timeout'}]
  ])('falls back on %s', (_name: string, error: MediaFleetRpcError) => {
    expect(
      isMediaFleetFallback(error),
      'a transport fault must reach the gateway path, so the file call is not lost'
    ).toBe(true);
  });

  it.each([
    ['a temporary internal error', TEMPORARY_INTERNAL_ERROR],
    ['an expired token, which is renewed and never resent over gRPC-web', TOKEN_EXPIRED],
    ['a call over the wait queue bound, which waits for a slot', {code: errorCodes.limitExceeded, message: 'limit'}],
    ['AUTH_TOKEN_INVALID', AUTH_TOKEN_INVALID],
    ['METHOD_INVALID', METHOD_INVALID],
    ['FLOOD_WAIT_30', FLOOD_WAIT]
  ])('does not fall back on %s: it is an answer or a wait', (_name: string, error: MediaFleetRpcError) => {
    expect(
      isMediaFleetFallback(error),
      'a server answer or a full queue is an error or a wait for the caller, never a silent second send over gRPC-web'
    ).toBe(false);
  });
});

describe('an application error keeps the type and the code the server sent', () => {
  it('maps an error with an application type to that type and its application code', () => {
    const apiError = mediaFleetApiError(FLOOD_WAIT);

    expect(
      apiError.type,
      'the catalog type FLOOD_WAIT_30 must reach the caller the way the gRPC trailer error-code does'
    ).toBe('FLOOD_WAIT_30');
    expect(apiError.code, 'the canon numeric code is the application code, 420 for a flood wait').toBe(420);
  });

  it('keeps AUTH_TOKEN_INVALID as its catalog type', () => {
    const apiError = mediaFleetApiError(AUTH_TOKEN_INVALID);

    expect(apiError.type).toBe('AUTH_TOKEN_INVALID');
    expect(apiError.code).toBe(400);
  });

  it('maps the overloaded fleet to the registry\'s temporary INTERNAL_SERVER_ERROR 500', () => {
    const apiError = mediaFleetApiError(OVERLOADED);

    expect(apiError.type).toBe('INTERNAL_SERVER_ERROR');
    expect(apiError.code).toBe(500);
  });

  it('keeps the server error as the original error for diagnostics', () => {
    expect(mediaFleetApiError(METHOD_INVALID).originalError).toBe(METHOD_INVALID);
  });
});

describe('a fleet error without an application type is a typed transport error', () => {
  it('never takes the free text of the error as its catalog type', () => {
    const apiError = mediaFleetApiError({code: errorCodes.badConfiguration, message: 'tokenFrom is exclusive'});

    expect(
      apiError.type,
      'free text is not a catalog type: the transport error is the typed NETWORK_BAD_RESPONSE'
    ).toBe('NETWORK_BAD_RESPONSE');
    expect(apiError.code).toBe(500);
  });

  it('a token the fleet refused without a type is a typed transport error too', () => {
    expect(mediaFleetApiError(TOKEN_EXPIRED).type).toBe('NETWORK_BAD_RESPONSE');
  });
});
