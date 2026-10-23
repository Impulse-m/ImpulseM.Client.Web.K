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
import {TOKEN_EXPIRED_CODE} from '@lib/impulse/centrifugoCodes';
import {getGrpcSessionToken} from '@lib/impulse/grpc/transport';
import {refreshImpulseSession, whenImpulseSessionReady} from '@lib/impulse/session';
import {isMediaFleetFallback, mediaFleetApiError, transportApiError} from './mediaFleetError';
import type {MediaFleetRpcError} from './mediaFleetError';
import {mediaFleetEndpointOf, routesToMediaFleet} from './mediaFleetRoute';
import type {MediaFleetConfig} from './mediaFleetRoute';

const logger = getLogger('media-fleet');

// @impulsem/centrifuge 1.6.0's protobuf entry declares no RpcPool (build/protobuf/index.d.ts exports the codes and
// the protobuf client only), though its runtime exports it. This is the subset of the pool the client uses.
type MediaFleetPoolOptions = {
  endpoints: (endpointKey: string) => string[],
  connection: {getToken: () => Promise<string>, timeout: number},
  maxConnectionsPerEndpoint: number,
  maxInflightPerConnection: number
};

type MediaFleetReply = {data?: Uint8Array};

type MediaFleetPool = {
  rpc(method: string, data: Uint8Array, options: {signal?: AbortSignal}): Promise<MediaFleetReply>,
  close(): void
};

type MediaFleetRpcPoolConstructor = new (options: MediaFleetPoolOptions) => MediaFleetPool;

type MediaFleetEntry = {
  pool: MediaFleetPool,
  // Calls held back while the pool's queue is full; each one wakes when any call of the pool settles.
  slotWaiters: Array<() => void>
};

export type MediaFleetCounters = {served: number, fallbacks: number};

const RpcPool: MediaFleetRpcPoolConstructor = (centrifugeProtobuf as unknown as {
  RpcPool: MediaFleetRpcPoolConstructor
}).RpcPool;

// The registry's timeout for the four methods (deploy/centrifugo/media/registry.json).
const CALL_TIMEOUT_MS: number = 10_000;
const CONNECTIONS_PER_ENDPOINT: number = 2;
// A window above 1 needs client.concurrency >= window + 1 on the server (deploy/centrifugo/media/config.json: 3).
const CALLS_IN_FLIGHT_PER_CONNECTION: number = 2;
const AUTH_TOKEN_INVALID_CODE: number = 103;
const METHOD_INVALID_CODE: number = 104;
const SIGNED_OUT_MESSAGE: string = 'Impulse session is signed out';
const REFRESH_FAILED_MESSAGE: string = 'Impulse session refresh failed; the media fleet connection retries';

const entryByAccount = new Map<ActiveAccountNumber, MediaFleetEntry>();
const lastHandedTokenByAccount = new Map<ActiveAccountNumber, string>();
const countersByAccount = new Map<ActiveAccountNumber, MediaFleetCounters>();

export function setMediaFleetConfig(accountNumber: ActiveAccountNumber, config: MediaFleetConfig): void {
  tearDownMediaFleet(accountNumber);

  const endpoint = mediaFleetEndpointOf(config);
  if(endpoint === undefined) {
    return;
  }

  entryByAccount.set(accountNumber, {pool: createPool(accountNumber, endpoint), slotWaiters: []});
}

export function hasMediaFleetPool(accountNumber: ActiveAccountNumber): boolean {
  return entryByAccount.has(accountNumber);
}

export function tearDownMediaFleet(accountNumber: ActiveAccountNumber): void {
  lastHandedTokenByAccount.delete(accountNumber);

  const entry = entryByAccount.get(accountNumber);
  if(!entry) {
    return;
  }

  entryByAccount.delete(accountNumber);
  entry.pool.close();
}

export function mediaFleetCounters(accountNumber: ActiveAccountNumber): MediaFleetCounters {
  return {...countersOf(accountNumber)};
}

