import {beforeEach, describe, expect, it, vi} from 'vitest';
import {errorCodes} from '@impulsem/centrifuge/build/protobuf';

import type {ActiveAccountNumber} from '@lib/accounts/types';
import {callMediaFleet, callPool, fleetCounters, resetFleetIdentity, setFleetConfig, setFleetIdentitySource} from '@lib/impulse/fleet/fleet';
import type {FleetCall, FleetIdentity} from '@lib/impulse/fleet/fleet';
import {FLEET_CONNECTION_PATH} from '@lib/impulse/fleet/fleetPath';
import {CONNECTION_IDENTITY_METHOD} from '@lib/impulse/fleet/fleetRoute';
import type {FleetConfig} from '@lib/impulse/fleet/fleetRoute';
import {sharedFleetPoolHarness} from './helpers/fleetPoolStub';

const warn = vi.hoisted(() => vi.fn());

vi.mock('@impulsem/centrifuge/build/protobuf', async(importActual) => {
  const actual = await importActual<typeof import('@impulsem/centrifuge/build/protobuf')>();
  const {sharedFleetPoolHarness} = await import('./helpers/fleetPoolStub');
  return {...actual, RpcPool: sharedFleetPoolHarness().RpcPoolStub};
});

vi.mock('@lib/impulseLogger', () => ({
  getLogger: () => ({info: vi.fn(), warn, debug: vi.fn(), error: vi.fn()}),
  setLogAuthTokenProvider: vi.fn()
}));


const fleetHarness = sharedFleetPoolHarness();

const ACCOUNT: ActiveAccountNumber = 1;
const OTHER_ACCOUNT: ActiveAccountNumber = 2;
const CURRENT_DC: number = 2;
const MEDIA_URL: string = `wss://media.example.org:443${FLEET_CONNECTION_PATH}`;
const OTHER_MEDIA_URL: string = `wss://media-2.example.org:443${FLEET_CONNECTION_PATH}`;
const REQUEST_BYTES: Uint8Array = new Uint8Array([1, 2, 3]);
const REPLY_BYTES: Uint8Array = new Uint8Array([4, 5, 6]);
const SESSION_TOKEN: string = 'session-token-current';
const IDENTITY_TOKEN: string = 'identity-token-current';
const GET_FILE: string = 'upload.getFile';
const MEDIA_CALL_TIMEOUT_MS: number = 40_000;
const MEDIA_CONNECTIONS_PER_ENDPOINT: number = 3;
const MEDIA_INFLIGHT_PER_CONNECTION: number = 2;
const MEDIA_SERVER_CLIENT_CONCURRENCY: number = 3;
const MEDIA_POOL_RESENDS: number = 2;

const IDENTITY: FleetIdentity = {kind: 'identity', key: 'identity:0', getToken: async(): Promise<string> => IDENTITY_TOKEN};

function sessionIdentity(token: string): FleetIdentity {
  return {kind: 'session', key: `session:${token}`, getToken: async(): Promise<string> => token};
}

function loginIdentity(token: string): FleetIdentity {
  return {kind: 'identity', key: `identity:${token}`, getToken: async(): Promise<string> => token};
}

function withMediaOption(host: string): FleetConfig {
  return {
    this_dc: CURRENT_DC,
    dc_options: [
      {id: CURRENT_DC, ip_address: '149.154.167.50', port: 443},
      {id: CURRENT_DC, ip_address: host, port: 443, pFlags: {media_only: true}}
    ]
  };
}

function fileCall(overrides: Partial<FleetCall> = {}): FleetCall {
  return {accountNumber: ACCOUNT, method: GET_FILE, request: REQUEST_BYTES, ...overrides};
}

function poolCall(): FleetCall {
  return {accountNumber: ACCOUNT, method: CONNECTION_IDENTITY_METHOD, request: REQUEST_BYTES};
}

let presentedIdentity: FleetIdentity = IDENTITY;

