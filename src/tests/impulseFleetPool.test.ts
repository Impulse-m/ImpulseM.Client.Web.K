import {beforeEach, describe, expect, it, vi} from 'vitest';
import {errorCodes} from '@impulsem/centrifuge/build/protobuf';

import type {ActiveAccountNumber} from '@lib/accounts/types';
import {callFleet, fleetCounters, resetFleetIdentity, setFleetConfig} from '@lib/impulse/fleet/fleet';
import type {FleetCall, FleetIdentity} from '@lib/impulse/fleet/fleet';
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
const FLEET_PATH: string = '/connection/websocket?cf_protocol=protobuf&cf_ws_frame_ping_pong=true';
const MEDIA_URL: string = `wss://media.impulsem.io:443${FLEET_PATH}`;
const RPC_MAIN_URL: string = `wss://149.154.167.50:443${FLEET_PATH}`;
const OTHER_MEDIA_URL: string = `wss://media-2.impulsem.io:443${FLEET_PATH}`;
const REQUEST_BYTES: Uint8Array = new Uint8Array([1, 2, 3]);
const REPLY_BYTES: Uint8Array = new Uint8Array([4, 5, 6]);
const SESSION_TOKEN: string = 'session-token-current';
const PENDING_TOKEN: string = 'pending-token-current';
const GET_FILE: string = 'upload.getFile';
const GET_LANG_PACK: string = 'langpack.getLangPack';
const GET_PASSWORD: string = 'account.getPassword';

const ANONYMOUS: FleetIdentity = {kind: 'anonymous', key: 'anonymous', getToken: undefined};

