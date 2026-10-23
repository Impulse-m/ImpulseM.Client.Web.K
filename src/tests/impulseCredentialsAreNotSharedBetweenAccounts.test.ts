import {beforeEach, describe, expect, it, vi} from 'vitest';

import type {ActiveAccountNumber} from '@lib/accounts/types';
import {getGrpcSessionToken, setGrpcSessionToken} from '@lib/impulse/grpc/credentials';
import {resetFleetIdentity} from '@lib/impulse/fleet/fleet';
import {restoreImpulseSession} from '@lib/impulse/session';
import {grpcInvoke} from '@lib/impulse/grpc/adapter';

import {sharedUpdateSocketHarness} from './helpers/updateSocketStub';


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
 * account's update socket presenting its own token.
 */

const socketHarness = sharedUpdateSocketHarness();

vi.mock('@impulsem/centrifuge/build/protobuf', async(importActual) => {
  const actual = await importActual<typeof import('@impulsem/centrifuge/build/protobuf')>();
  const {sharedUpdateSocketHarness: harness} = await import('./helpers/updateSocketStub');
  return {...actual, Centrifuge: harness().CentrifugeStub};
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
const LANG_PACK_PARAMS = {langPack: 'web', langCode: 'en'};

const CREDENTIALS_MUST_NOT_BE_SHARED =
  'A second account writing its own credential must not disturb the first account. When these ' +
  'lived in one module-level variable, the later write replaced the earlier one and every ' +
  'request from every account went out authenticated as whichever account loaded last -- which ' +
  'is why switching accounts showed the first account\'s chats (#436).';

const CONNECTIONS_MUST_NOT_BE_SHARED =
  'Each account needs its own update socket: one socket shared by two accounts presents one token to ' +
  'both, however carefully the credentials themselves are separated.';


describe('session credentials are per account, not per tab', () => {
  beforeEach(async() => {
    socketHarness.reset();
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

  it('gives each account its own update socket, each presenting its own token', async() => {
    setGrpcSessionToken(ACCOUNT_ONE, 'token-for-account-one');
    setGrpcSessionToken(ACCOUNT_TWO, 'token-for-account-two');
    socketHarness.respondOnce(LANG_PACK, () => ({data: new Uint8Array(0)}));
    socketHarness.respondOnce(LANG_PACK, () => ({data: new Uint8Array(0)}));

    await grpcInvoke(LANG_PACK, LANG_PACK_PARAMS, ACCOUNT_ONE);
    await grpcInvoke(LANG_PACK, LANG_PACK_PARAMS, ACCOUNT_TWO);

    expect(socketHarness.sockets, CONNECTIONS_MUST_NOT_BE_SHARED).toHaveLength(2);
    expect(socketHarness.calls.map((call) => call.presentedToken)).toEqual(['token-for-account-one', 'token-for-account-two']);
  });

  it('reuses the same update socket for repeated calls from one account', async() => {
    setGrpcSessionToken(ACCOUNT_THREE, 'token-for-account-three');
    socketHarness.respondOnce(LANG_PACK, () => ({data: new Uint8Array(0)}));
    socketHarness.respondOnce(LANG_PACK, () => ({data: new Uint8Array(0)}));

    await grpcInvoke(LANG_PACK, LANG_PACK_PARAMS, ACCOUNT_THREE);
    await grpcInvoke(LANG_PACK, LANG_PACK_PARAMS, ACCOUNT_THREE);

    expect(
      socketHarness.sockets,
      'separation is not achieved by a fresh socket per call: the socket of one account is reused'
    ).toHaveLength(1);
  });
});
