import {beforeEach, describe, expect, it, vi} from 'vitest';
import {errorCodes} from '@impulsem/centrifuge/build/protobuf';

import type {ActiveAccountNumber} from '@lib/accounts/types';
import {callMediaFleet, fleetCounters, resetFleetIdentity, setFleetConfig, setFleetIdentitySource} from '@lib/impulse/fleet/fleet';
import type {FleetCall, FleetIdentity} from '@lib/impulse/fleet/fleet';
import {FLEET_CONNECTION_PATH} from '@lib/impulse/fleet/fleetPath';
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
const MEDIA_URL: string = `wss://media.impulsem.io:443${FLEET_CONNECTION_PATH}`;
const OTHER_MEDIA_URL: string = `wss://media-2.impulsem.io:443${FLEET_CONNECTION_PATH}`;
const REQUEST_BYTES: Uint8Array = new Uint8Array([1, 2, 3]);
const REPLY_BYTES: Uint8Array = new Uint8Array([4, 5, 6]);
const SESSION_TOKEN: string = 'session-token-current';
const PENDING_TOKEN: string = 'pending-token-current';
const GET_FILE: string = 'upload.getFile';

const ANONYMOUS: FleetIdentity = {kind: 'anonymous', key: 'anonymous', getToken: undefined};

function sessionIdentity(token: string): FleetIdentity {
  return {kind: 'session', key: `session:${token}`, getToken: async(): Promise<string> => token};
}

function pendingIdentity(token: string): FleetIdentity {
  return {kind: 'pending', key: `pending:${token}`, getToken: async(): Promise<string> => token};
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

let presentedIdentity: FleetIdentity = ANONYMOUS;

function presentIdentity(identity: FleetIdentity): void {
  presentedIdentity = identity;
}

beforeEach(() => {
  resetFleetIdentity(ACCOUNT);
  resetFleetIdentity(OTHER_ACCOUNT);
  setFleetIdentitySource(() => presentedIdentity);
  presentIdentity(ANONYMOUS);
  fleetHarness.reset();
  warn.mockClear();
});

describe('the media fleet is built from the media option of the current DC', () => {
  it('a published media option carries the file calls on its own pool', async() => {
    setFleetConfig(ACCOUNT, withMediaOption('media.impulsem.io'));
    fleetHarness.respondOnce(GET_FILE, () => ({data: REPLY_BYTES}));

    await callMediaFleet(fileCall());

    expect(fleetHarness.calls.map((call) => call.endpoint), 'the file call goes to the media endpoint').toEqual([MEDIA_URL]);
  });

  it('a file call with no media option published is refused with a typed error, never sent to another pool', async() => {
    setFleetConfig(ACCOUNT, {this_dc: CURRENT_DC, dc_options: [{id: CURRENT_DC, ip_address: '149.154.167.50', port: 443}]});

    await expect(
      callMediaFleet(fileCall()),
      'a config that publishes no media option fails the call with the typed transport error'
    ).rejects.toMatchObject({type: 'NETWORK_BAD_RESPONSE', code: 500});
    expect(fleetHarness.pools, 'no pool is opened for a call the media fleet cannot carry').toHaveLength(0);
  });

  it('a repeated publication of the same endpoint keeps the pool, and a new endpoint retires the old one', async() => {
    setFleetConfig(ACCOUNT, withMediaOption('media.impulsem.io'));
    fleetHarness.respondOnce(GET_FILE, () => ({data: REPLY_BYTES}));
    await callMediaFleet(fileCall());
    const first = fleetHarness.pools[0];

    setFleetConfig(ACCOUNT, withMediaOption('media.impulsem.io'));
    expect(first.close, 'the same endpoint must not drop the connections of the pool').not.toHaveBeenCalled();

    setFleetConfig(ACCOUNT, withMediaOption('media-2.impulsem.io'));
    expect(first.close, 'a withdrawn endpoint closes its pool once it has no call in flight').toHaveBeenCalledTimes(1);

    fleetHarness.respondOnce(GET_FILE, () => ({data: REPLY_BYTES}));
    await callMediaFleet(fileCall());
    expect(fleetHarness.calls[1].endpoint).toBe(OTHER_MEDIA_URL);
  });

  it('resetting the identity of an account closes its pools and keeps the other account\'s', async() => {
    setFleetConfig(ACCOUNT, withMediaOption('media.impulsem.io'));
    setFleetConfig(OTHER_ACCOUNT, withMediaOption('media.impulsem.io'));
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
    setFleetConfig(ACCOUNT, withMediaOption('media.impulsem.io'));
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
    setFleetConfig(ACCOUNT, withMediaOption('media.impulsem.io'));
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

  it('a call beyond the queue bound is refused at once with limitExceeded, and is not held or sent again', async() => {
    fleetHarness.respond(GET_FILE, () => new Promise(() => {}));
    void callMediaFleet(fileCall());
    const pool = fleetHarness.pools[0];
    const slots = (pool.options.maxConnectionsPerEndpoint ?? 1) * (pool.options.maxInflightPerConnection ?? 1);
    const bound = pool.options.maxQueued ?? 0;
    for(let i = 0; i < slots - 1 + bound; ++i) {
      void callMediaFleet(fileCall());
    }
    await vi.waitFor(() => expect(fleetHarness.calls).toHaveLength(slots));
    const callsBeforeRefusal = fleetHarness.calls.length;

    const outcome = await Promise.race([
      callMediaFleet(fileCall()).then(() => 'answered', (error: unknown) => error),
      new Promise<string>((resolve: (value: string) => void): void => {
        setTimeout(() => resolve('still waiting'), 100);
      })
    ]);

    expect(
      outcome,
      'a call over the queue bound must be refused with the SDK\'s limitExceeded at once, as a typed transport fault, not held for a settled call'
    ).toMatchObject({type: 'NETWORK_BAD_RESPONSE', code: 500});
    expect(fleetHarness.calls.length, 'the refused call is never sent').toBe(callsBeforeRefusal);
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
    setFleetConfig(ACCOUNT, withMediaOption('media.impulsem.io'));
  });

  it('a signed-out call opens a pool whose connection carries no token', async() => {
    fleetHarness.respondOnce(GET_FILE, () => ({data: REPLY_BYTES}));

    await callMediaFleet(fileCall());

    expect(fleetHarness.pools[0].options.connection.getToken, 'an anonymous pool asks for no token').toBeUndefined();
    expect(fleetHarness.pools[0].options.connection.token).toBeUndefined();
    expect(fleetHarness.calls[0].presentedToken).toBeUndefined();
  });

  it('a pending call presents the pending token its identity hands out', async() => {
    fleetHarness.respondOnce(GET_FILE, () => ({data: REPLY_BYTES}));
    presentIdentity(pendingIdentity(PENDING_TOKEN));

    await callMediaFleet(fileCall());

    expect(fleetHarness.calls[0].presentedToken).toBe(PENDING_TOKEN);
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

    presentIdentity(pendingIdentity(PENDING_TOKEN));

    await expect(callMediaFleet(fileCall()))
      .rejects.toMatchObject({type: 'AUTH_TOKEN_INVALID'});
    expect(fleetHarness.pools[0].close, 'a token the fleet refused must not keep its connection').toHaveBeenCalledTimes(1);
  });
});

describe('a server error is mapped by the one error mapper, and the registry codes are traced remotely', () => {
  beforeEach(() => {
    setFleetConfig(ACCOUNT, withMediaOption('media.impulsem.io'));
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