function presentIdentity(identity: FleetIdentity): void {
  presentedIdentity = identity;
}

beforeEach(() => {
  resetFleetIdentity(ACCOUNT);
  resetFleetIdentity(OTHER_ACCOUNT);
  setFleetIdentitySource(() => presentedIdentity);
  presentIdentity(IDENTITY);
  fleetHarness.reset();
  warn.mockClear();
});

describe('the media fleet is built from the media option of the current DC', () => {
  it('a published media option carries the file calls on its own pool', async() => {
    setFleetConfig(ACCOUNT, withMediaOption('media.example.org'));
    fleetHarness.respondOnce(GET_FILE, () => ({data: REPLY_BYTES}));

    await callMediaFleet(fileCall());

    expect(fleetHarness.calls.map((call) => call.endpoint), 'the file call goes to the media endpoint').toEqual([MEDIA_URL]);
  });

  it('a file call with no media option published is refused with a typed error, never sent to another pool', async() => {
    setFleetConfig(ACCOUNT, {this_dc: CURRENT_DC, dc_options: [{id: CURRENT_DC, ip_address: '149.154.167.50', port: 443}]});

    await expect(
      callMediaFleet(fileCall()),
      'a config that publishes no media option fails the call with the typed client error'
    ).rejects.toMatchObject({type: 'FLEET_MEDIA_OPTION_MISSING', code: 0});
    expect(fleetHarness.pools, 'no pool is opened for a call the media fleet cannot carry').toHaveLength(0);
  });

  it('a repeated publication of the same endpoint keeps the pool, and a new endpoint retires the old one', async() => {
    setFleetConfig(ACCOUNT, withMediaOption('media.example.org'));
    fleetHarness.respondOnce(GET_FILE, () => ({data: REPLY_BYTES}));
    await callMediaFleet(fileCall());
    const first = fleetHarness.pools[0];

    setFleetConfig(ACCOUNT, withMediaOption('media.example.org'));
    expect(first.close, 'the same endpoint must not drop the connections of the pool').not.toHaveBeenCalled();

    setFleetConfig(ACCOUNT, withMediaOption('media-2.example.org'));
    expect(first.close, 'a withdrawn endpoint closes its pool once it has no call in flight').toHaveBeenCalledTimes(1);

    fleetHarness.respondOnce(GET_FILE, () => ({data: REPLY_BYTES}));
    await callMediaFleet(fileCall());
    expect(fleetHarness.calls[1].endpoint).toBe(OTHER_MEDIA_URL);
  });

  it('resetting the identity of an account closes its pools and keeps the other account\'s', async() => {
    setFleetConfig(ACCOUNT, withMediaOption('media.example.org'));
    setFleetConfig(OTHER_ACCOUNT, withMediaOption('media.example.org'));
    fleetHarness.respondOnce(GET_FILE, () => ({data: REPLY_BYTES}));
    await callMediaFleet(fileCall({accountNumber: ACCOUNT}));
    fleetHarness.respondOnce(GET_FILE, () => ({data: REPLY_BYTES}));
    await callMediaFleet(fileCall({accountNumber: OTHER_ACCOUNT}));
    const [accountPool, otherPool] = [fleetHarness.pools[0], fleetHarness.pools[1]];

    resetFleetIdentity(ACCOUNT);

    expect(accountPool.close, 'signing this account out must close the connections it carried').toHaveBeenCalledTimes(1);
    expect(otherPool.close, 'the other account keeps its connections').not.toHaveBeenCalled();
  });

  it('a call under a new identity retires the pool of the identity it replaces', async() => {
    setFleetConfig(ACCOUNT, withMediaOption('media.example.org'));
    fleetHarness.respondOnce(GET_FILE, () => ({data: REPLY_BYTES}));
    fleetHarness.respondOnce(GET_FILE, () => ({data: REPLY_BYTES}));
    presentIdentity(sessionIdentity('session-token-old'));
    await callMediaFleet(fileCall());
    const previous = fleetHarness.pools[0];

    presentIdentity(sessionIdentity('session-token-renewed'));
    await callMediaFleet(fileCall());

    expect(previous.close, 'the connections that presented the refused token must not outlive the identity').toHaveBeenCalledTimes(1);
    expect(fleetHarness.calls[1].presentedToken).toBe('session-token-renewed');
  });
});

