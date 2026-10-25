import {beforeEach, describe, expect, it, vi} from 'vitest';

/*
 * The sign-out popup has no caller to return a failed sign-out to: the failure is recorded with the error that failed it, and
 * the user is told with the codebase's error toast.
 */

const {logOut, confirm, toast, recordedErrors} = vi.hoisted(() => ({
  logOut: vi.fn(),
  confirm: vi.fn(),
  toast: vi.fn(),
  recordedErrors: [] as unknown[][]
}));

vi.mock('@lib/rootScope', () => ({
  default: {managers: {apiManager: {logOut}}}
}));

vi.mock('@components/confirmationPopup', () => ({
  default: confirm
}));

vi.mock('@components/toast', () => ({
  toastNew: toast
}));

vi.mock('@lib/impulseLogger', () => ({
  getLogger: (): unknown => ({
    debug: (): void => {},
    info: (): void => {},
    warn: (): void => {},
    error: (...args: unknown[]): void => {
      recordedErrors.push(args);
    }
  })
}));

const STORAGE_FAILURE: Error = new Error('storage unavailable');

function settled(): Promise<void> {
  return new Promise<void>((resolve: () => void): void => {
    setTimeout(resolve, 0);
  });
}

beforeEach(() => {
  logOut.mockReset();
  confirm.mockReset();
  toast.mockReset();
  recordedErrors.length = 0;
});

describe('the sign-out popup reports a failed sign-out', () => {
  it('shows the error toast and records the storage failure when the sign-out rejects', async() => {
    const unhandled: unknown[] = [];
    const recordUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', recordUnhandled);

    try {
      logOut.mockRejectedValue(STORAGE_FAILURE);
      confirm.mockResolvedValue(undefined);
      const {default: showLogOutPopup} = await import('@components/popups/logOut');

      showLogOutPopup();

      await vi.waitFor((): void => {
        expect(toast, 'a failed sign-out shows the codebase error toast for a failed action').toHaveBeenCalledWith({langPackKey: 'Error.AnError'});
      });
      expect(
        recordedErrors.some((args: unknown[]): boolean => args[2] === STORAGE_FAILURE),
        'the failed sign-out is recorded with the storage error that failed it'
      ).toBe(true);
      await settled();
      expect(unhandled, 'the popup leaves no unhandled rejection behind').toEqual([]);
    } finally {
      process.off('unhandledRejection', recordUnhandled);
    }
  });

  it('a cancelled sign-out popup signs nothing out and leaves no unhandled rejection behind', async() => {
    const unhandled: unknown[] = [];
    const recordUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', recordUnhandled);

    try {
      confirm.mockRejectedValue(undefined);
      const {default: showLogOutPopup} = await import('@components/popups/logOut');

      showLogOutPopup();

      await settled();
      expect(unhandled, 'cancelling the sign-out popup rejects its confirmation with undefined, and that rejection must be handled').toEqual([]);
      expect(logOut, 'a cancelled sign-out popup does not sign out').not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', recordUnhandled);
    }
  });
});
