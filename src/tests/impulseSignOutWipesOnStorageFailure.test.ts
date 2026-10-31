import {beforeEach, describe, expect, it, vi} from 'vitest';

import App from '@config/app';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import {apiManagerStub} from './helpers/apiManagerStub';
import {registerSessionIdentitySource} from './helpers/fleetIdentitySource';
import {sharedUpdateSocketHarness} from './helpers/updateSocketStub';

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

vi.mock('@impulsem/centrifuge/build/protobuf', async(importActual) => {
  const actual = await importActual<typeof import('@impulsem/centrifuge/build/protobuf')>();
  const {sharedUpdateSocketHarness: harness} = await import('./helpers/updateSocketStub');
  return {...actual, Centrifuge: harness().CentrifugeStub};
});

const {recordedErrors} = vi.hoisted(() => ({recordedErrors: [] as unknown[][]}));

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

const socketHarness = sharedUpdateSocketHarness();
const ACCOUNT: ActiveAccountNumber = 2;
const TOTAL_ACCOUNTS: number = 2;
const SESSION_TOKEN: string = 'access-jwt-signed-in';
const USER_ID: string = '42';
const STORAGE_FAILURE: Error = new Error('storage unavailable');
const READ_FAILURE: Error = new Error('storage read unavailable');
const CLOSE_FAILURE: Error = new Error('socket close failed');
const CURRENT_DC: number = 2;

type SignedInManager = {
  logOut(): Promise<void>,
  invokeApi: ReturnType<typeof vi.fn>,
  rootScope: {dispatchEvent: ReturnType<typeof vi.fn>}
};

async function signedInManager(): Promise<SignedInManager> {
  const {setGrpcSessionToken} = await import('@lib/impulse/grpc/credentials');
  setGrpcSessionToken(ACCOUNT, SESSION_TOKEN);
  return apiManagerStub({
    getAccountNumber: (): ActiveAccountNumber => ACCOUNT,
    invokeApi: vi.fn(async(): Promise<void> => undefined),
    rootScope: {dispatchEvent: vi.fn()}
  });
}

function settled(): Promise<void> {
  return new Promise<void>((resolve: () => void): void => {
    setTimeout(resolve, 0);
  });
}