describe('a call is answered by the reply bytes of its pool', () => {
  beforeEach(() => {
    setFleetConfig(ACCOUNT, withMediaOption('media.example.org'));
  });

  it('sends the request bytes under the canon method name and returns the reply bytes', async() => {
    fleetHarness.respondOnce(GET_FILE, () => ({data: REPLY_BYTES}));

    await expect(callMediaFleet(fileCall())).resolves.toBe(REPLY_BYTES);

    expect(fleetHarness.calls[0].method, 'the registry method is the canon name, not a gRPC path').toBe(GET_FILE);
    expect(fleetHarness.calls[0].data, 'the request is the protobuf request, passed through unchanged').toBe(REQUEST_BYTES);
  });

  it('an empty reply body is an answer: the message it encodes is an empty message', async() => {
    fleetHarness.respondOnce(GET_FILE, () => ({data: new Uint8Array(0)}));

    await expect(callMediaFleet(fileCall())).resolves.toEqual(new Uint8Array(0));
  });

  it('an absent reply body is a typed transport error, never an empty answer', async() => {
    fleetHarness.respondOnce(GET_FILE, () => ({data: undefined}));

    await expect(
      callMediaFleet(fileCall()),
      'the reply must carry its data: a reply without it is a fault of the fleet, not an empty success'
    ).rejects.toMatchObject({type: 'NETWORK_BAD_RESPONSE', code: 500});
  });

  it('a call over the pool\'s slots waits for a settled call of its pool and is sent then', async() => {
    const finishers: Array<() => void> = [];
    fleetHarness.respond(GET_FILE, () => new Promise((resolve: (reply: {data?: Uint8Array}) => void): void => {
      finishers.push(() => resolve({data: REPLY_BYTES}));
    }));

    const calls = [callMediaFleet(fileCall())];
    const pool = fleetHarness.pools[0];
    const slots = (pool.options.maxConnectionsPerEndpoint ?? 1) * (pool.options.maxInflightPerConnection ?? 1);
    calls.push(...Array.from({length: slots}, () => callMediaFleet(fileCall())));
    await vi.waitFor(() => expect(fleetHarness.calls).toHaveLength(slots));

    finishers.shift()?.();
    await vi.waitFor(() => expect(fleetHarness.calls, 'the call that waited is sent once a slot of its pool frees').toHaveLength(slots + 1));
    while(finishers.length > 0) {
      finishers.shift()?.();
    }

    await expect(Promise.all(calls)).resolves.toEqual(calls.map(() => REPLY_BYTES));
  });

  it('a pool call beyond the queue bound is refused at once with limitExceeded, and is not held or sent again', async() => {
    fleetHarness.respond(CONNECTION_IDENTITY_METHOD, () => new Promise(() => {}));
    void callPool(poolCall());
    const pool = fleetHarness.pools[0];
    const slots = (pool.options.maxConnectionsPerEndpoint ?? 1) * (pool.options.maxInflightPerConnection ?? 1);
    const bound = pool.options.maxQueued ?? 0;
    for(let i = 0; i < slots - 1 + bound; ++i) {
      void callPool(poolCall());
    }
    await vi.waitFor(() => expect(fleetHarness.calls).toHaveLength(slots));
    const callsBeforeRefusal = fleetHarness.calls.length;

    const outcome: {settled?: {answered: boolean, error?: unknown}} = {};
    void callPool(poolCall()).then(
      (): void => {
        outcome.settled = {answered: true};
      },
      (error: unknown): void => {
        outcome.settled = {answered: false, error};
      }
    );

    await vi.waitFor(() => expect(
      outcome.settled,
      'a call over the queue bound must settle at once, not be held for a settled call of the pool'
    ).toBeDefined());
    expect(
      outcome.settled?.error,
      'a call over the queue bound must be refused with the SDK\'s limitExceeded at once, as a typed transport fault'
    ).toMatchObject({type: 'NETWORK_BAD_RESPONSE', code: 500});
    expect(fleetHarness.calls.length, 'the refused call is never sent').toBe(callsBeforeRefusal);
  });

  it('a media call beyond the window and beyond the pool queue bound waits in the local queue and is answered, never refused', async() => {
    fleetHarness.respondOnce(GET_FILE, () => ({data: REPLY_BYTES}));
    await callMediaFleet(fileCall());
    const pool = fleetHarness.pools[0];
    const windowSize: number = (pool.options.maxConnectionsPerEndpoint ?? 1) * (pool.options.maxInflightPerConnection ?? 1);
    const bound: number = pool.options.maxQueued ?? 0;
    const callCount: number = windowSize + bound + 1;
    fleetHarness.respond(GET_FILE, () => ({data: REPLY_BYTES}));

    const outcomes = await Promise.allSettled(Array.from({length: callCount}, () => callMediaFleet(fileCall())));

    expect(
      outcomes.filter((outcome: PromiseSettledResult<Uint8Array>): boolean => outcome.status === 'rejected'),
      'every call beyond the window waits for its slot in the local queue: none is refused'
    ).toEqual([]);
    expect(fleetHarness.calls, 'every call of the burst reaches the fleet, the first one included').toHaveLength(callCount + 1);
  });

  it('counts the calls the media fleet answered', async() => {
    const before = fleetCounters(ACCOUNT);
    fleetHarness.respondOnce(GET_FILE, () => ({data: REPLY_BYTES}));
    await callMediaFleet(fileCall());

    const after = fleetCounters(ACCOUNT);
    expect(after.media - before.media, 'the media fleet counts the calls it answered').toBe(1);
    expect(after.socket - before.socket, 'a media call is not counted as an update socket call').toBe(0);
  });
});

