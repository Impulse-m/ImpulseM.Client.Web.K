import {beforeEach, describe, expect, it, vi} from 'vitest';

import type {ActiveAccountNumber} from '@lib/accounts/types';

/*
 * The pending 2FA token is cleared in storage by three paths: a dropped challenge, a session that replaces it, and a sign-out.
 * A storage failure on that clear must reach the caller of each path, so the persisted challenge is never left behind silently.
 */

const {accountGet, accountUpdate, accountClearFields} = vi.hoisted(() => ({
  accountGet: vi.fn(),
  accountUpdate: vi.fn(),
  accountClearFields: vi.fn()
}));

vi.mock('@lib/accounts/accountController', () => ({
  default: {
    get: accountGet,
    update: accountUpdate,
    clearFields: accountClearFields
  }
}));

const ACCOUNT: ActiveAccountNumber = 1;
const STORAGE_FAILURE: Error = new Error('storage unavailable');
const SESSION_RESULT = {session_token: 'access-jwt', refresh_token: 'refresh-token'};

beforeEach(() => {
  vi.resetModules();
  accountGet.mockReset();
  accountUpdate.mockReset();
  accountClearFields.mockReset();
  accountUpdate.mockResolvedValue(undefined);
  accountClearFields.mockRejectedValue(STORAGE_FAILURE);
});

describe('a storage failure on the clear of the pending token', () => {
  it('rejects clearPendingToken, so a dropped challenge that stays persisted is reported', async() => {
    const {clearPendingToken} = await import('@lib/impulse/session');

    await expect(
      clearPendingToken(ACCOUNT),
      'the failed clear must reject: a challenge left in storage must not be dropped in silence'
    ).rejects.toBe(STORAGE_FAILURE);
  });

  it('rejects captureImpulseSessionToken, so a session that replaces the challenge reports its failed clear', async() => {
    const {captureImpulseSessionToken} = await import('@lib/impulse/session');

    await expect(
      captureImpulseSessionToken(ACCOUNT, SESSION_RESULT),
      'the sign-in must not report success while the pending challenge it replaces is still persisted'
    ).rejects.toBe(STORAGE_FAILURE);
  });

  it('rejects clearImpulseSession, so a sign-out reports the failed clear', async() => {
    const {clearImpulseSession} = await import('@lib/impulse/session');

    await expect(
      clearImpulseSession(ACCOUNT),
      'the sign-out must not report success while the pending challenge is still persisted'
    ).rejects.toBe(STORAGE_FAILURE);
  });
});

describe('a storage failure on the write of a new pending token', () => {
  it('rejects capturePendingToken, so a challenge that is not persisted is reported to its caller', async() => {
    const {capturePendingToken} = await import('@lib/impulse/session');
    accountUpdate.mockRejectedValue(STORAGE_FAILURE);

    await expect(
      capturePendingToken(ACCOUNT, 'fixture-pending-token'),
      'a challenge that did not reach storage must be reported, not held in silence until a reload loses it'
    ).rejects.toBe(STORAGE_FAILURE);
  });
});
