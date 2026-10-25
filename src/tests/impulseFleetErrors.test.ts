import {describe, expect, it} from 'vitest';
import {errorCodes} from '@impulsem/centrifuge/build/protobuf';

import {fleetApiError, isApiError} from '@lib/impulse/fleet/fleetError';
import type {FleetRpcError} from '@lib/impulse/fleet/fleetError';


const TEMPORARY_INTERNAL_ERROR: FleetRpcError = {
  code: 100,
  message: 'INTERNAL_SERVER_ERROR',
  appCode: 500,
  appType: 'INTERNAL_SERVER_ERROR'
};

const OVERLOADED: FleetRpcError = {
  code: 111,
  message: 'INTERNAL_SERVER_ERROR',
  appCode: 500,
  appType: 'INTERNAL_SERVER_ERROR'
};

const AUTH_TOKEN_INVALID: FleetRpcError = {
  code: 103,
  message: 'AUTH_TOKEN_INVALID',
  appCode: 400,
  appType: 'AUTH_TOKEN_INVALID'
};

const METHOD_INVALID: FleetRpcError = {
  code: 104,
  message: 'METHOD_INVALID',
  appCode: 400,
  appType: 'METHOD_INVALID'
};

const FLOOD_WAIT: FleetRpcError = {
  code: 107,
  message: 'FLOOD_WAIT_30',
  appCode: 420,
  appType: 'FLOOD_WAIT_30'
};

describe('a client-side fault of the pool is a transport fault for the caller', () => {
  it.each([
    ['a lost connection', {code: errorCodes.connectionClosed, message: 'connection closed'}],
    ['a closed transport', {code: errorCodes.transportClosed, message: 'transport closed'}],
    ['a failed write', {code: errorCodes.transportWriteError, message: 'write error'}],
    ['a client disconnected for good', {code: errorCodes.clientDisconnected, message: 'client disconnected'}],
    ['a closed pool', {code: errorCodes.clientClosed, message: 'rpc pool is closed'}],
    ['a deadline', {code: errorCodes.timeout, message: 'timeout'}],
    ['a misconfigured call', {code: errorCodes.badConfiguration, message: 'tokenFrom is exclusive'}]
  ])('maps %s to the typed NETWORK_BAD_RESPONSE', (_name: string, error: FleetRpcError) => {
    expect(
      fleetApiError(error),
      'a transport fault is a typed error for the caller\'s normal retry, never a free-text type'
    ).toMatchObject({type: 'NETWORK_BAD_RESPONSE', code: 500});
  });

  it('maps a cancelled call to CANCELED', () => {
    expect(fleetApiError({code: errorCodes.cancelled, message: 'cancelled'})).toMatchObject({type: 'CANCELED'});
  });

  it('keeps the numeric code of a cancelled call, so the call stays an API error for its caller', () => {
    expect(
      fleetApiError({code: errorCodes.cancelled, message: 'cancelled'}),
      'a CANCELED error without a numeric code is not an API error, and the adapter would rewrap it as a transport fault'
    ).toMatchObject({type: 'CANCELED', code: errorCodes.cancelled});
  });
});

describe('an application type the catalog does not publish is not taken as a catalog type', () => {
  it('maps it to UNKNOWN and keeps the raw type on the original error', () => {
    const apiError = fleetApiError({code: 100, message: 'NOT_IN_THE_CATALOG', appCode: 400, appType: 'NOT_IN_THE_CATALOG'});

    expect(apiError.type, 'a type the catalog does not publish must not reach the caller as a catalog type').toBe('UNKNOWN');
    expect((apiError.originalError as FleetRpcError).appType, 'the raw type stays on the original error').toBe('NOT_IN_THE_CATALOG');
  });
});

describe('a type the client raises itself is a catalog type', () => {
  it.each(['NETWORK_BAD_RESPONSE', 'CANCELED'])('keeps the client-only type %s unchanged', (type: string) => {
    const apiError = fleetApiError({code: 100, message: type, appCode: 500, appType: type});

    expect(apiError.type, 'a client-only type of ErrorType must reach the caller as itself, not as UNKNOWN').toBe(type);
  });
});