/** Resolves undefined where the gateway must answer: no media option, another method, or a transport fault. */
export async function callMediaFleet(
  accountNumber: ActiveAccountNumber,
  method: string,
  requestBytes: Uint8Array,
  signal?: AbortSignal
): Promise<Uint8Array | undefined> {
  const entry = entryByAccount.get(accountNumber);
  if(!entry || !routesToMediaFleet(method)) {
    return undefined;
  }

  let reply: MediaFleetReply;
  try {
    reply = await sendWhenSlotFree(entry, method, requestBytes, signal);
  } catch(err: unknown) {
    return rejectOrFallBack(accountNumber, method, err);
  }

  if(reply.data === undefined) {
    throw transportApiError(reply);
  }

  countersOf(accountNumber).served++;
  return reply.data;
}

/** The session access token the fleet connections present: renewed when the SDK asks again for the one it holds. */
export async function mediaFleetAccessToken(accountNumber: ActiveAccountNumber): Promise<string> {
  await whenImpulseSessionReady(accountNumber);

  const current = getGrpcSessionToken(accountNumber);
  if(current === undefined) {
    throw new centrifugeProtobuf.UnauthorizedError(SIGNED_OUT_MESSAGE);
  }

  // The SDK asks for a token again only after the fleet refused the one it presented, or when that token is due
  // for its connection refresh. Handing the same token out again would present the refused one, so it is renewed.
  if(current !== lastHandedTokenByAccount.get(accountNumber)) {
    lastHandedTokenByAccount.set(accountNumber, current);
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

  lastHandedTokenByAccount.set(accountNumber, renewed);
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

// The pool answers limitExceeded while its queue is full. The queue drains as its calls settle, so the call waits
// for the next settled call of its pool and is sent again: a full queue is never an answer from the gateway.
async function sendWhenSlotFree(
  entry: MediaFleetEntry,
  method: string,
  requestBytes: Uint8Array,
  signal?: AbortSignal
): Promise<MediaFleetReply> {
  for(;;) {
    try {
      return await sendOnce(entry, method, requestBytes, signal);
    } catch(err: unknown) {
      if((err as MediaFleetRpcError).code !== centrifugeProtobuf.errorCodes.limitExceeded) {
        throw err;
      }

      await waitForSettledCall(entry, signal);
    }
  }
}

async function sendOnce(
  entry: MediaFleetEntry,
  method: string,
  requestBytes: Uint8Array,
  signal?: AbortSignal
): Promise<MediaFleetReply> {
  try {
    return await entry.pool.rpc(method, requestBytes, {signal});
  } finally {
    for(const wake of entry.slotWaiters.splice(0)) {
      wake();
    }
  }
}

// An abort wakes the waiter as well: the retry then carries the aborted signal and the pool settles it as cancelled.
function waitForSettledCall(entry: MediaFleetEntry, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve: () => void): void => {
    if(signal?.aborted === true) {
      resolve();
      return;
    }

    const wake = (): void => {
      signal?.removeEventListener('abort', wake);
      resolve();
    };

    entry.slotWaiters.push(wake);
    signal?.addEventListener('abort', wake, {once: true});
  });
}

async function rejectOrFallBack(accountNumber: ActiveAccountNumber, method: string, err: unknown): Promise<undefined> {
  const error = err as MediaFleetRpcError;
  if(error.code === centrifugeProtobuf.errorCodes.cancelled) {
    const cancelled: ApiError = {type: 'CANCELED', originalError: error};
    throw cancelled;
  }

  if(isMediaFleetFallback(error)) {
    countersOf(accountNumber).fallbacks++;
    logger.warn('Media fleet call falls back to the gateway', {method, accountNumber, code: error.code}, error);
    return undefined;
  }

  if(error.code === TOKEN_EXPIRED_CODE) {
    const renewed = await refreshImpulseSession(accountNumber);
    logger.info('Media fleet refused the access token', {method, accountNumber, renewed});
  }

  if(error.code === AUTH_TOKEN_INVALID_CODE || error.code === METHOD_INVALID_CODE) {
    logger.warn('Media fleet refused a call', {method, accountNumber, code: error.code, appType: error.appType}, error);
  }

  throw mediaFleetApiError(error);
}

function countersOf(accountNumber: ActiveAccountNumber): MediaFleetCounters {
  let counters = countersByAccount.get(accountNumber);
  if(!counters) {
    counters = {served: 0, fallbacks: 0};
    countersByAccount.set(accountNumber, counters);
  }

  return counters;
}
