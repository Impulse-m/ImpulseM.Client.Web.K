import {afterEach, describe, expect, it, vi} from 'vitest';
import {IdleController} from '@helpers/idleController';
import IS_TOUCH_SUPPORTED from '@environment/touchSupport';

// Taken from the same condition the controller binds on rather than hardcoded: this environment
// reports touch support, so a hardcoded 'mousemove' here dispatches an event nothing listens for
// and every activity assertion below passes vacuously.
const ACTIVITY_EVENT_NAME = IS_TOUCH_SUPPORTED ? 'touchstart' : 'mousemove';

const OFFLINE_IDLE_TIMEOUT_MS = 30e3;
const OFFLINE_BLUR_TIMEOUT_MS = 5e3;

// offline_idle_timeout_ms is the OTHER half of the presence contract, and the two are documented
// side by side: "Time without any user activity after which it should be treated offline"
// (constructor/config.md:174-176), against offline_blur_timeout_ms for a window that lost focus.
//
// The client only ever had the blur route. A focused tab kept re-asserting online every 50 s for as
// long as it was open, so a client left on a second monitor read as online to every contact all
// night. Nothing here is about blur -- the window keeps focus throughout every test below.
describe('IdleController inactivity', () => {
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

  function beActive() {
    window.dispatchEvent(new Event(ACTIVITY_EVENT_NAME));
  }

  it('goes offline after the idle timeout with the window still focused', () => {
    const {accountUpdateStatus} = setup();

    vi.advanceTimersByTime(OFFLINE_IDLE_TIMEOUT_MS - 1);
    expect(accountUpdateStatus).not.toHaveBeenCalledWith(
      {offline: true}
    );

    vi.advanceTimersByTime(1);
    expect(accountUpdateStatus).toHaveBeenCalledWith({offline: true});
  });

  // The deadline measures inactivity, not uptime. Without a reset on activity this would fire on a
  // user who never stopped typing, which is the opposite of what the field means.
  it('does not go offline while the user keeps interacting', () => {
    const {accountUpdateStatus} = setup();

    for(let elapsed = 0; elapsed < OFFLINE_IDLE_TIMEOUT_MS * 3; elapsed += OFFLINE_IDLE_TIMEOUT_MS / 2) {
      vi.advanceTimersByTime(OFFLINE_IDLE_TIMEOUT_MS / 2);
      beActive();
    }

    expect(accountUpdateStatus).not.toHaveBeenCalledWith(
      {offline: true}
    );
  });

  it('comes back online on the first activity after going idle', () => {
    const {accountUpdateStatus} = setup();

    vi.advanceTimersByTime(OFFLINE_IDLE_TIMEOUT_MS);
    expect(accountUpdateStatus).toHaveBeenCalledWith({offline: true});

    beActive();
    expect(accountUpdateStatus).toHaveBeenCalledWith({offline: false});
  });

  it('honours a shorter idle timeout supplied by the server', () => {
    const {accountUpdateStatus, controller} = setup();

    controller.setOfflineIdleTimeout(OFFLINE_BLUR_TIMEOUT_MS);
    beActive();

    vi.advanceTimersByTime(OFFLINE_BLUR_TIMEOUT_MS);
    expect(accountUpdateStatus).toHaveBeenCalledWith({offline: true});
  });

  // The two deadlines are separate transitions and must not collapse into one. A blurred window is
  // offline after the BLUR timeout, which is far shorter -- if the idle deadline were the only one
  // armed, blurring would silently inherit the longer wait.
  it('still uses the blur timeout when the window loses focus', () => {
    const {accountUpdateStatus} = setup();

    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(OFFLINE_BLUR_TIMEOUT_MS);

    expect(accountUpdateStatus).toHaveBeenCalledWith({offline: true});
  });
});