describe('an SDK connection report is not an API error', () => {
  it('takes an ErrorContext, which names a category and carries no numeric code, for no API error', () => {
    const context = {type: 'transport', error: new Error('transport closed')};

    expect(isApiError(context), 'an ErrorContext of the SDK is not an answer of the server').toBe(false);
  });
});

describe('an application error keeps the type and the code the server sent', () => {
  it('maps an error with an application type to that type and its application code', () => {
    const apiError = fleetApiError(FLOOD_WAIT);

    expect(apiError.type, 'the catalog type FLOOD_WAIT_30 must reach the caller unchanged').toBe('FLOOD_WAIT_30');
    expect(apiError.code, 'the canon numeric code is the application code, 420 for a flood wait').toBe(420);
  });

  it('keeps AUTH_TOKEN_INVALID as its catalog type', () => {
    expect(fleetApiError(AUTH_TOKEN_INVALID)).toMatchObject({type: 'AUTH_TOKEN_INVALID', code: 400});
  });

  it('keeps METHOD_INVALID as its catalog type', () => {
    expect(fleetApiError(METHOD_INVALID)).toMatchObject({type: 'METHOD_INVALID', code: 400});
  });

  it('maps the overloaded fleet to the registry\'s temporary INTERNAL_SERVER_ERROR 500', () => {
    expect(fleetApiError(OVERLOADED)).toMatchObject({type: 'INTERNAL_SERVER_ERROR', code: 500});
  });

  it('keeps the server error as the original error for diagnostics, with its raw code', () => {
    const apiError = fleetApiError(METHOD_INVALID);

    expect(apiError.originalError).toBe(METHOD_INVALID);
    expect((apiError.originalError as FleetRpcError).code).toBe(104);
  });

  it('carries the error-description metadata as the message', () => {
    const apiError = fleetApiError({
      code: 107,
      message: 'FLOOD_WAIT_30',
      appCode: 420,
      appType: 'FLOOD_WAIT_30',
      metadata: {'error-description': 'Too many requests, retry in 30 seconds'}
    });

    expect(apiError.message).toBe('Too many requests, retry in 30 seconds');
  });

  it('turns a migrate-dc answer into the 303 code of the migrate type, as the gRPC trailer path did', () => {
    const apiError = fleetApiError({
      code: 9,
      message: 'PHONE_MIGRATE_2',
      appCode: 400,
      appType: 'PHONE_MIGRATE_2',
      metadata: {'migrate-dc': '2'}
    });

    expect(apiError).toMatchObject({type: 'PHONE_MIGRATE_2', code: 303});
  });
});

describe('a refusal without an application type is the typed refusal of its code', () => {
  it.each([
    [103, 'AUTH_TOKEN_INVALID'],
    [104, 'METHOD_INVALID'],
    [109, 'AUTH_TOKEN_EXPIRED']
  ])('maps the refusal code %s to %s, with the canon code 400', (code: number, type: string) => {
    expect(
      fleetApiError({code, message: type}),
      'a refusal the transport reports is the typed refusal of its catalog type, never the 500 transport fault'
    ).toMatchObject({type, code: 400});
  });
});

describe('a fleet error without an application type is a typed transport error', () => {
  it('never takes the free text of the error as its catalog type', () => {
    expect(
      fleetApiError({code: errorCodes.badConfiguration, message: 'tokenFrom is exclusive'}).type,
      'free text is not a catalog type: the transport error is the typed NETWORK_BAD_RESPONSE'
    ).toBe('NETWORK_BAD_RESPONSE');
  });

  it('a refusal of the token the fleet sends without a type is a typed refusal, and keeps its raw code', () => {
    const refused: FleetRpcError = {code: 109, message: 'token expired'};
    const apiError = fleetApiError(refused);

    expect(
      apiError,
      'a refused token is the typed AUTH_TOKEN_EXPIRED refusal, never the transport fault of a 500'
    ).toMatchObject({type: 'AUTH_TOKEN_EXPIRED', code: 400});
    expect((apiError.originalError as FleetRpcError).code, 'the caller renews the session on the raw 109').toBe(109);
  });

  it('a temporary internal error is typed, so the caller can retry it normally', () => {
    expect(fleetApiError(TEMPORARY_INTERNAL_ERROR)).toMatchObject({type: 'INTERNAL_SERVER_ERROR', code: 500});
  });
});
