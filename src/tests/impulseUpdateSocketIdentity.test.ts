import {beforeEach, describe, expect, it, vi} from 'vitest';
import {create, toBinary} from '@bufbuild/protobuf';

import {ConfigSchema} from '@lib/impulse/grpc/gen/v1/types_pb';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import {RefreshSessionResponseSchema} from '@lib/impulse/grpc/gen/v1/internal/impulse/auth/auth_service_pb';
import {sharedFleetPoolHarness} from './helpers/fleetPoolStub';
import {sharedUpdateSocketHarness} from './helpers/updateSocketStub';
import {registerSessionIdentitySource} from './helpers/fleetIdentitySource';


const {accountGet, accountUpdate, accountClearFields} = vi.hoisted(() => ({
  accountGet: vi.fn(),
  accountUpdate: vi.fn(),
  accountClearFields: vi.fn()
}));

vi.mock('@impulsem/centrifuge/build/protobuf', async(importActual) => {
  const actual = await importActual<typeof import('@impulsem/centrifuge/build/protobuf')>();
  const {sharedFleetPoolHarness: pools} = await import('./helpers/fleetPoolStub');
  const {sharedUpdateSocketHarness: sockets} = await import('./helpers/updateSocketStub');
  return {...actual, RpcPool: pools().RpcPoolStub, Centrifuge: sockets().CentrifugeStub};
});

vi.mock('@lib/accounts/accountController', () => ({
  default: {
    get: accountGet,
    update: accountUpdate,
    clearFields: accountClearFields
  }
}));

const fleetHarness = sharedFleetPoolHarness();
const socketHarness = sharedUpdateSocketHarness();

const ACCOUNT: ActiveAccountNumber = 1;
const GET_CONFIG: string = 'help.getConfig';
const REFRESH: string = 'refreshSession';
const SESSION_TOKEN: string = 'access-jwt-first';
const RENEWED_TOKEN: string = 'access-jwt-renewed';
const REFRESH_TOKEN: string = 'refresh-token-stored';

function configReply(): {data: Uint8Array} {
  return {data: toBinary(ConfigSchema, create(ConfigSchema, {}))};
}

function signedInAccount(): void {
  accountGet.mockResolvedValue({userId: 42, impulse_session_token: SESSION_TOKEN, impulse_refresh_token: REFRESH_TOKEN});
}

beforeEach(async() => {
  vi.resetModules();
  fleetHarness.reset();
  socketHarness.reset();
  accountGet.mockReset();
  accountUpdate.mockReset();
  accountClearFields.mockReset();
  accountGet.mockResolvedValue(undefined);
  await registerSessionIdentitySource();
});

describe('the update socket follows the identity of its slot', () => {
  beforeEach(async() => {
    const {restoreImpulseSession} = await import('@lib/impulse/session');
    await restoreImpulseSession(ACCOUNT);
  });

  it('presents the access JWT of a signed-in slot on its update socket', async() => {
    signedInAccount();
    const {restoreImpulseSession} = await import('@lib/impulse/session');
    await restoreImpulseSession(ACCOUNT);
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
    socketHarness.respondOnce(GET_CONFIG, configReply);

    await grpcInvoke(GET_CONFIG, {}, ACCOUNT);

    expect(socketHarness.sockets[0].presentedToken, 'a signed-in socket presents the access JWT as its token').toBe(SESSION_TOKEN);
    expect(fleetHarness.calls, 'the token is the access JWT itself: no separate realtime token call is made').toHaveLength(0);
  });

  it('a renewed access JWT replaces the refused one without reconnecting the socket', async() => {
    signedInAccount();
    const {restoreImpulseSession} = await import('@lib/impulse/session');
    await restoreImpulseSession(ACCOUNT);
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
    socketHarness.respondOnce(GET_CONFIG, () => {
      throw {code: 109, message: 'token expired'};
    });
    socketHarness.respondOnce(GET_CONFIG, configReply);
    fleetHarness.respond(REFRESH, () => ({
      data: toBinary(RefreshSessionResponseSchema, create(RefreshSessionResponseSchema, {sessionToken: RENEWED_TOKEN, refreshToken: 'refresh-next'}))
    }));

    await grpcInvoke(GET_CONFIG, {}, ACCOUNT);

    expect(
      socketHarness.calls.map((call) => call.method),
      'the refused call is renewed once through the refresh, then replayed'
    ).toEqual([GET_CONFIG, GET_CONFIG]);
    expect(fleetHarness.calls.map((call) => call.method), 'the renewal is the one refresh call').toEqual([REFRESH]);
    expect(
      await socketHarness.sockets[0].options.getToken(),
      'the next native refresh presents the renewed token on the same socket'
    ).toBe(RENEWED_TOKEN);
  });
});

describe('a call never moves the update socket to another identity', () => {
  beforeEach(async() => {
    signedInAccount();
    const {restoreImpulseSession} = await import('@lib/impulse/session');
    await restoreImpulseSession(ACCOUNT);
  });

  it('a call is answered by the slot\'s socket and leaves that socket in place', async() => {
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
    const {callUpdateSocket} = await import('@lib/impulse/realtime');
    socketHarness.respondOnce(GET_CONFIG, configReply);
    await grpcInvoke(GET_CONFIG, {}, ACCOUNT);
    socketHarness.respondOnce(GET_CONFIG, configReply);

    await callUpdateSocket({accountNumber: ACCOUNT, method: GET_CONFIG, request: new Uint8Array(0)});

    expect(
      socketHarness.sockets,
      'a call must not open a socket that replaces the slot\'s own one'
    ).toHaveLength(1);
    expect(socketHarness.sockets[0].disconnected, 'the slot\'s socket stays connected').toBe(false);
    expect(socketHarness.calls[1].presentedToken, 'the call goes out on the slot\'s socket, which presents the session').toBe(SESSION_TOKEN);
  });

  it('a call on a slot with no socket opens it under the identity the slot holds', async() => {
    const {callUpdateSocket} = await import('@lib/impulse/realtime');
    socketHarness.respondOnce(GET_CONFIG, configReply);

    await callUpdateSocket({accountNumber: ACCOUNT, method: GET_CONFIG, request: new Uint8Array(0)});

    expect(socketHarness.sockets, 'the call opens the socket of its slot').toHaveLength(1);
    expect(
      socketHarness.sockets[0].presentedToken,
      'the socket opened by a call presents the session token the slot holds, found from the registered identity source'
    ).toBe(SESSION_TOKEN);
  });
});
