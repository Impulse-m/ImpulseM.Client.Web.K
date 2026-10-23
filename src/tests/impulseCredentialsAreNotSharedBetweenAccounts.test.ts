import {beforeEach, describe, expect, it, vi} from 'vitest';

import type {ActiveAccountNumber} from '@lib/accounts/types';
import {getGrpcSessionToken, setGrpcSessionToken} from '@lib/impulse/grpc/credentials';
import {callFleet, resetFleetIdentity} from '@lib/impulse/fleet/fleet';
import {fleetIdentityFor, restoreImpulseSession} from '@lib/impulse/session';

import {sharedFleetPoolHarness} from './helpers/fleetPoolStub';


/*
 * Issue #436. The CEO: "у меня аккаунт как бы переключается, но я вижу чаты того, в который
 * впервые зашёл" -- and it happened with two accounts as well as three, so it was never about a
 * slot limit.
 *
 * The cause was that the credentials of the tab lived in ONE module-level variable pair, and the
 * request that authenticates every outgoing call read those globals. The account that wrote them
 * last owned every request every other account made, so the UI switched and the data did not.
 *
 * What makes this a real red-before rather than a restatement of the new API: the assertions below
 * are about a SECOND account's write not disturbing a FIRST account's credential, and about each
 * account's connections presenting its own token.
 */

const fleetHarness = sharedFleetPoolHarness();

vi.mock('@impulsem/centrifuge/build/protobuf', async(importActual) => {
  const actual = await importActual<typeof import('@impulsem/centrifuge/build/protobuf')>();
  const {sharedFleetPoolHarness: harness} = await import('./helpers/fleetPoolStub');
  return {...actual, RpcPool: harness().RpcPoolStub};
});

vi.mock('@lib/accounts/accountController', () => ({
  default: {
    get: vi.fn(),
    update: vi.fn(),
    clearFields: vi.fn()
  }
}));

const ACCOUNT_ONE = 1 as ActiveAccountNumber;
const ACCOUNT_TWO = 2 as ActiveAccountNumber;
const ACCOUNT_THREE = 3 as ActiveAccountNumber;
const LANG_PACK = 'langpack.getLangPack';

const CREDENTIALS_MUST_NOT_BE_SHARED =
  'A second account writing its own credential must not disturb the first account. When these ' +
  'lived in one module-level variable, the later write replaced the earlier one and every ' +
  'request from every account went out authenticated as whichever account loaded last -- which ' +
  'is why switching accounts showed the first account\'s chats (#436).';

const CONNECTIONS_MUST_NOT_BE_SHARED =
  'Each account needs its own connections: a pool shared by two accounts presents one token to ' +
  'both, however carefully the credentials themselves are separated.';


describe('session credentials are per account, not per tab', () => {
  beforeEach(async() => {
    fleetHarness.reset();
    // The boot opens every slot's gate before any call of the slot leaves.
    await Promise.all([ACCOUNT_ONE, ACCOUNT_TWO, ACCOUNT_THREE].map((account) => restoreImpulseSession(account)));
    resetFleetIdentity(ACCOUNT_ONE);
    resetFleetIdentity(ACCOUNT_TWO);
    resetFleetIdentity(ACCOUNT_THREE);
    for(const account of [ACCOUNT_ONE, ACCOUNT_TWO, ACCOUNT_THREE]) {
      setGrpcSessionToken(account, undefined);
    }
  });

  it('keeps one account\'s session token when another account signs in', () => {
    setGrpcSessionToken(ACCOUNT_ONE, 'token-for-account-one');
    setGrpcSessionToken(ACCOUNT_TWO, 'token-for-account-two');

    expect(getGrpcSessionToken(ACCOUNT_ONE), CREDENTIALS_MUST_NOT_BE_SHARED)
      .toBe('token-for-account-one');
    expect(getGrpcSessionToken(ACCOUNT_TWO), CREDENTIALS_MUST_NOT_BE_SHARED)
      .toBe('token-for-account-two');
  });

  it('signing one account out leaves the other signed in', () => {
    setGrpcSessionToken(ACCOUNT_ONE, 'token-for-account-one');
    setGrpcSessionToken(ACCOUNT_TWO, 'token-for-account-two');

    setGrpcSessionToken(ACCOUNT_TWO, undefined);

    expect(getGrpcSessionToken(ACCOUNT_ONE), CREDENTIALS_MUST_NOT_BE_SHARED)
      .toBe('token-for-account-one');
    expect(getGrpcSessionToken(ACCOUNT_TWO), CREDENTIALS_MUST_NOT_BE_SHARED).toBeUndefined();
  });

  it('gives each account its own connections, each presenting its own token', async() => {
    setGrpcSessionToken(ACCOUNT_ONE, 'token-for-account-one');
    setGrpcSessionToken(ACCOUNT_TWO, 'token-for-account-two');
    fleetHarness.respondOnce(LANG_PACK, () => ({data: new Uint8Array(0)}));
    fleetHarness.respondOnce(LANG_PACK, () => ({data: new Uint8Array(0)}));

    await callFleet({accountNumber: ACCOUNT_ONE, method: LANG_PACK, identity: fleetIdentityFor(ACCOUNT_ONE, LANG_PACK), request: new Uint8Array(0)});
    await callFleet({accountNumber: ACCOUNT_TWO, method: LANG_PACK, identity: fleetIdentityFor(ACCOUNT_TWO, LANG_PACK), request: new Uint8Array(0)});

    expect(fleetHarness.pools, CONNECTIONS_MUST_NOT_BE_SHARED).toHaveLength(2);
    expect(fleetHarness.calls.map((call) => call.presentedToken)).toEqual(['token-for-account-one', 'token-for-account-two']);
  });

  it('reuses the same connections for repeated calls from one account', async() => {
    setGrpcSessionToken(ACCOUNT_THREE, 'token-for-account-three');
    fleetHarness.respondOnce(LANG_PACK, () => ({data: new Uint8Array(0)}));
    fleetHarness.respondOnce(LANG_PACK, () => ({data: new Uint8Array(0)}));

    await callFleet({accountNumber: ACCOUNT_THREE, method: LANG_PACK, identity: fleetIdentityFor(ACCOUNT_THREE, LANG_PACK), request: new Uint8Array(0)});
    await callFleet({accountNumber: ACCOUNT_THREE, method: LANG_PACK, identity: fleetIdentityFor(ACCOUNT_THREE, LANG_PACK), request: new Uint8Array(0)});

    expect(
      fleetHarness.pools,
      'separation is not achieved by a fresh pool per call: the connections of one account are reused'
    ).toHaveLength(1);
  });
});
