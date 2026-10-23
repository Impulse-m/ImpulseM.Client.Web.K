/*
 * File transfer over the media fleet: one pool of protobuf Centrifugo connections per account slot, built
 * from the media_only dcOption of the current DC and rebuilt on every new help.getConfig generation.
 *
 * The pool carries only the four registry calls (mediaFleetRoute.ts). Its connections authenticate with
 * the Auth access token the gRPC-web calls carry, and subscribe to nothing.
 */

import * as centrifugeProtobuf from '@impulsem/centrifuge/build/protobuf';

import type {ActiveAccountNumber} from '@lib/accounts/types';
import {getLogger} from '@lib/impulseLogger';
import {getGrpcSessionToken} from '@lib/impulse/grpc/transport';
import {refreshImpulseSession, whenImpulseSessionReady} from '@lib/impulse/session';
import {isMediaFleetFallback, toMediaFleetApiError} from './mediaFleetError';
import type {MediaFleetRpcError} from './mediaFleetError';
import {mediaFleetEndpointOf, routesToMediaFleet} from './mediaFleetRoute';
import type {MediaFleetConfig} from './mediaFleetRoute';

const logger = getLogger('media-fleet');

// The protobuf entry's declaration file of @impulsem/centrifuge 1.6.0 omits RpcPool, which the runtime exports
// (build/protobuf/index.mjs). This is the subset of it the client uses.
type MediaFleetPoolOptions = {
  endpoints: (endpointKey: string) => string[],
  connection: {getToken: () => Promise<string>, timeout: number},
  maxConnectionsPerEndpoint: number,
  maxInflightPerConnection: number
};

type MediaFleetReply = {data: Uint8Array, cached?: boolean};

type MediaFleetPool = {
  rpc(method: string, data: Uint8Array, options: {signal?: AbortSignal}): Promise<MediaFleetReply>,
  close(): void
};

type RpcPoolConstructor = new (options: MediaFleetPoolOptions) => MediaFleetPool;

const RpcPool: RpcPoolConstructor = (centrifugeProtobuf as unknown as {RpcPool: RpcPoolConstructor}).RpcPool;

// The registry's timeout for the four methods (deploy/centrifugo/media/registry.json).
const CALL_TIMEOUT_MS: number = 10_000;
const CONNECTIONS_PER_ENDPOINT: number = 2;
// A window above 1 needs client.concurrency >= window + 1 on the server (deploy/centrifugo/media/config.json: 3).
const CALLS_IN_FLIGHT_PER_CONNECTION: number = 2;
const TOKEN_RENEWAL_LEAD_MS: number = 60_000;
const MS_PER_SECOND: number = 1_000;
const BASE64_QUARTET: number = 4;
const SIGNED_OUT_MESSAGE: string = 'Impulse session is signed out';
const REFRESH_FAILED_MESSAGE: string = 'Impulse session refresh failed; the media fleet connection retries';
const CANCELLED_TYPE: string = 'CANCELED';
const AUTH_TOKEN_INVALID_CODE: number = 103;
const METHOD_INVALID_CODE: number = 104;
const CANCELLED_API_ERROR_CODE: number = 499;

const poolByAccount = new Map<ActiveAccountNumber, MediaFleetPool>();

export function setMediaFleetConfig(accountNumber: ActiveAccountNumber, config: MediaFleetConfig): void {
  tearDownMediaFleet(accountNumber);

  const endpoint = mediaFleetEndpointOf(config);
  if(endpoint === undefined) {
    return;
  }

  poolByAccount.set(accountNumber, createPool(accountNumber, endpoint));
}

export function hasMediaFleetPool(accountNumber: ActiveAccountNumber): boolean {
  return poolByAccount.has(accountNumber);
}

export function tearDownMediaFleet(accountNumber: ActiveAccountNumber): void {
  const pool = poolByAccount.get(accountNumber);
  if(!pool) {
    return;
  }

  poolByAccount.delete(accountNumber);
  pool.close();
}

/** Resolves undefined where the gateway must answer: no media option, another method, or a transport fault. */
export async function callMediaFleet(
  accountNumber: ActiveAccountNumber,
  method: string,
  requestBytes: Uint8Array,
  signal?: AbortSignal
): Promise<Uint8Array | undefined> {
  const pool = poolByAccount.get(accountNumber);
  if(!pool || !routesToMediaFleet(method)) {
    return undefined;
  }

  try {
    const reply = await pool.rpc(method, requestBytes, {signal});
    // An empty response message encodes to no bytes, which the SDK hands back as no data.
    return reply.data ?? new Uint8Array(0);
  } catch(err: unknown) {
    const error = err as MediaFleetRpcError;
    if(error.code === centrifugeProtobuf.errorCodes.cancelled) {
      const cancelled: ApiError = {type: CANCELLED_TYPE as ErrorType, code: CANCELLED_API_ERROR_CODE, originalError: error};
      throw cancelled;
    }

    if(isMediaFleetFallback(error)) {
      logger.warn('Media fleet call falls back to the gateway', {method, accountNumber, code: error.code}, error);
      return undefined;
    }

    if(error.code === AUTH_TOKEN_INVALID_CODE || error.code === METHOD_INVALID_CODE) {
      logger.warn('Media fleet refused a call', {method, accountNumber, code: error.code, appType: error.appType}, error);
    }

    throw toMediaFleetApiError(error);
  }
}

/** The session access token the gRPC-web calls carry, renewed through the session before it expires. */
export async function mediaFleetAccessToken(accountNumber: ActiveAccountNumber): Promise<string> {
  await whenImpulseSessionReady(accountNumber);

  const current = getGrpcSessionToken(accountNumber);
  if(current === undefined) {
    throw new centrifugeProtobuf.UnauthorizedError(SIGNED_OUT_MESSAGE);
  }

  if(accessTokenExpiresAtMs(current) - Date.now() > TOKEN_RENEWAL_LEAD_MS) {
    return current;
  }

  const refreshed = await refreshImpulseSession(accountNumber);
  if(!refreshed) {
    throw new Error(REFRESH_FAILED_MESSAGE);
  }

  const renewed = getGrpcSessionToken(accountNumber);
  if(renewed === undefined) {
    throw new centrifugeProtobuf.UnauthorizedError(SIGNED_OUT_MESSAGE);
  }

  return renewed;
}

function createPool(accountNumber: ActiveAccountNumber, endpoint: string): MediaFleetPool {
  return new RpcPool({
    endpoints: (): string[] => [endpoint],
    connection: {
      getToken: (): Promise<string> => mediaFleetAccessToken(accountNumber),
      timeout: CALL_TIMEOUT_MS
    },
    maxConnectionsPerEndpoint: CONNECTIONS_PER_ENDPOINT,
    maxInflightPerConnection: CALLS_IN_FLIGHT_PER_CONNECTION
  });
}

function accessTokenExpiresAtMs(token: string): number {
  const payload = JSON.parse(decodeBase64Url(token.split('.')[1] ?? '')) as {exp?: unknown};
  if(typeof payload.exp !== 'number') {
    throw new Error('Impulse access token carries no exp claim');
  }

  return payload.exp * MS_PER_SECOND;
}

function decodeBase64Url(segment: string): string {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (BASE64_QUARTET - (base64.length % BASE64_QUARTET)) % BASE64_QUARTET;
  return atob(base64 + '='.repeat(padding));
}
