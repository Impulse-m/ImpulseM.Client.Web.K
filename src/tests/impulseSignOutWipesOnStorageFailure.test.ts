import {beforeEach, describe, expect, it, vi} from 'vitest';

import type {ActiveAccountNumber} from '@lib/accounts/types';

/*
 * The local credentials of a slot are destroyed whatever the storage answers (.demo/tdlib/td/telegram/AuthManager.cpp:1352-1364).
 * A failed storage clear is rethrown to the caller after the local wipe.
 */

const {accountGet, accountUpdate, accountClearFields, accountTotal, accountShift, storageShift, passcodeUsed} = vi.hoisted(() => ({
  accountGet: vi.fn(),
  accountUpdate: vi.fn(),
  accountClearFields: vi.fn(),
  accountTotal: vi.fn(),
  accountShift: vi.fn(),
  storageShift: vi.fn(),
  passcodeUsed: vi.fn()
}));

vi.mock('@lib/accounts/accountController', () => ({
  default: {
    get: accountGet,
    update: accountUpdate,
    clearFields: accountClearFields,
    getTotalAccounts: accountTotal,
    shiftAccounts: accountShift
  }
}));

vi.mock('@appManagers/appStoragesManager', () => ({
  AppStoragesManager: {shiftStorages: storageShift}
}));

vi.mock('@lib/passcode/deferredIsUsingPasscode', () => ({
  default: {isUsingPasscode: passcodeUsed, resolveDeferred: vi.fn()}
}));

const ACCOUNT: ActiveAccountNumber = 2;
const TOTAL_ACCOUNTS: number = 2;
const SESSION_TOKEN: string = 'access-jwt-signed-in';
const STORAGE_FAILURE: Error = new Error('storage unavailable');

type SignedInManager = {
  logOut(): Promise<void>,
  rootScope: {dispatchEvent: ReturnType<typeof vi.fn>}
};

/** An ApiManager of the real prototype, with the collaborators a sign-out of the slot reaches. */
async function signedInManager(): Promise<SignedInManager> {
  const {ApiManager} = await import('@appManagers/apiManager');
  return Object.assign(Object.create(ApiManager.prototype), {
    getAccountNumber: (): ActiveAccountNumber => ACCOUNT,
    invokeApi: vi.fn(async(): Promise<void> => undefined),
    rootScope: {dispatchEvent: vi.fn()}
  });
}

beforeEach(() => {
  vi.resetModules();
  accountGet.mockReset();
  accountUpdate.mockReset();
  accountClearFields.mockReset();
  accountTotal.mockReset();
  accountShift.mockReset();
  storageShift.mockReset();
  passcodeUsed.mockReset();
  accountGet.mockResolvedValue({});
  accountTotal.mockResolvedValue(TOTAL_ACCOUNTS);
  accountShift.mockResolvedValue(undefined);
  storageShift.mockResolvedValue(undefined);
  passcodeUsed.mockResolvedValue(false);
  accountUpdate.mockResolvedValue(undefined);
  accountClearFields.mockResolvedValue(undefined);
});

describe('the credential clear of a sign-out reports its storage failure', () => {
  it('drops the session in memory, runs the local wipe, and rejects logOut with the failure', async() => {
    const {setGrpcSessionToken, getGrpcSessionToken} = await import('@lib/impulse/grpc/credentials');
    setGrpcSessionToken(ACCOUNT, SESSION_TOKEN);
    accountClearFields.mockRejectedValue(STORAGE_FAILURE);
    const manager: SignedInManager = await signedInManager();

    await expect(
      manager.logOut(),
      'a failed credential clear must reject the sign-out, not return as if the slot were signed out'
    ).rejects.toBe(STORAGE_FAILURE);
    expect(getGrpcSessionToken(ACCOUNT), 'the session is dropped in memory whatever the storage answered').toBeUndefined();
    expect(
      manager.rootScope.dispatchEvent,
      'the local wipe still runs after the failed clear: it announces the logout of the slot'
    ).toHaveBeenCalledWith('logging_out', expect.objectContaining({accountNumber: ACCOUNT}));
  });

  it('a sign-out retried after that failure runs its own wipe instead of returning as a silent no-op', async() => {
    accountClearFields.mockRejectedValueOnce(STORAGE_FAILURE);
    const manager: SignedInManager = await signedInManager();
    await expect(manager.logOut()).rejects.toBe(STORAGE_FAILURE);

    await expect(manager.logOut(), 'the retry clears the storage and completes').resolves.toBeUndefined();
    expect(
      manager.rootScope.dispatchEvent,
      'the retry must run its own wipe: a logOut left flagged by the failed one would return without wiping'
    ).toHaveBeenCalledTimes(2);
  });
});

describe('the session clear of a sign-out keeps the failure of the storage write', () => {
  it('rejects clearImpulseSession when the write of the session and refresh tokens fails', async() => {
    const {clearImpulseSession} = await import('@lib/impulse/session');
    const {getGrpcSessionToken, setGrpcSessionToken} = await import('@lib/impulse/grpc/credentials');
    setGrpcSessionToken(ACCOUNT, SESSION_TOKEN);
    accountClearFields.mockImplementation(async(accountNumber: ActiveAccountNumber, keys: string[]): Promise<void> => {
      if(keys.includes('impulse_session_token')) {
        throw STORAGE_FAILURE;
      }
    });

    await expect(
      clearImpulseSession(ACCOUNT),
      'the failed write of the session tokens must reach the sign-out, not be logged and dropped'
    ).rejects.toBe(STORAGE_FAILURE);
    expect(getGrpcSessionToken(ACCOUNT), 'the session is dropped in memory whatever the storage answered').toBeUndefined();
  });
});