function sessionIdentity(token: string): FleetIdentity {
  return {kind: 'session', key: 'session', getToken: async(): Promise<string> => token};
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

const WITHOUT_MEDIA_OPTION: FleetConfig = {
  this_dc: CURRENT_DC,
  dc_options: [{id: CURRENT_DC, ip_address: '149.154.167.50', port: 443}]
};

function fileCall(overrides: Partial<FleetCall> = {}): FleetCall {
  return {accountNumber: ACCOUNT, method: GET_FILE, identity: ANONYMOUS, request: REQUEST_BYTES, ...overrides};
}

beforeEach(() => {
  resetFleetIdentity(ACCOUNT);
  resetFleetIdentity(OTHER_ACCOUNT);
  fleetHarness.reset();
  warn.mockClear();
});

describe('the fleets are built from the config of the current DC', () => {
  it('a published media option carries the file calls on its own pool, and the other calls on the RPC pool', async() => {
    setFleetConfig(ACCOUNT, withMediaOption('media.impulsem.io'));
    fleetHarness.respondOnce(GET_FILE, () => ({data: REPLY_BYTES}));
    fleetHarness.respondOnce(GET_LANG_PACK, () => ({data: REPLY_BYTES}));

    await callFleet(fileCall());
    await callFleet(fileCall({method: GET_LANG_PACK}));

    expect(
      fleetHarness.calls.map((call) => call.endpoint),
      'the file call goes to the media endpoint, the other call to the RPC endpoint'
    ).toEqual([MEDIA_URL, RPC_MAIN_URL]);
  });

  it('a file call with no media option travels the RPC pool, never the gateway', async() => {
    setFleetConfig(ACCOUNT, WITHOUT_MEDIA_OPTION);
    fleetHarness.respondOnce(GET_FILE, () => ({data: REPLY_BYTES}));

    await expect(callFleet(fileCall())).resolves.toBe(REPLY_BYTES);

    expect(
      fleetHarness.calls[0].endpoint,
      'with no media option the file calls take the main dcOption of this DC, the RPC fleet'
    ).toBe(RPC_MAIN_URL);
  });

  it('a repeated publication of the same endpoint keeps the pool, and a new endpoint retires the old one', async() => {
    setFleetConfig(ACCOUNT, withMediaOption('media.impulsem.io'));
    fleetHarness.respondOnce(GET_FILE, () => ({data: REPLY_BYTES}));
    await callFleet(fileCall());
    const first = fleetHarness.pools[0];

    setFleetConfig(ACCOUNT, withMediaOption('media.impulsem.io'));
    expect(first.close, 'the same endpoint must not drop the connections of the pool').not.toHaveBeenCalled();

    setFleetConfig(ACCOUNT, withMediaOption('media-2.impulsem.io'));
    expect(first.close, 'a withdrawn endpoint closes its pool once it has no call in flight').toHaveBeenCalledTimes(1);

    fleetHarness.respondOnce(GET_FILE, () => ({data: REPLY_BYTES}));
    await callFleet(fileCall());
    expect(fleetHarness.calls[1].endpoint).toBe(OTHER_MEDIA_URL);
  });

  it('resetting the identity of an account closes its pools and keeps the other account\'s', async() => {
    setFleetConfig(ACCOUNT, withMediaOption('media.impulsem.io'));
    setFleetConfig(OTHER_ACCOUNT, WITHOUT_MEDIA_OPTION);
    fleetHarness.respondOnce(GET_FILE, () => ({data: REPLY_BYTES}));
    await callFleet(fileCall({accountNumber: ACCOUNT}));
    fleetHarness.respondOnce(GET_FILE, () => ({data: REPLY_BYTES}));
    await callFleet(fileCall({accountNumber: OTHER_ACCOUNT}));
    const [accountPool, otherPool] = [fleetHarness.pools[0], fleetHarness.pools[1]];

    resetFleetIdentity(ACCOUNT);

    expect(accountPool.close, 'signing this account out must close the connections it carried').toHaveBeenCalledTimes(1);
    expect(otherPool.close, 'the other account keeps its connections').not.toHaveBeenCalled();
  });
});

describe('a call is answered by the reply bytes of its pool', () => {
  beforeEach(() => {
    setFleetConfig(ACCOUNT, withMediaOption('media.impulsem.io'));
  });

  it('sends the request bytes under the canon method name and returns the reply bytes', async() => {
    fleetHarness.respondOnce(GET_FILE, () => ({data: REPLY_BYTES}));

    await expect(callFleet(fileCall())).resolves.toBe(REPLY_BYTES);

    expect(fleetHarness.calls[0].method, 'the registry method is the canon name, not a gRPC path').toBe(GET_FILE);
    expect(fleetHarness.calls[0].data, 'the request is the protobuf request, passed through unchanged').toBe(REQUEST_BYTES);
  });

  it('an empty reply body is an answer: the message it encodes is an empty message', async() => {
    fleetHarness.respondOnce(GET_FILE, () => ({data: new Uint8Array(0)}));

    await expect(callFleet(fileCall())).resolves.toEqual(new Uint8Array(0));
  });

  it('an absent reply body is a typed transport error, never an empty answer', async() => {
    fleetHarness.respondOnce(GET_FILE, () => ({data: undefined}));

    await expect(
      callFleet(fileCall()),
      'the reply must carry its data: a reply without it is a fault of the fleet, not an empty success'
    ).rejects.toMatchObject({type: 'NETWORK_BAD_RESPONSE', code: 500});
  });

  it('a call over the queue bound waits for a settled call of its pool and is sent again', async() => {
    let finishFirst: ((reply: {data?: Uint8Array}) => void) | undefined;
    fleetHarness.respondOnce(GET_FILE, () => new Promise((resolve: (reply: {data?: Uint8Array}) => void): void => {
      finishFirst = resolve;
    }));
    fleetHarness.respondOnce(GET_FILE, () => {
      throw {code: errorCodes.limitExceeded, message: 'too many rpc calls waiting for a connection'};
    });
    fleetHarness.respondOnce(GET_FILE, () => ({data: REPLY_BYTES}));

    const first = callFleet(fileCall());
    const second = callFleet(fileCall());
    await vi.waitFor(() => expect(fleetHarness.calls).toHaveLength(2));
    finishFirst?.({data: REPLY_BYTES});

    await expect(first).resolves.toBe(REPLY_BYTES);
    await expect(
      second,
      'a full queue is a wait for a slot: the call is sent to the fleet once one frees, never answered by the gateway'
    ).resolves.toBe(REPLY_BYTES);
    expect(fleetHarness.calls).toHaveLength(3);
  });

  it('counts the calls each fleet answered', async() => {
    const before = fleetCounters(ACCOUNT);
    fleetHarness.respondOnce(GET_FILE, () => ({data: REPLY_BYTES}));
    fleetHarness.respondOnce(GET_LANG_PACK, () => ({data: REPLY_BYTES}));
    await callFleet(fileCall());
    await callFleet(fileCall({method: GET_LANG_PACK}));

    const after = fleetCounters(ACCOUNT);
    expect(
      {media: after.media - before.media, rpc: after.rpc - before.rpc},
      'each fleet counts the calls it answered'
    ).toEqual({media: 1, rpc: 1});
  });
});

describe('the identity a call presents decides the connection token of its pool', () => {
  beforeEach(() => {
    setFleetConfig(ACCOUNT, WITHOUT_MEDIA_OPTION);
  });

  it('a signed-out call opens a pool whose connection carries no token', async() => {
    fleetHarness.respondOnce(GET_LANG_PACK, () => ({data: REPLY_BYTES}));

    await callFleet(fileCall({method: GET_LANG_PACK, identity: ANONYMOUS}));

    expect(fleetHarness.pools[0].options.connection.getToken, 'an anonymous pool asks for no token').toBeUndefined();
    expect(fleetHarness.pools[0].options.connection.token).toBeUndefined();
    expect(fleetHarness.calls[0].presentedToken).toBeUndefined();
  });

  it('a pending call presents the pending token on its own pool, apart from the anonymous one', async() => {
    fleetHarness.respondOnce(GET_LANG_PACK, () => ({data: REPLY_BYTES}));
    fleetHarness.respondOnce(GET_PASSWORD, () => ({data: REPLY_BYTES}));

    await callFleet(fileCall({method: GET_LANG_PACK, identity: ANONYMOUS}));
    await callFleet(fileCall({method: GET_PASSWORD, identity: pendingIdentity(PENDING_TOKEN)}));

    expect(fleetHarness.calls[1].presentedToken, 'the pending challenge is the connection token of its own calls')
      .toBe(PENDING_TOKEN);
    expect(fleetHarness.pools).toHaveLength(2);
    expect(fleetHarness.pools[0].presentedToken, 'the anonymous pool keeps presenting no token').toBeUndefined();
  });

  it('a signed-in call presents the session token its identity hands out', async() => {
    fleetHarness.respondOnce(GET_LANG_PACK, () => ({data: REPLY_BYTES}));

    await callFleet(fileCall({method: GET_LANG_PACK, identity: sessionIdentity(SESSION_TOKEN)}));

    expect(fleetHarness.calls[0].presentedToken).toBe(SESSION_TOKEN);
  });

  it('a refusal of the token retires the pool it was sent on, so the next call connects again', async() => {
    fleetHarness.respondOnce(GET_PASSWORD, () => {
      throw {code: 103, message: 'AUTH_TOKEN_INVALID', appCode: 400, appType: 'AUTH_TOKEN_INVALID'};
    });

    await expect(callFleet(fileCall({method: GET_PASSWORD, identity: pendingIdentity(PENDING_TOKEN)})))
      .rejects.toMatchObject({type: 'AUTH_TOKEN_INVALID'});
    expect(fleetHarness.pools[0].close, 'a token the fleet refused must not keep its connection').toHaveBeenCalledTimes(1);
  });
});

describe('a server error is mapped by the one error mapper, and the registry codes are traced remotely', () => {
  beforeEach(() => {
    setFleetConfig(ACCOUNT, WITHOUT_MEDIA_OPTION);
  });

  it('104 METHOD_INVALID reaches the caller with its catalog type and is written to the remote trace with the method', async() => {
    fleetHarness.respondOnce(GET_LANG_PACK, () => {
      throw {code: 104, message: 'METHOD_INVALID', appCode: 400, appType: 'METHOD_INVALID'};
    });

    await expect(callFleet(fileCall({method: GET_LANG_PACK}))).rejects.toMatchObject({type: 'METHOD_INVALID', code: 400});
    expect(
      warn.mock.calls.some(([, payload]) => payload?.code === 104 && payload?.method === GET_LANG_PACK),
      'the server lacks this method: the remote trace must name it so the server can add it, and nothing is retried'
    ).toBe(true);
  });

  it('a cancelled call rejects as CANCELED and is not sent again', async() => {
    fleetHarness.respondOnce(GET_FILE, () => {
      throw {code: errorCodes.cancelled, message: 'cancelled'};
    });

    await expect(callFleet(fileCall())).rejects.toMatchObject({type: 'CANCELED'});
    expect(fleetHarness.calls).toHaveLength(1);
  });

  it('a lost connection is a typed transport error for the caller\'s normal retry, not a silent second send', async() => {
    fleetHarness.respondOnce(GET_FILE, () => {
      throw {code: errorCodes.connectionClosed, message: 'connection closed'};
    });

    await expect(callFleet(fileCall())).rejects.toMatchObject({type: 'NETWORK_BAD_RESPONSE', code: 500});
    expect(fleetHarness.calls, 'the call is not replayed over another path').toHaveLength(1);
  });
});
