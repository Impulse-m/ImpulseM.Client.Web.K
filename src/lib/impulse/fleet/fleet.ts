/*
 * The Centrifugo pools of the client, per account slot: the media fleet, which carries the four file-transfer calls on its
 * own connections under the identity of the slot, and the anonymous pool of the session refresh. The refresh renews the
 * token the update socket waits for, so it cannot travel the update socket. Every other call is an rpc on the update
 * socket (realtime.ts).
 *
 * A lane is a pool of protobuf connections for one endpoint and one identity. A lane of a withdrawn endpoint, or of an
 * identity the slot no longer holds, is retired: its connections drain the calls in flight and then close.
 */

import type {ActiveAccountNumber} from '@lib/accounts/types';
import {getLogger} from '@lib/impulseLogger';
import {TOKEN_EXPIRED_CODE} from '@lib/impulse/centrifugoCodes';
import {fleetApiError, transportApiError} from './fleetError';
import type {FleetRpcError} from './fleetError';
import {FleetLane, FleetLaneRetiredError} from './fleetLane';
import type {FleetKind, FleetPoolReply} from './fleetLane';
import {defaultRpcEndpoint, mediaEndpointOf, routesToMediaFleet} from './fleetRoute';
import type {FleetConfig} from './fleetRoute';

const logger = getLogger('fleet');

// The registry's timeout for the four file-transfer calls (deploy/centrifugo/media/registry.json).
const MEDIA_CALL_TIMEOUT_MS: number = 10_000;
const REFRESH_CALL_TIMEOUT_MS: number = 30_000;
// Calls in flight per connection: the media registry needs client.concurrency >= window + 1 on the server
// (deploy/centrifugo/media/config.json: 3).
const MEDIA_INFLIGHT_PER_CONNECTION: number = 2;
const MEDIA_CONNECTIONS_PER_ENDPOINT: number = 2;
const REFRESH_INFLIGHT_PER_CONNECTION: number = 1;
const REFRESH_CONNECTIONS_PER_ENDPOINT: number = 1;
const AUTH_TOKEN_INVALID_CODE: number = 103;
const METHOD_INVALID_CODE: number = 104;

export type FleetIdentity = {
  kind: 'anonymous' | 'session' | 'pending',
  // Lanes are kept per key: two identities never share connections.
  key: string,
  getToken: (() => Promise<string>) | undefined
};

export type FleetCall = {
  accountNumber: ActiveAccountNumber,
  method: string,
  identity: FleetIdentity,
  request: Uint8Array,
  signal?: AbortSignal
};

export type FleetCounters = {media: number, socket: number};

type AccountFleet = {
  mediaEndpoint: string | undefined,
  lanes: Map<string, FleetLane>,
  counters: FleetCounters
};

type LaneTarget = {
  kind: FleetKind,
  endpoint: string
};

export const ANONYMOUS_IDENTITY: FleetIdentity = {kind: 'anonymous', key: 'anonymous', getToken: undefined};

const fleetByAccount = new Map<ActiveAccountNumber, AccountFleet>();

function fleetOf(accountNumber: ActiveAccountNumber): AccountFleet {
  let fleet = fleetByAccount.get(accountNumber);
  if(!fleet) {
    fleet = {mediaEndpoint: undefined, lanes: new Map<string, FleetLane>(), counters: {media: 0, socket: 0}};
    fleetByAccount.set(accountNumber, fleet);
  }

  return fleet;
}

/** Publishes the media endpoint of an account's config. A media lane on an endpoint that changed is retired. */
export function setFleetConfig(accountNumber: ActiveAccountNumber, config: FleetConfig): void {
  const fleet = fleetOf(accountNumber);
  fleet.mediaEndpoint = mediaEndpointOf(config);

  for(const lane of [...fleet.lanes.values()]) {
    if(lane.kind === 'media' && lane.endpoint !== fleet.mediaEndpoint) {
      retireLane(fleet, lane);
    }
  }
}

/** The media endpoint the config published for this account, or undefined while none is published. */
export function mediaFleetEndpoint(accountNumber: ActiveAccountNumber): string | undefined {
  return fleetOf(accountNumber).mediaEndpoint;
}

/** Retires every lane of an account: its connections drain their calls in flight and close. Used on every identity change. */
export function resetFleetIdentity(accountNumber: ActiveAccountNumber): void {
  const fleet = fleetByAccount.get(accountNumber);
  if(!fleet) {
    return;
  }

  for(const lane of [...fleet.lanes.values()]) {
    retireLane(fleet, lane);
  }
}

