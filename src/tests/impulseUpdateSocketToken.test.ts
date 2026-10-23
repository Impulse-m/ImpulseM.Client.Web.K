import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {create, toBinary} from '@bufbuild/protobuf';
import {UnauthorizedError} from '@impulsem/centrifuge/build/protobuf';

import type {ActiveAccountNumber} from '@lib/accounts/types';
import {AuthorizationSchema} from '@lib/impulse/grpc/gen/v1/internal/impulse/auth/auth_types_pb';
import {sharedFleetPoolHarness} from './helpers/fleetPoolStub';
import {sharedUpdateSocketHarness} from './helpers/updateSocketStub';

/*
 * One credential. The update socket connects with the access JWT the Auth service returned, and its getToken hands out
 * that same JWT. The SDK asks again only after the server refused the token it holds, and then the token is renewed
 * through the refresh. A refused session ends the connection; a failed renewal in transit is retried.
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
const SESSION_TOKEN: string = 'access-jwt-first';
const RENEWED_TOKEN: string = 'access-jwt-renewed';
const REFRESH_TOKEN: string = 'refresh-token-stored';
const REFRESH: string = 'impulse.auth.refreshSession';
const UNAUTHORIZED_MUST_STOP_THE_SOCKET: string =
  'getToken must throw the SDK\'s UnauthorizedError on a refused session: any other error is retried forever';

function renewedAuthorization(): Uint8Array {
  return toBinary(AuthorizationSchema, create(AuthorizationSchema, {sessionToken: RENEWED_TOKEN, refreshToken: 'refresh-next'}));
}

async function identity() {
  const {fleetIdentityFor} = await import('@lib/impulse/session');
  return fleetIdentityFor(ACCOUNT);
}

beforeEach(async() => {
  vi.resetModules();
  fleetHarness.reset();
  socketHarness.reset();
  accountGet.mockReset();
  accountUpdate.mockReset();
  accountClearFields.mockReset();
  accountGet.mockResolvedValue({userId: 42, impulse_session_token: SESSION_TOKEN, impulse_refresh_token: REFRESH_TOKEN});
  const {restoreImpulseSession} = await import('@lib/impulse/session');
  await restoreImpulseSession(ACCOUNT);
});

afterEach(async() => {
  const realtime = await import('@lib/impulse/realtime');
  ([1, 2, 3, 4] as ActiveAccountNumber[]).forEach((accountNumber) => realtime.stopImpulseRealtime(accountNumber));
});

describe('the update socket connects with the access JWT, and gets no token of its own', () => {
  it('starts with the access JWT and asks no separate realtime token of the fleet', async() => {
    const realtime = await import('@lib/impulse/realtime');

    realtime.startImpulseRealtime('42', ACCOUNT, await identity());

    await vi.waitFor(() => expect(socketHarness.sockets, 'signing in opens the update socket').toHaveLength(1));
    await vi.waitFor(() => expect(socketHarness.sockets[0].presentedToken).toBe(SESSION_TOKEN));
    expect(fleetHarness.calls, 'the token is the access JWT: the realtime token call of the past is gone').toHaveLength(0);
  });

  it('hands the SDK the access JWT the first time it asks', async() => {
    await expect((await identity()).getToken?.()).resolves.toBe(SESSION_TOKEN);
    expect(fleetHarness.calls, 'a token nobody has refused costs no renewal').toHaveLength(0);
  });

  it('renews the access JWT through the refresh when the SDK asks again for the one it holds', async() => {
    const current = await identity();
    await current.getToken?.();
    fleetHarness.respond(REFRESH, () => ({data: renewedAuthorization()}));

    await expect(current.getToken?.()).resolves.toBe(RENEWED_TOKEN);
    expect(fleetHarness.calls.map((call) => call.method)).toEqual([REFRESH]);
  });

  it('a refused renewal ends the connection with UnauthorizedError', async() => {
    const current = await identity();
    await current.getToken?.();
    fleetHarness.respond(REFRESH, () => {
      throw {code: 401, message: 'AUTH_KEY_UNREGISTERED', appCode: 401, appType: 'AUTH_KEY_UNREGISTERED'};
    });

    await expect(current.getToken?.(), UNAUTHORIZED_MUST_STOP_THE_SOCKET).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('a renewal that fails in transit stays retryable, not a refusal', async() => {
    const current = await identity();
    await current.getToken?.();
    fleetHarness.respond(REFRESH, () => {
      throw {code: 100, message: 'INTERNAL_SERVER_ERROR', appCode: 500, appType: 'INTERNAL_SERVER_ERROR'};
    });

    const failure: unknown = await current.getToken?.().then((): undefined => undefined, (error: unknown): unknown => error);

    expect(failure, 'the fleet must keep retrying a transient renewal failure').toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(UnauthorizedError);
  });

  it('is refused with UnauthorizedError once the session has ended', async() => {
    const current = await identity();
    const {clearImpulseSession} = await import('@lib/impulse/session');
    await clearImpulseSession(ACCOUNT);

    await expect(current.getToken?.()).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
