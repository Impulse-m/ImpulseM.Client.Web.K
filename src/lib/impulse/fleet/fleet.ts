/*
 * The Centrifugo RPC fleets of the client, per account slot: the media fleet for the four file-transfer calls, the
 * RPC fleet for every other call. Each fleet keeps one lane per endpoint and identity; a lane is a pool of protobuf
 * connections, and its identity decides the token those connections present (session, pending 2FA or none).
 *
 * The lanes are retired, not patched, when the endpoint or the identity of the account changes: the connections of
 * the old identity drain their calls in flight and then close, and the next call opens a lane for the new one.
 */

import type {ActiveAccountNumber} from '@lib/accounts/types';
import {getLogger} from '@lib/impulseLogger';
import {TOKEN_EXPIRED_CODE} from '@lib/impulse/centrifugoCodes';
import {fleetApiError, transportApiError} from './fleetError';
import type {FleetRpcError} from './fleetError';
import {FleetLane, FleetLaneRetiredError} from './fleetLane';
import type {FleetKind, FleetPoolReply} from './fleetLane';
import {fleetEndpointsOf, routesToMediaFleet, defaultRpcEndpoint} from './fleetRoute';
import type {FleetConfig, FleetEndpoints} from './fleetRoute';

const logger = getLogger('fleet');

// The registry's timeout for the four file-transfer calls (deploy/centrifugo/media/registry.json).
const MEDIA_CALL_TIMEOUT_MS: number = 10_000;
// The calls of the RPC fleet take as long as their handler does; no registry bound is published for them yet.
const RPC_CALL_TIMEOUT_MS: number = 30_000;
// Calls in flight per connection: the media registry needs client.concurrency >= window + 1 on the server
// (deploy/centrifugo/media/config.json: 3). The RPC fleet keeps the pool's default of one until it publishes more.
const MEDIA_INFLIGHT_PER_CONNECTION: number = 2;
const RPC_INFLIGHT_PER_CONNECTION: number = 1;
const MEDIA_CONNECTIONS_PER_ENDPOINT: number = 2;
// Every TL call of the client travels this lane: one call per connection, so four connections carry four calls at once.
const RPC_CONNECTIONS_PER_ENDPOINT: number = 4;
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

export type FleetCounters = {media: number, rpc: number};

type AccountFleet = {
  endpoints: FleetEndpoints,
  lanes: Map<string, FleetLane>,
  counters: FleetCounters
};

const fleetByAccount = new Map<ActiveAccountNumber, AccountFleet>();

function fleetOf(accountNumber: ActiveAccountNumber): AccountFleet {
  let fleet = fleetByAccount.get(accountNumber);
  if(!fleet) {
    fleet = {
      endpoints: {rpc: defaultRpcEndpoint(), media: undefined},
      lanes: new Map<string, FleetLane>(),
      counters: {media: 0, rpc: 0}
    };
    fleetByAccount.set(accountNumber, fleet);
  }

  return fleet;
}

/** Publishes the fleet endpoints of an account's config. A lane on an endpoint that changed is retired. */
export function setFleetConfig(accountNumber: ActiveAccountNumber, config: FleetConfig): void {
  const fleet = fleetOf(accountNumber);
  fleet.endpoints = fleetEndpointsOf(config);

  for(const lane of [...fleet.lanes.values()]) {
    const endpoint = lane.kind === 'media' ? fleet.endpoints.media : fleet.endpoints.rpc;
    if(lane.endpoint !== endpoint) {
      retireLane(fleet, lane);
    }
  }
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

/** The calls each fleet has answered for an account. */
export function fleetCounters(accountNumber: ActiveAccountNumber): FleetCounters {
  return {...fleetOf(accountNumber).counters};
}

type LaneTarget = {
  kind: FleetKind,
  endpoint: string
};

/** Sends one call to the fleet that carries its method, under the identity the call presents. Rejects with an ApiError. */
export async function callFleet(call: FleetCall): Promise<Uint8Array> {
  const fleet = fleetOf(call.accountNumber);
  const mediaEndpoint: string | undefined = routesToMediaFleet(call.method) ? fleet.endpoints.media : undefined;
  const target: LaneTarget = mediaEndpoint === undefined
    ? {kind: 'rpc', endpoint: fleet.endpoints.rpc}
    : {kind: 'media', endpoint: mediaEndpoint};

  for(;;) {
    const lane = laneFor(fleet, target, call.identity);
    let reply: FleetPoolReply;
    try {
      reply = await lane.send(call.method, call.request, call.signal);
    } catch(err: unknown) {
      if(err instanceof FleetLaneRetiredError) {
        continue;
      }

      throw failureOf(fleet, lane, call, err);
    }

    if(reply.data === undefined) {
      throw transportApiError(reply);
    }

    fleet.counters[target.kind]++;
    return reply.data;
  }
}

function laneFor(fleet: AccountFleet, target: LaneTarget, identity: FleetIdentity): FleetLane {
  const key = `${target.kind}|${target.endpoint}|${identity.key}`;
  let lane = fleet.lanes.get(key);
  if(!lane) {
    const isMedia: boolean = target.kind === 'media';
    lane = new FleetLane({
      key,
      kind: target.kind,
      endpoint: target.endpoint,
      timeoutMs: isMedia ? MEDIA_CALL_TIMEOUT_MS : RPC_CALL_TIMEOUT_MS,
      connectionsPerEndpoint: isMedia ? MEDIA_CONNECTIONS_PER_ENDPOINT : RPC_CONNECTIONS_PER_ENDPOINT,
      inflightPerConnection: isMedia ? MEDIA_INFLIGHT_PER_CONNECTION : RPC_INFLIGHT_PER_CONNECTION,
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
function failureOf(fleet: AccountFleet, lane: FleetLane, call: FleetCall, err: unknown): ApiError {
  const error = (err ?? {}) as FleetRpcError;
  if(error.code === TOKEN_EXPIRED_CODE || error.code === AUTH_TOKEN_INVALID_CODE) {
    retireLane(fleet, lane);
    logger.warn('Fleet refused the token of a call', {method: call.method, code: error.code, identity: call.identity.kind});
  }

  if(error.code === METHOD_INVALID_CODE) {
    logger.warn('Fleet registry lacks the method', {method: call.method, code: error.code});
  }

  return fleetApiError(error);
}