/** The calls each carrier has answered for an account. */
export function fleetCounters(accountNumber: ActiveAccountNumber): FleetCounters {
  return {...fleetOf(accountNumber).counters};
}

/** Counts one call answered by the update socket of the account. */
export function countSocketCall(accountNumber: ActiveAccountNumber): void {
  fleetOf(accountNumber).counters.socket++;
}

/** Sends one file-transfer call on the media fleet, under the identity the call presents. Rejects with an ApiError. */
export async function callMediaFleet(call: FleetCall): Promise<Uint8Array> {
  const fleet = fleetOf(call.accountNumber);
  if(fleet.mediaEndpoint === undefined || !routesToMediaFleet(call.method)) {
    throw new Error(`${call.method} has no media fleet endpoint to travel`);
  }

  const reply = await sendOnLane(
    fleet,
    {kind: 'media', endpoint: fleet.mediaEndpoint},
    call.identity,
    call.method,
    call.request,
    call.signal
  );
  fleet.counters.media++;
  return reply;
}

/**
 * Sends the session refresh on the anonymous pool of the RPC endpoint. The refresh carries its refresh token in the
 * body, and it must not wait for the update socket, which is itself waiting for the token this call renews.
 */
export function callRefreshFleet(accountNumber: ActiveAccountNumber, method: string, request: Uint8Array): Promise<Uint8Array> {
  return sendOnLane(
    fleetOf(accountNumber),
    {kind: 'refresh', endpoint: defaultRpcEndpoint()},
    ANONYMOUS_IDENTITY,
    method,
    request
  );
}

async function sendOnLane(
  fleet: AccountFleet,
  target: LaneTarget,
  identity: FleetIdentity,
  method: string,
  request: Uint8Array,
  signal?: AbortSignal
): Promise<Uint8Array> {
  for(;;) {
    const lane = laneFor(fleet, target, identity);
    let reply: FleetPoolReply;
    try {
      reply = await lane.send(method, request, signal);
    } catch(err: unknown) {
      if(err instanceof FleetLaneRetiredError) {
        continue;
      }

      throw failureOf(fleet, lane, method, identity, err);
    }

    if(reply.data === undefined) {
      throw transportApiError(reply);
    }

    return reply.data;
  }
}

function laneFor(fleet: AccountFleet, target: LaneTarget, identity: FleetIdentity): FleetLane {
  const key = `${target.kind}|${target.endpoint}|${identity.key}`;
  let lane = fleet.lanes.get(key);
  if(!lane) {
    // A media connection presents its slot's identity: once the identity moves on, the lanes of the old one are retired.
    if(target.kind === 'media') {
      for(const stale of [...fleet.lanes.values()]) {
        if(stale.kind === 'media' && stale.identityKey !== identity.key) {
          retireLane(fleet, stale);
        }
      }
    }

    const isMedia: boolean = target.kind === 'media';
    lane = new FleetLane({
      key,
      identityKey: identity.key,
      kind: target.kind,
      endpoint: target.endpoint,
      timeoutMs: isMedia ? MEDIA_CALL_TIMEOUT_MS : REFRESH_CALL_TIMEOUT_MS,
      connectionsPerEndpoint: isMedia ? MEDIA_CONNECTIONS_PER_ENDPOINT : REFRESH_CONNECTIONS_PER_ENDPOINT,
      inflightPerConnection: isMedia ? MEDIA_INFLIGHT_PER_CONNECTION : REFRESH_INFLIGHT_PER_CONNECTION,
      getToken: identity.getToken
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
function failureOf(fleet: AccountFleet, lane: FleetLane, method: string, identity: FleetIdentity, err: unknown): ApiError {
  const error = (err ?? {}) as FleetRpcError;
  if(error.code === TOKEN_EXPIRED_CODE || error.code === AUTH_TOKEN_INVALID_CODE) {
    retireLane(fleet, lane);
    logger.warn('Fleet refused the token of a call', {method, code: error.code, identity: identity.kind});
  }

  return fleetFailure(method, error);
}

/** The one mapping of a rejection of any carrier to the ApiError the caller sees; a method the registry lacks is traced. */
export function fleetFailure(method: string, err: unknown): ApiError {
  const error = (err ?? {}) as FleetRpcError;
  if(error.code === METHOD_INVALID_CODE) {
    logger.warn('Fleet registry lacks the method', {method, code: error.code});
  }

  return fleetApiError(error);
}