describe('the identity a call presents decides the connection token of its pool', () => {
  beforeEach(() => {
    setFleetConfig(ACCOUNT, withMediaOption('media.example.org'));
  });

  it('an identity call presents the identity token its identity hands out', async() => {
    fleetHarness.respondOnce(GET_FILE, () => ({data: REPLY_BYTES}));
    presentIdentity(loginIdentity(IDENTITY_TOKEN));

    await callMediaFleet(fileCall());

    expect(fleetHarness.calls[0].presentedToken).toBe(IDENTITY_TOKEN);
  });

  it('a signed-in call presents the session token its identity hands out', async() => {
    fleetHarness.respondOnce(GET_FILE, () => ({data: REPLY_BYTES}));
    presentIdentity(sessionIdentity(SESSION_TOKEN));

    await callMediaFleet(fileCall());

    expect(fleetHarness.calls[0].presentedToken).toBe(SESSION_TOKEN);
  });

  it('a refusal of the token retires the pool it was sent on, so the next call connects again', async() => {
    fleetHarness.respondOnce(GET_FILE, () => {
      throw {code: 103, message: 'AUTH_TOKEN_INVALID', appCode: 400, appType: 'AUTH_TOKEN_INVALID'};
    });

    presentIdentity(loginIdentity(IDENTITY_TOKEN));

    await expect(callMediaFleet(fileCall()))
      .rejects.toMatchObject({type: 'AUTH_TOKEN_INVALID'});
    expect(fleetHarness.pools[0].close, 'a token the fleet refused must not keep its connection').toHaveBeenCalledTimes(1);
  });
});

