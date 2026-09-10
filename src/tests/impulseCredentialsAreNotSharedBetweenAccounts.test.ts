import {beforeEach, describe, expect, it} from 'vitest';

import type {ActiveAccountNumber} from '@lib/accounts/types';
import {
  getGrpcSessionToken,
  getGrpcTransport,
  getGrpcUserId,
  setGrpcSessionToken,
  setGrpcUserId
} from '@lib/impulse/grpc/transport';


/*
 * Issue #436. The CEO: "у меня аккаунт как бы переключается, но я вижу чаты того, в который
 * впервые зашёл" -- and it happened with two accounts as well as three, so it was never about a
 * slot limit.
 *
 * The cause was that transport.ts held ONE `currentSessionToken` and ONE `currentUserId` for the
 * whole tab, and the interceptor that authenticates every outgoing call read those globals. The
 * account that wrote them last owned every request every other account made, so the UI switched
 * and the data did not.
 *
 * What makes this a real red-before rather than a restatement of the new API: the assertions below
 * are about a SECOND account's write not disturbing a FIRST account's credential. Under the old
 * single-global that is not a subtle failure -- writing account 2's token overwrote account 1's
 * outright, so reading account 1 back returned account 2's value and every assertion here fails.
 *
 * The transport-identity leg is the structural half. Two accounts must not share a transport,
 * because a shared one has a single interceptor and therefore a single answer to "whose call is
 * this" no matter how the credentials are stored.
 */

const ACCOUNT_ONE = 1 as ActiveAccountNumber;
const ACCOUNT_TWO = 2 as ActiveAccountNumber;

const CREDENTIALS_MUST_NOT_BE_SHARED =
  'A second account writing its own credential must not disturb the first account. When these ' +
  'lived in one module-level variable, the later write replaced the earlier one and every ' +
  'request from every account went out authenticated as whichever account loaded last -- which ' +
  'is why switching accounts showed the first account\'s chats (#436).';

const TRANSPORT_MUST_NOT_BE_SHARED =
  'Each account needs its own transport, because the auth interceptor is created with the ' +
  'transport and closes over one account. Two accounts sharing a transport share an interceptor, ' +
  'and a shared interceptor has exactly one answer to "whose call is this" however carefully the ' +
  'credentials themselves are separated.';


describe('gRPC credentials are per account, not per tab', () => {
  beforeEach(() => {
    for(const account of [ACCOUNT_ONE, ACCOUNT_TWO]) {
      setGrpcSessionToken(account, undefined);
      setGrpcUserId(account, undefined);
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

  it('keeps the user id with the token it belongs to', () => {
    setGrpcUserId(ACCOUNT_ONE, 'user-one');
    setGrpcSessionToken(ACCOUNT_ONE, 'token-for-account-one');
    setGrpcUserId(ACCOUNT_TWO, 'user-two');
    setGrpcSessionToken(ACCOUNT_TWO, 'token-for-account-two');

    // The pairing is the point, not the two values separately: a token for one account travelling
    // with another account's user-id header is worse than the original bug, because the server
    // would see a self-consistent-looking request that names two different people.
    expect(getGrpcUserId(ACCOUNT_ONE), CREDENTIALS_MUST_NOT_BE_SHARED).toBe('user-one');
    expect(getGrpcSessionToken(ACCOUNT_ONE), CREDENTIALS_MUST_NOT_BE_SHARED)
      .toBe('token-for-account-one');
    expect(getGrpcUserId(ACCOUNT_TWO), CREDENTIALS_MUST_NOT_BE_SHARED).toBe('user-two');
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

  it('gives each account its own transport', () => {
    expect(getGrpcTransport(ACCOUNT_ONE), TRANSPORT_MUST_NOT_BE_SHARED)
      .not.toBe(getGrpcTransport(ACCOUNT_TWO));
  });

  it('reuses the same transport for repeated calls from one account', () => {
    // The counterpart of the leg above. Separation is not achieved by handing out a fresh
    // transport per call -- that would pass the inequality test while rebuilding the interceptor
    // on every request, so this pins that the caching is real.
    expect(getGrpcTransport(ACCOUNT_ONE)).toBe(getGrpcTransport(ACCOUNT_ONE));
  });
});
