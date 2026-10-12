import {afterEach, describe, expect, it, vi} from 'vitest';
import {IdleController} from '@helpers/idleController';

const OFFLINE_BLUR_TIMEOUT_MS = 5e3;

describe('IdleController offline status', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function setup() {
    vi.useFakeTimers();

    const accountUpdateStatus = vi.fn();
    const controller = new IdleController();
    controller.addEventListener('change', (idle) => accountUpdateStatus({offline: idle}));

    window.dispatchEvent(new Event('focus'));
    accountUpdateStatus.mockClear();

    return {accountUpdateStatus, controller};
  }

  it('does not send offline before the configured blur timeout', () => {
    const {accountUpdateStatus} = setup();

    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(OFFLINE_BLUR_TIMEOUT_MS - 1);
    expect(accountUpdateStatus).not.toHaveBeenCalledWith({offline: true});

    vi.advanceTimersByTime(1);
    expect(accountUpdateStatus).toHaveBeenCalledOnce();
    expect(accountUpdateStatus).toHaveBeenCalledWith({offline: true});
  });

  it('suppresses offline when focus returns within the blur timeout', () => {
    const {accountUpdateStatus} = setup();

    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(OFFLINE_BLUR_TIMEOUT_MS - 1);
    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(1);

    expect(accountUpdateStatus).not.toHaveBeenCalled();
  });
});