beforeEach(() => {
  vi.resetModules();
  recordedErrors.length = 0;
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

describe('the local wipe keeps every failure of its steps', () => {
  beforeEach(async() => {
    socketHarness.reset();
    await registerSessionIdentitySource();
  });

  it('a socket that fails to close and a failed credential clear both reach the sign-out', async() => {
    const {startImpulseRealtime} = await import('@lib/impulse/realtime');
    const {setGrpcSessionToken} = await import('@lib/impulse/grpc/credentials');
    const {restoreImpulseSession} = await import('@lib/impulse/session');
    await restoreImpulseSession(ACCOUNT);
    setGrpcSessionToken(ACCOUNT, SESSION_TOKEN);
    startImpulseRealtime(USER_ID, ACCOUNT);
    const [socket] = socketHarness.sockets;
    socket.disconnect = (): void => {
      throw CLOSE_FAILURE;
    };
    accountClearFields.mockRejectedValue(STORAGE_FAILURE);
    const manager: SignedInManager = await signedInManager();

    const outcome: unknown = await manager.logOut().then((): undefined => undefined, (error: unknown): unknown => error);

    expect(
      outcome,
      'two failed steps of the wipe reach the sign-out as one AggregateError, not only the first of them'
    ).toBeInstanceOf(AggregateError);
    expect(
      (outcome as AggregateError).errors,
      'the socket close failure and the storage failure are both kept, in the order the steps failed'
    ).toEqual([CLOSE_FAILURE, STORAGE_FAILURE]);
  });
});

describe('a storage read of the sign-out does not skip the local wipe', () => {
  it('a failed count of the slots still runs the wipe, and the read failure reaches the sign-out', async() => {
    accountTotal.mockRejectedValue(READ_FAILURE);
    const manager: SignedInManager = await signedInManager();

    await expect(manager.logOut(), 'the read failure reaches the sign-out').rejects.toBe(READ_FAILURE);
    expect(
      manager.rootScope.dispatchEvent,
      'the local wipe still runs after a failed count of the slots: it announces the logout of the slot'
    ).toHaveBeenCalledWith('logging_out', expect.objectContaining({accountNumber: ACCOUNT}));
  });

  it('a failed read of the slot data still runs the wipe, and the read failure reaches the sign-out', async() => {
    accountGet.mockRejectedValue(READ_FAILURE);
    const manager: SignedInManager = await signedInManager();

    await expect(manager.logOut(), 'the read failure reaches the sign-out').rejects.toBe(READ_FAILURE);
    expect(
      manager.rootScope.dispatchEvent,
      'the local wipe still runs after a failed read of the slot data: it announces the logout of the slot'
    ).toHaveBeenCalledWith('logging_out', expect.objectContaining({accountNumber: ACCOUNT}));
  });

  it('a failed read of the slot data still asks the server to revoke the authorization on the current DC', async() => {
    accountGet.mockRejectedValue(READ_FAILURE);
    const manager: SignedInManager = Object.assign(await signedInManager(), {baseDcId: CURRENT_DC});

    await expect(manager.logOut(), 'the read failure reaches the sign-out').rejects.toBe(READ_FAILURE);
    expect(
      manager.invokeApi,
      'auth.logOut is the server revocation: it is sent on the current DC even when the keys of the slot cannot be read'
    ).toHaveBeenCalledWith('auth.logOut', {}, {dcId: CURRENT_DC, ignoreErrors: true});
  });
});

describe('the credential clear of the sign-out is recorded once when the timer runs it first', () => {
  it('rejects logOut with the failure while auth.logOut is still in flight, and reports no unhandled rejection', async() => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const recordUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', recordUnhandled);
    try {
      accountGet.mockResolvedValue({dc2_auth_key: 'auth-key-of-the-slot'});
      accountShift.mockRejectedValue(STORAGE_FAILURE);
      let answerLogOut: () => void = (): void => {};
      const manager: SignedInManager = Object.assign(await signedInManager(), {
        baseDcId: CURRENT_DC,
        invokeApi: vi.fn((): Promise<void> => new Promise<void>((resolve: () => void): void => {
          answerLogOut = resolve;
        }))
      });
      const outcome: Promise<unknown> = manager.logOut().then((): undefined => undefined, (error: unknown): unknown => error);

      await vi.advanceTimersByTimeAsync(0);
      expect(manager.invokeApi, 'auth.logOut is in flight when the one-second timer of the wipe fires').toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1e3);
      answerLogOut();

      expect(
        await outcome,
        'the failed clear reaches the sign-out once, whichever run of the clear reached it first'
      ).toBe(STORAGE_FAILURE);
      vi.useRealTimers();
      await settled();
      expect(unhandled, 'the run of the clear the timer started is not an unhandled rejection').toEqual([]);
    } finally {
      process.off('unhandledRejection', recordUnhandled);
      vi.useRealTimers();
    }
  });
});

describe('the revocation of a sign-out', () => {
  it.each([0, undefined])('a slot whose base DC is %s revokes the authorization on the App base DC', async(baseDcId: number | undefined) => {
    accountGet.mockRejectedValue(READ_FAILURE);
    const manager: SignedInManager = Object.assign(await signedInManager(), {baseDcId});

    await expect(manager.logOut(), 'the read failure reaches the sign-out').rejects.toBe(READ_FAILURE);
    expect(
      manager.invokeApi,
      'auth.logOut goes to the App base DC when the slot holds no base DC of its own'
    ).toHaveBeenCalledWith('auth.logOut', {}, {dcId: App.baseDcId, ignoreErrors: true});
  });

  it('a failed auth.logOut is recorded and does not fail the sign-out, and the local wipe still runs', async() => {
    const LOGOUT_FAILURE: ApiError = {type: 'AUTH_KEY_UNREGISTERED', code: 401};
    accountGet.mockResolvedValue({dc2_auth_key: 'auth-key-of-the-slot'});
    const manager: SignedInManager = Object.assign(await signedInManager(), {
      baseDcId: CURRENT_DC,
      invokeApi: vi.fn(async(): Promise<void> => {
        throw LOGOUT_FAILURE;
      })
    });

    await expect(
      manager.logOut(),
      'tdlib destroys the local keys whatever auth.logOut answered, so the sign-out resolves'
    ).resolves.toBeUndefined();
    expect(
      recordedErrors.some((args: unknown[]): boolean => args[2] === LOGOUT_FAILURE),
      'the failed auth.logOut is recorded with the error that failed it'
    ).toBe(true);
    expect(
      manager.rootScope.dispatchEvent,
      'the local wipe still runs after the failed revocation: it announces the logout of the slot'
    ).toHaveBeenCalledWith('logging_out', expect.objectContaining({accountNumber: ACCOUNT}));
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
