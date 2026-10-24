import {errorCodes} from '@impulsem/centrifuge/build/protobuf';

import type {ActiveAccountNumber} from '@lib/accounts/types';
import {getLogger} from '@lib/impulseLogger';
import {isTokenRefusalCode, METHOD_INVALID_CODE} from '@lib/impulse/centrifugoCodes';
import {apiErrorOf, fleetApiError, isFleetRpcError, replyDataOf, transportApiError} from './fleetError';
import {FleetLane} from './fleetLane';
import type {FleetKind, FleetPoolReply} from './fleetLane';
import {poolRpcEndpoint, mediaEndpointOf, routesToMediaFleet} from './fleetRoute';
import type {FleetConfig} from './fleetRoute';

const logger = getLogger('fleet');

// The registry's timeout for the four file-transfer calls (deploy/centrifugo/media/registry.json).
const MEDIA_CALL_TIMEOUT_MS: number = 10_000;
const POOL_CALL_TIMEOUT_MS: number = 30_000;
// Calls in flight per connection: the media registry needs client.concurrency >= window + 1 on the server
// (deploy/centrifugo/media/config.json: 3).
const MEDIA_INFLIGHT_PER_CONNECTION: number = 2;
const MEDIA_CONNECTIONS_PER_ENDPOINT: number = 2;
const POOL_INFLIGHT_PER_CONNECTION: number = 1;
const POOL_CONNECTIONS_PER_ENDPOINT: number = 1;
// The calls a pool holds waiting for one of its slots, beyond which the pool refuses at once (the SDK's default).
const MAX_QUEUED_CALLS_PER_POOL: number = 64;
const INTERNAL_ERROR_CODE: number = 500;

export type FleetIdentity = {
  kind: 'identity' | 'session',
  // Lanes are kept per key: two identities never share connections.
  key: string,
  getToken: () => Promise<string>,
  // Called when the server refuses the token this identity presents, so the next connection asks for a renewed one.
  onRefused?: (error?: ApiError) => void
};

export type FleetCall = {
  accountNumber: ActiveAccountNumber,
  method: string,
  request: Uint8Array,
  signal?: AbortSignal
};

type FleetIdentitySource = (accountNumber: ActiveAccountNumber) => FleetIdentity;

export type FleetCounters = {media: number, socket: number};

type AccountFleet = {
  mediaEndpoint: string | undefined,
  configPublished: boolean,
  configWaiters: Array<() => void>,
  lanes: Map<string, FleetLane>,
  counters: FleetCounters,
  identityMoves: number
};

type LaneTarget = {
  kind: FleetKind,
  endpoint: string
};

const fleetByAccount = new Map<ActiveAccountNumber, AccountFleet>();
let identitySource: FleetIdentitySource | undefined;

/** Registers the function that names the identity a slot presents now. */
export function setFleetIdentitySource(source: FleetIdentitySource): void {
  identitySource = source;
}

export function fleetIdentityOf(accountNumber: ActiveAccountNumber): FleetIdentity {
  if(identitySource === undefined) {
    throw apiErrorOf('FLEET_IDENTITY_UNREGISTERED', INTERNAL_ERROR_CODE, undefined, 'No fleet identity source is registered');
  }

  return identitySource(accountNumber);
}

function fleetOf(accountNumber: ActiveAccountNumber): AccountFleet {
  let fleet = fleetByAccount.get(accountNumber);
  if(!fleet) {
    fleet = {
      mediaEndpoint: undefined,
      configPublished: false,
      configWaiters: [],
      lanes: new Map<string, FleetLane>(),
      counters: {media: 0, socket: 0},
      identityMoves: 0
    };
    fleetByAccount.set(accountNumber, fleet);
  }

  return fleet;
}

/**
 * Publishes the config of an account, the event a file-transfer call waits for. A media lane on an endpoint that changed
 * is retired.
 */
export function setFleetConfig(accountNumber: ActiveAccountNumber, config: FleetConfig): void {
  const fleet = fleetOf(accountNumber);
  fleet.mediaEndpoint = mediaEndpointOf(config);
  fleet.configPublished = true;

  for(const lane of [...fleet.lanes.values()]) {
    if(lane.kind === 'media' && lane.endpoint !== fleet.mediaEndpoint) {
      retireLane(fleet, lane);
    }
  }

  for(const wake of fleet.configWaiters.splice(0)) {
    wake();
  }
}

/** Retires every lane of an account: its connections drain their calls in flight and close. Used on every identity change. */
export function resetFleetIdentity(accountNumber: ActiveAccountNumber): void {
  const fleet: AccountFleet = fleetOf(accountNumber);
  fleet.identityMoves++;

  for(const lane of [...fleet.lanes.values()]) {
    retireLane(fleet, lane);
  }
}

/** The calls each carrier has answered for an account. */
export function fleetCounters(accountNumber: ActiveAccountNumber): FleetCounters {
  return {...fleetOf(accountNumber).counters};
}

/** The file-transfer calls of an account that wait for its config to publish a media option. */
export function fleetConfigWaiters(accountNumber: ActiveAccountNumber): number {
  return fleetOf(accountNumber).configWaiters.length;
}

export function fleetIdentityMoves(accountNumber: ActiveAccountNumber): number {
  return fleetOf(accountNumber).identityMoves;
}

/** Counts one call answered by the update socket of the account. */
export function countSocketCall(accountNumber: ActiveAccountNumber): void {
  fleetOf(accountNumber).counters.socket++;
}

