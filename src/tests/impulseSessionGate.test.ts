import {afterEach, describe, expect, it, vi} from 'vitest';

const accountGet = vi.fn();

vi.mock('@lib/accounts/accountController', () => ({
  default: {
    get: accountGet,
    update: vi.fn()
  }
}));

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
    vi.useFakeTimers();
    accountGet.mockRejectedValue(new Error('storage unavailable'));
    const {restoreImpulseSession, whenImpulseSessionReady} = await import('@lib/impulse/session');

    const ready = whenImpulseSessionReady();
    const rejection = ready.catch((error) => error);
    await restoreImpulseSession(1);
    await vi.advanceTimersByTimeAsync(3_001);

    await expect(rejection).resolves.toMatchObject({
      name: 'ImpulseSessionRestoreError',
      code: 'IMPULSE_SESSION_RESTORE_FAILED'
    });
  });
});
