import {beforeEach, describe, expect, it, vi} from 'vitest';
import {create, toBinary} from '@bufbuild/protobuf';

import {ConfigSchema} from '@lib/impulse/grpc/gen/v1/types_pb';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import {AuthorizationSchema} from '@lib/impulse/grpc/gen/v1/internal/impulse/auth/auth_types_pb';
import {sharedFleetPoolHarness} from './helpers/fleetPoolStub';
import {sharedUpdateSocketHarness} from './helpers/updateSocketStub';

/*
 * The identity of the update socket follows the session of its slot: no token while signed out, the pending 2FA token
 * while a challenge is pending, the access JWT while signed in. A change of identity reconnects the socket.
 */

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
const GET_PASSWORD: string = 'account.getPassword';
const REFRESH: string = 'impulse.auth.refreshSession';
const SESSION_TOKEN: string = 'access-jwt-first';
const RENEWED_TOKEN: string = 'access-jwt-renewed';
const REFRESH_TOKEN: string = 'refresh-token-stored';
const PENDING_TOKEN: string = 'pending-token-fixture';

function configReply(): {data: Uint8Array} {
  return {data: toBinary(ConfigSchema, create(ConfigSchema, {}))};
}

function signedInAccount(): void {
  accountGet.mockResolvedValue({userId: 42, impulse_session_token: SESSION_TOKEN, impulse_refresh_token: REFRESH_TOKEN});
}

beforeEach(() => {
  vi.resetModules();
  fleetHarness.reset();
  socketHarness.reset();
  accountGet.mockReset();
  accountUpdate.mockReset();
  accountClearFields.mockReset();
  accountGet.mockResolvedValue(undefined);
});

describe('the update socket of a signed-out slot', () => {
  it('connects with no token and no getToken, so only anonymous methods are answered', async() => {
    const {restoreImpulseSession} = await import('@lib/impulse/session');
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
    await restoreImpulseSession(ACCOUNT);
    socketHarness.respondOnce(GET_CONFIG, configReply);

    await grpcInvoke(GET_CONFIG, {}, ACCOUNT);

    expect(socketHarness.sockets, 'a signed-out call opens the update socket of its slot').toHaveLength(1);
    expect(socketHarness.sockets[0].options.getToken, 'an anonymous socket asks for no token').toBeNull();
    expect(socketHarness.sockets[0].presentedToken, 'an anonymous socket presents no token').toBeUndefined();
  });
});

describe('the update socket follows the identity of its slot', () => {
  beforeEach(async() => {
    const {restoreImpulseSession} = await import('@lib/impulse/session');
    await restoreImpulseSession(ACCOUNT);
  });

  it('reconnects with the pending token once SESSION_PASSWORD_NEEDED hands the slot a pending 2FA challenge', async() => {
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
    socketHarness.respondOnce(GET_CONFIG, configReply);
    socketHarness.respondOnce('auth.signIn', () => {
      throw {
        code: 100,
        message: 'SESSION_PASSWORD_NEEDED',
        appCode: 401,
        appType: 'SESSION_PASSWORD_NEEDED',
        metadata: {'pending-token': PENDING_TOKEN}
      };
    });
    socketHarness.respondOnce(GET_PASSWORD, () => ({data: new Uint8Array(0)}));

    await grpcInvoke(GET_CONFIG, {}, ACCOUNT);
    await grpcInvoke('auth.signIn', {phone_number: '+9996611111', phone_code_hash: 'h', phone_code: '1'}, ACCOUNT).catch(() => {});
    await grpcInvoke(GET_PASSWORD, {}, ACCOUNT);

    expect(socketHarness.sockets.length, 'the pending challenge replaces the anonymous socket').toBe(2);
    expect(socketHarness.sockets[1].presentedToken, 'the pending socket presents the pending token').toBe(PENDING_TOKEN);
    expect(socketHarness.sockets[0].disconnected, 'the anonymous socket is retired').toBe(true);
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

  it('reconnects anonymously when the slot signs out', async() => {
    signedInAccount();
    const {restoreImpulseSession, clearImpulseSession} = await import('@lib/impulse/session');
    await restoreImpulseSession(ACCOUNT);
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
    socketHarness.respondOnce(GET_CONFIG, configReply);
    socketHarness.respondOnce(GET_CONFIG, configReply);
    await grpcInvoke(GET_CONFIG, {}, ACCOUNT);

    await clearImpulseSession(ACCOUNT);
    await grpcInvoke(GET_CONFIG, {}, ACCOUNT);

    expect(socketHarness.sockets[0].disconnected, 'the signed-in socket is closed once the session ends').toBe(true);
    expect(socketHarness.sockets[1].presentedToken, 'the socket after sign-out presents no token').toBeUndefined();
  });

  it('a renewed access JWT replaces the refused one: the call is replayed on a socket that presents the renewal', async() => {
    signedInAccount();
    const {restoreImpulseSession} = await import('@lib/impulse/session');
    await restoreImpulseSession(ACCOUNT);
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
    socketHarness.respondOnce(GET_CONFIG, () => {
      throw {code: 109, message: 'token expired'};
    });
    socketHarness.respondOnce(GET_CONFIG, configReply);
    fleetHarness.respond(REFRESH, () => ({
      data: toBinary(AuthorizationSchema, create(AuthorizationSchema, {sessionToken: RENEWED_TOKEN, refreshToken: 'refresh-next'}))
    }));

    await grpcInvoke(GET_CONFIG, {}, ACCOUNT);

    expect(
      socketHarness.calls.map((call) => call.method),
      'the refused call is renewed once through the refresh, then replayed'
    ).toEqual([GET_CONFIG, GET_CONFIG]);
    expect(fleetHarness.calls.map((call) => call.method), 'the renewal is the one refresh call').toEqual([REFRESH]);
    expect(
      socketHarness.calls[1].presentedToken,
      'the replay must present the renewed token, not the refused one'
    ).toBe(RENEWED_TOKEN);
  });
});

describe('a call never moves the update socket to another identity', () => {
  beforeEach(async() => {
    signedInAccount();
    const {restoreImpulseSession} = await import('@lib/impulse/session');
    await restoreImpulseSession(ACCOUNT);
  });

  it('a call carrying another identity is answered by the slot\'s socket and leaves that socket in place', async() => {
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
    const {callUpdateSocket} = await import('@lib/impulse/realtime');
    const {ANONYMOUS_IDENTITY} = await import('@lib/impulse/fleet/fleet');
    socketHarness.respondOnce(GET_CONFIG, configReply);
    await grpcInvoke(GET_CONFIG, {}, ACCOUNT);
    socketHarness.respondOnce(GET_CONFIG, configReply);

    await callUpdateSocket({accountNumber: ACCOUNT, identity: ANONYMOUS_IDENTITY, method: GET_CONFIG, request: new Uint8Array(0)});

    expect(
      socketHarness.sockets,
      'a call of another identity must not open a socket that replaces the slot\'s own one'
    ).toHaveLength(1);
    expect(socketHarness.sockets[0].disconnected, 'the slot\'s socket stays connected').toBe(false);
    expect(socketHarness.calls[1].presentedToken, 'the call goes out on the slot\'s socket, which presents the session').toBe(SESSION_TOKEN);
  });
});
