import {beforeEach, describe, expect, it, vi} from 'vitest';
import {create, toBinary} from '@bufbuild/protobuf';
import {UnauthorizedError} from '@impulsem/centrifuge/build/protobuf';

import {AuthorizationSchema} from '@lib/impulse/grpc/gen/v1/internal/impulse/auth/auth_types_pb';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import {REFRESH_SESSION_METHOD} from '@lib/impulse/fleet/fleetRoute';
import {sharedFleetPoolHarness} from './helpers/fleetPoolStub';

const {accountGet, accountUpdate, accountClearFields} = vi.hoisted(() => ({
  accountGet: vi.fn(),
  accountUpdate: vi.fn(),
  accountClearFields: vi.fn()
}));

vi.mock('@impulsem/centrifuge/build/protobuf', async(importActual) => {
  const actual = await importActual<typeof import('@impulsem/centrifuge/build/protobuf')>();
  const {sharedFleetPoolHarness} = await import('./helpers/fleetPoolStub');
  return {...actual, RpcPool: sharedFleetPoolHarness().RpcPoolStub};
});

vi.mock('@lib/accounts/accountController', () => ({
  default: {
    get: accountGet,
    update: accountUpdate,
    clearFields: accountClearFields
  }
}));


const fleetHarness = sharedFleetPoolHarness();

const ACCOUNT: ActiveAccountNumber = 1;
const SIGNED_IN_TOKEN: string = 'access-token-first';
const RENEWED_TOKEN: string = 'access-token-renewed';
const REFRESH_TOKEN: string = 'refresh-token-stored';
const PENDING_TOKEN: string = 'pending-token-fixture';
const LANG_PACK: string = 'langpack.getLangPack';
const GET_PASSWORD: string = 'account.getPassword';
const SEND_CODE: string = 'auth.sendCode';

function refreshedAuthorization(sessionToken: string): Uint8Array {
  return toBinary(AuthorizationSchema, create(AuthorizationSchema, {
    sessionToken,
    refreshToken: REFRESH_TOKEN
  }));
}

async function identityOf(method: string) {
  const {fleetIdentityFor} = await import('@lib/impulse/session');
  return fleetIdentityFor(ACCOUNT, method);
}

beforeEach(async() => {
  vi.resetModules();
  fleetHarness.reset();
  accountGet.mockReset();
  accountUpdate.mockReset();
  accountClearFields.mockReset();
  accountGet.mockResolvedValue(undefined);
});

describe('the identity a signed-out client presents', () => {
  it('is anonymous for every method, so no token travels', async() => {
    expect((await identityOf(SEND_CODE)).kind, 'a signed-out client sends its codes without a token').toBe('anonymous');
    expect((await identityOf(LANG_PACK)).getToken).toBeUndefined();
  });

  it('is the pending challenge only for the five methods that accept one, and anonymous for every other', async() => {
    const {setGrpcPendingToken} = await import('@lib/impulse/grpc/credentials');
    setGrpcPendingToken(ACCOUNT, PENDING_TOKEN);

    const pending = await identityOf(GET_PASSWORD);
    expect(pending.kind, 'account.getPassword is pending-scoped: the challenge is its connection token').toBe('pending');
    await expect(pending.getToken?.()).resolves.toBe(PENDING_TOKEN);

    expect(
      (await identityOf(LANG_PACK)).kind,
      'a pending challenge must not widen what an unauthenticated connection can call'
    ).toBe('anonymous');
  });
});

describe('the identity of a signed-in client', () => {
  beforeEach(async() => {
    const {restoreImpulseSession} = await import('@lib/impulse/session');
    accountGet.mockResolvedValue({userId: 42, impulse_session_token: SIGNED_IN_TOKEN, impulse_refresh_token: REFRESH_TOKEN});
    await restoreImpulseSession(ACCOUNT);
  });

  it('is the session for every method, and anonymous for the refresh that renews it', async() => {
    expect((await identityOf(LANG_PACK)).kind).toBe('session');
    expect(
      (await identityOf(REFRESH_SESSION_METHOD)).kind,
      'the refresh carries its refresh token in the body and must not wait for the access token it replaces'
    ).toBe('anonymous');
  });

  it('hands out the session token as it stands the first time the SDK asks', async() => {
    const identity = await identityOf(LANG_PACK);

    await expect(identity.getToken?.()).resolves.toBe(SIGNED_IN_TOKEN);
    expect(fleetHarness.calls, 'a token nobody has refused costs no session refresh').toHaveLength(0);
  });

  it('is renewed through the refresh when the SDK asks again for the token it holds', async() => {
    const identity = await identityOf(LANG_PACK);
    await identity.getToken?.();
    fleetHarness.respond('impulse.auth.refreshSession', () => ({data: refreshedAuthorization(RENEWED_TOKEN)}));

    await expect(
      identity.getToken?.(),
      'the SDK asks again for a token it holds only after the fleet refused it: that token is renewed'
    ).resolves.toBe(RENEWED_TOKEN);
    expect(fleetHarness.calls.map((call) => call.method)).toEqual(['impulse.auth.refreshSession']);
  });

  it('a failed renewal is a retryable error, not a refusal that stops the connection', async() => {
    const identity = await identityOf(LANG_PACK);
    await identity.getToken?.();
    fleetHarness.respond('impulse.auth.refreshSession', () => {
      throw {code: 100, message: 'INTERNAL_SERVER_ERROR', appCode: 500, appType: 'INTERNAL_SERVER_ERROR'};
    });

    const failure: unknown = await identity.getToken?.().then(
      (): undefined => undefined,
      (error: unknown): unknown => error
    );

    expect(failure, 'the fleet must keep retrying a transient renewal failure').toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(UnauthorizedError);
  });

  it('is refused with the SDK\'s UnauthorizedError once the session has ended', async() => {
    const identity = await identityOf(LANG_PACK);
    const {clearImpulseSession} = await import('@lib/impulse/session');
    await clearImpulseSession(ACCOUNT);

    await expect(identity.getToken?.()).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
