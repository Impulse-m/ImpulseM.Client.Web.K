import {beforeEach, expect, it, vi} from 'vitest';

import type {ActiveAccountNumber} from '@lib/accounts/types';


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

beforeEach(() => {
  vi.resetModules();
  accountGet.mockReset();
  accountUpdate.mockReset();
  accountClearFields.mockReset();
  accountUpdate.mockResolvedValue(undefined);
  accountClearFields.mockRejectedValue(STORAGE_FAILURE);
});

it('rejects clearImpulseSession when session-token storage cannot be cleared', async() => {
  const {clearImpulseSession} = await import('@lib/impulse/session');
  await expect(clearImpulseSession(ACCOUNT)).rejects.toBe(STORAGE_FAILURE);
});
