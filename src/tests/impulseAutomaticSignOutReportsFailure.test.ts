import {beforeEach, describe, expect, it, vi} from 'vitest';

import App from '@config/app';
import type {ActiveAccountNumber} from '@lib/accounts/types';

/*
 * A sign-out the server forces (SESSION_REVOKED) has no caller to return to: a failed wipe is recorded with the error that
 * failed it, and the request that triggered it fails with the server's own ApiError, leaving no unhandled rejection.
 */

const {accountClearFields, accountGet, accountTotal, accountShift, storageShift, passcodeUsed, grpcInvoke, recordedErrors} = vi.hoisted(() => ({
  accountClearFields: vi.fn(),
  accountGet: vi.fn(),
  accountTotal: vi.fn(),
  accountShift: vi.fn(),
  storageShift: vi.fn(),
  passcodeUsed: vi.fn(),
  grpcInvoke: vi.fn(),
  recordedErrors: [] as unknown[][]
}));

vi.mock('@lib/accounts/accountController', () => ({
  default: {
    get: accountGet,
    update: vi.fn(async(): Promise<void> => undefined),
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

vi.mock('@lib/impulse/grpc/adapter', () => ({
  grpcInvoke,
  isGrpcAvailable: (): boolean => true
}));

vi.mock('@lib/impulseLogger', async(importActual) => {
  const actual = await importActual<typeof import('@lib/impulseLogger')>();
  const silent = (): void => {};
  return {
    ...actual,
    getLogger: (): ReturnType<typeof actual.getLogger> => ({
      debug: silent,
      info: silent,
      warn: silent,
      error: (...args: unknown[]): void => {
        recordedErrors.push(args);
      }
    })
  };
});

const ACCOUNT: ActiveAccountNumber = 2;
const STORAGE_FAILURE: Error = new Error('storage unavailable');
const SESSION_REVOKED: ApiError = {type: 'SESSION_REVOKED', code: 401};

function settled(): Promise<void> {
  return new Promise<void>((resolve: () => void): void => {
    setTimeout(resolve, 0);
  });
}

beforeEach(() => {
  vi.resetModules();
  recordedErrors.length = 0;
  accountGet.mockReset();
  accountClearFields.mockReset();
  accountTotal.mockReset();
  accountShift.mockReset();
  storageShift.mockReset();
  passcodeUsed.mockReset();
  grpcInvoke.mockReset();
  accountGet.mockResolvedValue({});
  accountTotal.mockResolvedValue(2);
  accountShift.mockResolvedValue(undefined);
  storageShift.mockResolvedValue(undefined);
  passcodeUsed.mockResolvedValue(false);
  accountClearFields.mockResolvedValue(undefined);
  grpcInvoke.mockRejectedValue(SESSION_REVOKED);
});

describe('an automatic sign-out from the request path', () => {
  it('records a failed wipe, fails the request with the server error, and leaves no unhandled rejection', async() => {
    const {ApiManager} = await import('@appManagers/apiManager');
    accountClearFields.mockRejectedValue(STORAGE_FAILURE);
    const manager = Object.assign(Object.create(ApiManager.prototype), {
      getAccountNumber: (): ActiveAccountNumber => ACCOUNT,
      rootScope: {dispatchEvent: vi.fn()},
      baseDcId: App.baseDcId
    });
    const unhandled: unknown[] = [];
    const recordUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', recordUnhandled);

    try {
      await expect(
        manager.invokeApi('account.getPassword', {}, {noErrorBox: true}),
        'the request fails with the server ApiError that revoked the session'
      ).rejects.toMatchObject({type: 'SESSION_REVOKED'});
      await vi.waitFor((): void => {
        expect(
          recordedErrors.some((args: unknown[]): boolean => args[2] === STORAGE_FAILURE),
          'the failed wipe of the forced sign-out is recorded with the error that failed it'
        ).toBe(true);
      });
      await settled();
      expect(unhandled, 'the forced sign-out leaves no unhandled rejection behind').toEqual([]);
    } finally {
      process.off('unhandledRejection', recordUnhandled);
    }
  });
});