describe('a server error is mapped by the one error mapper, and the registry codes are traced remotely', () => {
  beforeEach(() => {
    setFleetConfig(ACCOUNT, withMediaOption('media.example.org'));
  });

  it('104 METHOD_INVALID reaches the caller with its catalog type and is written to the remote trace with the method', async() => {
    fleetHarness.respondOnce(GET_FILE, () => {
      throw {code: 104, message: 'METHOD_INVALID', appCode: 400, appType: 'METHOD_INVALID'};
    });

    await expect(callMediaFleet(fileCall())).rejects.toMatchObject({type: 'METHOD_INVALID', code: 400});
    expect(
      warn.mock.calls.some(([, payload]) => payload?.code === 104 && payload?.method === GET_FILE),
      'the server lacks this method: the remote trace must name it so the server can add it, and nothing is retried'
    ).toBe(true);
  });

  it('a cancelled call rejects as CANCELED and is not sent again', async() => {
    fleetHarness.respondOnce(GET_FILE, () => {
      throw {code: errorCodes.cancelled, message: 'cancelled'};
    });

    await expect(callMediaFleet(fileCall())).rejects.toMatchObject({type: 'CANCELED'});
    expect(fleetHarness.calls).toHaveLength(1);
  });

  it('a lost connection is a typed transport error for the caller\'s normal retry, not a silent second send', async() => {
    fleetHarness.respondOnce(GET_FILE, () => {
      throw {code: errorCodes.connectionClosed, message: 'connection closed'};
    });

    await expect(callMediaFleet(fileCall())).rejects.toMatchObject({type: 'NETWORK_BAD_RESPONSE', code: 500});
    expect(fleetHarness.calls, 'the call is not replayed over another path').toHaveLength(1);
  });
});

describe('the media pool is sized to the server rule', () => {
  beforeEach(() => {
    setFleetConfig(ACCOUNT, withMediaOption('media.impulsem.io'));
  });

  it('client.concurrency of the media fleet is the window per connection plus one: 3 connections of 2 calls in flight', async() => {
    fleetHarness.respondOnce(GET_FILE, () => ({data: REPLY_BYTES}));
    await callMediaFleet(fileCall());

    const options = fleetHarness.pools[0].options;
    expect(options.maxConnectionsPerEndpoint, 'the media pool opens 3 connections').toBe(MEDIA_CONNECTIONS_PER_ENDPOINT);
    expect(options.maxInflightPerConnection, 'each media connection carries 2 calls in flight').toBe(MEDIA_INFLIGHT_PER_CONNECTION);
    expect(
      (options.maxInflightPerConnection ?? 0) + 1,
      'the server client.concurrency of the media fleet is the window per connection plus one'
    ).toBe(MEDIA_SERVER_CLIENT_CONCURRENCY);
  });

  it('the media deadline is 40 000 ms, and the pool starts it when the call is submitted', async() => {
    fleetHarness.respondOnce(GET_FILE, () => ({data: REPLY_BYTES}));
    await callMediaFleet(fileCall());

    expect(fleetHarness.pools[0].options.connection.timeout, 'a call queued in the local window does not spend its deadline').toBe(MEDIA_CALL_TIMEOUT_MS);
  });

  it('the media pool resends a call twice, and the pool lane keeps the SDK default of resends', async() => {
    fleetHarness.respondOnce(GET_FILE, () => ({data: REPLY_BYTES}));
    await callMediaFleet(fileCall());
    fleetHarness.respondOnce(CONNECTION_IDENTITY_METHOD, () => ({data: REPLY_BYTES}));
    await callPool(poolCall());

    expect(fleetHarness.pools[0].options.retries, 'the media pool resends a call twice, not the SDK default of 3').toBe(MEDIA_POOL_RESENDS);
    expect(fleetHarness.pools[1].options.retries, 'the pool lane passes no resends and keeps the SDK default').toBeUndefined();
  });
});