/**
 * Sends one file-transfer call on the media fleet, under the identity the slot presents when the call is sent. A call issued
 * before the config publishes waits for it. Rejects with an ApiError.
 */
export function callMediaFleet(call: FleetCall): Promise<Uint8Array> {
  const fleet = fleetOf(call.accountNumber);
  if(fleet.configPublished) {
    return sendMediaCall(fleet, call);
  }

  return whenConfigPublished(fleet, call.signal).then((): Promise<Uint8Array> => sendMediaCall(fleet, call));
}

async function sendMediaCall(fleet: AccountFleet, call: FleetCall): Promise<Uint8Array> {
  if(fleet.mediaEndpoint === undefined) {
    throw transportApiError(new Error(`${call.method} has no media_only dcOption in the published config to travel`));
  }

  const reply = await sendOnLane(
    fleet,
    {kind: 'media', endpoint: fleet.mediaEndpoint},
    fleetIdentityOf(call.accountNumber),
    call.method,
    call.request,
    call.signal
  );
  fleet.counters.media++;
  return reply;
}

function whenConfigPublished(fleet: AccountFleet, signal?: AbortSignal): Promise<void> {
  if(fleet.configPublished) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve: () => void, reject: (reason: ApiError) => void): void => {
    const cancelled: ApiError = apiErrorOf('CANCELED', errorCodes.cancelled, signal?.reason);
    if(signal?.aborted) {
      reject(cancelled);
      return;
    }

    const onPublished = (): void => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = (): void => {
      fleet.configWaiters.splice(fleet.configWaiters.indexOf(onPublished), 1);
      reject(cancelled);
    };

    fleet.configWaiters.push(onPublished);
    signal?.addEventListener('abort', onAbort, {once: true});
  });
}

export function callPool(call: FleetCall): Promise<Uint8Array> {
  return sendOnLane(
    fleetOf(call.accountNumber),
    {kind: 'pool', endpoint: poolRpcEndpoint()},
    undefined,
    call.method,
    call.request,
    call.signal
  );
}

async function sendOnLane(
  fleet: AccountFleet,
  target: LaneTarget,
  identity: FleetIdentity | undefined,
  method: string,
  request: Uint8Array,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const lane = laneFor(fleet, target, identity);
  let reply: FleetPoolReply;
  try {
    reply = await lane.send(method, request, signal);
  } catch(err: unknown) {
    throw failureOf(fleet, lane, method, identity, err);
  }

  return replyDataOf(reply);
}

function laneFor(fleet: AccountFleet, target: LaneTarget, identity: FleetIdentity | undefined): FleetLane {
  const key = `${target.kind}|${target.endpoint}|${identity?.key ?? 'pool'}`;
  let lane = fleet.lanes.get(key);
  if(!lane) {
    // A media connection presents its slot's identity: once the identity moves on, the lanes of the old one are retired.
    if(target.kind === 'media') {
      for(const stale of [...fleet.lanes.values()]) {
        if(stale.kind === 'media' && stale.identityKey !== identity?.key) {
          retireLane(fleet, stale);
        }
      }
    }

    const isMedia: boolean = target.kind === 'media';
    lane = new FleetLane({
      key,
      identityKey: identity?.key ?? 'pool',
      kind: target.kind,
      endpoint: target.endpoint,
      timeoutMs: isMedia ? MEDIA_CALL_TIMEOUT_MS : POOL_CALL_TIMEOUT_MS,
      connectionsPerEndpoint: isMedia ? MEDIA_CONNECTIONS_PER_ENDPOINT : POOL_CONNECTIONS_PER_ENDPOINT,
      inflightPerConnection: isMedia ? MEDIA_INFLIGHT_PER_CONNECTION : POOL_INFLIGHT_PER_CONNECTION,
      queuedCalls: MAX_QUEUED_CALLS_PER_POOL,
      getToken: identity?.getToken
    });
    fleet.lanes.set(key, lane);
  }

  return lane;
}

function retireLane(fleet: AccountFleet, lane: FleetLane): void {
  if(fleet.lanes.get(lane.key) === lane) {
    fleet.lanes.delete(lane.key);
  }

  lane.retire();
}

// A refused token ends the lane that presented it: its connections must not keep the refused token, and the next call
// connects again with the token the identity hands out then.
function failureOf(fleet: AccountFleet, lane: FleetLane, method: string, identity: FleetIdentity | undefined, err: unknown): ApiError {
  const error: ApiError = fleetFailure(method, err, identity);
  if(error.type === 'AUTH_KEY_UNREGISTERED' || (isFleetRpcError(err) && isTokenRefusalCode(err.code))) {
    retireLane(fleet, lane);
    identity?.onRefused?.(error);
    logger.warn('Fleet refused the token of a call', {method, code: error.code, identity: identity?.kind});
  }

  return error;
}

/** The one mapping of a rejection of any carrier to the ApiError the caller sees; a method the registry lacks is traced. */
export function fleetFailure(method: string, err: unknown, identity?: FleetIdentity): ApiError {
  if(isFleetRpcError(err) && err.code === METHOD_INVALID_CODE) {
    logger.warn('Fleet registry lacks the method', {method, code: err.code});
  }

  const error: ApiError = isFleetRpcError(err) ? fleetApiError(err) : transportApiError(err);
  if(identity) {
    error.socketKind = identity.kind;
    error.socketKey = identity.key;
  }
  return error;
}
