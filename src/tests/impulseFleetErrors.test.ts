import {describe, expect, it} from 'vitest';
import {errorCodes} from '@impulsem/centrifuge/build/protobuf';

import {fleetApiError} from '@lib/impulse/fleet/fleetError';
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

describe('a fleet error without an application type is a typed transport error', () => {
  it('never takes the free text of the error as its catalog type', () => {
    expect(
      fleetApiError({code: errorCodes.badConfiguration, message: 'tokenFrom is exclusive'}).type,
      'free text is not a catalog type: the transport error is the typed NETWORK_BAD_RESPONSE'
    ).toBe('NETWORK_BAD_RESPONSE');
  });

  it('a token the fleet refused without a type is a typed transport error too, and keeps its raw code', () => {
    const refused: FleetRpcError = {code: 109, message: 'token expired'};
    const apiError = fleetApiError(refused);

    expect(apiError).toMatchObject({type: 'NETWORK_BAD_RESPONSE', code: 500});
    expect((apiError.originalError as FleetRpcError).code, 'the caller renews the session on the raw 109').toBe(109);
  });

  it('a temporary internal error is typed, so the caller can retry it normally', () => {
    expect(fleetApiError(TEMPORARY_INTERNAL_ERROR)).toMatchObject({type: 'INTERNAL_SERVER_ERROR', code: 500});
  });
});
