import {afterEach, describe, expect, it, vi} from 'vitest';


/*
 * Issue #141. The gate has two rejections and one identity.
 *
 * `whenImpulseSessionReady()` rejects with an ImpulseSessionRestoreError carrying
 * IMPULSE_SESSION_RESTORE_FAILED in two entirely different situations: the DEV-only bypass, which
 * fires when the gate is asked before any restore was started, and a restore that genuinely
 * failed. Under vitest `import.meta.env.DEV` is true, so a test that asks the gate first and
 * asserts only on `name` and `code` is answered by the bypass and never runs the restore-failure
 * path at all -- it stayed green no matter what that path did.
 *
 * The restore-failure path is the load-bearing one: rejecting on a real failure is what stops a
 * boot wave leaving before a token is on the headers, and an unauthenticated boot wave is what
 * signed the CEO out in #137. So these order the calls the way boot does -- after() starts the
 * restore, consumers ask the gate afterwards -- and pin the message, which is the only thing that
 * separates the two rejections.
 */

const accountGet = vi.fn();

vi.mock('@lib/accounts/accountController', () => ({
  default: {
    get: accountGet,
    update: vi.fn()
  }
}));

const RESTORE_FAILURE_IS_NOT_THE_DEV_BYPASS =
  'The gate must reject with the restore failure itself. The DEV bypass in ' +
  'whenImpulseSessionReady() is the same class with the same code, so name and code alone cannot ' +
  'tell the two apart; only the message can. If this reads as the bypass message, the restore ' +
  'was never started before the gate was asked and this test is proving nothing. If the gate ' +
  'opened, a failed restore is letting the boot wave travel unauthenticated -- which is exactly ' +
  'the 401 storm that signed a legitimately signed-in user out in #137.';


describe('Impulse session gate', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.resetModules();
    accountGet.mockReset();
  });


  it('does not let a request leave while session restore is pending', async() => {
    vi.useFakeTimers();
    let finishRestore: (value: any) => void;
    accountGet.mockImplementation(() => new Promise((resolve) => {
      finishRestore = resolve;
    }));
    const {restoreImpulseSession, whenImpulseSessionReady} = await import('@lib/impulse/session');
    const {getGrpcSessionToken} = await import('@lib/impulse/grpc/transport');
    const send = vi.fn();

    const restore = restoreImpulseSession(1);
    const request = whenImpulseSessionReady().then(() => send(getGrpcSessionToken()));
    await vi.advanceTimersByTimeAsync(3_001);

    expect(send).not.toHaveBeenCalled();

    finishRestore!({
      userId: 42,
      impulse_session_token: 'session-token',
      impulse_refresh_token: 'refresh-token'
    });
    await restore;
    await request;
    expect(send).toHaveBeenCalledWith('session-token');
  });


  it('rejects with a typed error when session restore fails', async() => {
    accountGet.mockRejectedValue(new Error('storage unavailable'));
    const {restoreImpulseSession, whenImpulseSessionReady} = await import('@lib/impulse/session');

    // Boot's order, and the whole point of the test: apiManager.after() starts the restore and
    // every consumer asks the gate afterwards. Asking first is what handed the assertion to the
    // DEV bypass instead of to the path being named.
    await restoreImpulseSession(1);

    const outcome = await whenImpulseSessionReady().then(
      () => ({name: 'gate opened', code: 'gate opened', message: 'gate opened'}),
      (error: any) => ({name: error?.name, code: error?.code, message: error?.message})
    );

    expect(outcome, RESTORE_FAILURE_IS_NOT_THE_DEV_BYPASS).toMatchObject({
      name: 'ImpulseSessionRestoreError',
      code: 'IMPULSE_SESSION_RESTORE_FAILED',
      message: 'Failed to restore the Impulse session'
    });
  });
});
