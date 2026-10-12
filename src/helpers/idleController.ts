import IS_TOUCH_SUPPORTED from '@environment/touchSupport';
import EventListenerBase from '@helpers/eventListenerBase';
import {IS_PREVIEW} from '@config/debug';
import {getAppWindow, onAppWindowChange} from '@helpers/appWindow';

const FOCUS_EVENT_NAME = IS_TOUCH_SUPPORTED ? 'touchstart' : 'mousemove';
const DO_NOT_IDLE = IS_PREVIEW; // the preview window is never focused — don't let it look idle
// Default documented by the server config constructor; used until config is available.
const OFFLINE_BLUR_TIMEOUT_MS = 5e3;
// The other half of the same contract, for a window that still HAS focus and is simply unattended.
// Used until config arrives; our Config service serves 30 s for offline_idle_timeout_ms.
const OFFLINE_IDLE_TIMEOUT_MS = 30e3;
// The activity listener fires per pointer move. Re-arming the deadline on every one of them is
// pure timer churn at ~60 Hz for a deadline measured in tens of seconds, so a move only pushes the
// deadline out once per second. Worst case the reported idle moment is one second early, which is
// under the resolution the field describes.
const IDLE_REARM_THROTTLE_MS = 1e3;

export class IdleController extends EventListenerBase<{
  change: (idle: boolean) => void
}> {
  private _isIdle: boolean;

  private focusPromise: Promise<void>;
  private focusResolve: () => void;

  private boundWindow: Window;
  private offlineBlurTimeout = OFFLINE_BLUR_TIMEOUT_MS;
  private offlineBlurTimeoutId: number;
  private offlineIdleTimeout = OFFLINE_IDLE_TIMEOUT_MS;
  private offlineIdleTimeoutId: number;
  private idleDeadlineArmedAt = 0;
  private onBlur = () => {
    // A blurred window is answered by the blur deadline alone. Leaving the idle deadline armed
    // would leave two timers racing to describe one transition, and the loser would fire later
    // against a state it no longer describes.
    this.clearIdleDeadline();
    clearTimeout(this.offlineBlurTimeoutId);
    this.offlineBlurTimeoutId = window.setTimeout(() => {
      this.offlineBlurTimeoutId = undefined;
      this.isIdle = true;
    }, this.offlineBlurTimeout);
  };
  private onActive = () => {
    clearTimeout(this.offlineBlurTimeoutId);
    this.offlineBlurTimeoutId = undefined;
    this.isIdle = false;
    this.armIdleDeadline(false);
  };

  constructor() {
    super();

    this._isIdle = !DO_NOT_IDLE;
    this.focusPromise = Promise.resolve();
    this.focusResolve = () => {};

    // Track blur/focus/activity on whichever window the app currently lives in — the tab, or the
    // Document PiP window while popped out. Bound to the MAIN window only, the app would look idle the
    // instant the user focuses the PiP (the tab blurs) and pause every animation (media spoilers go
    // blank); and PiP mouse activity would never reach it to wake it back up.
    this.bindWindow(getAppWindow(), false);
    onAppWindowChange((win) => this.bindWindow(win, true));

    this.addEventListener('change', (idle) => {
      if(idle) {
        this.focusPromise = new Promise((resolve) => {
          this.focusResolve = resolve;
        });
      } else {
        this.focusResolve();
      }
    });
  }

  private bindWindow(win: Window, isSwitch: boolean) {
    const prev = this.boundWindow;
    if(prev) {
      prev.removeEventListener('blur', this.onBlur);
      prev.removeEventListener('focus', this.onActive);
      prev.removeEventListener(FOCUS_EVENT_NAME, this.onActive);
    }

    this.boundWindow = win;
    win.addEventListener('blur', this.onBlur);
    win.addEventListener('focus', this.onActive);
    // * Prevent setting online after reloading page — wake on the first activity in this window
    //
    // Standing rather than {once: true}, which it used to be: the idle deadline measures time since
    // the LAST activity, so it needs every activity, not the first one. The reload behaviour the
    // once-listener was there for is unchanged — the controller still starts idle and still wakes on
    // the first move — because the isIdle setter returns early when the value has not changed.
    win.addEventListener(FOCUS_EVENT_NAME, this.onActive, {passive: true});

    // Moving the app INTO a window (PiP pop-in/out) is itself active use of that window — wake up so
    // animations keep playing even though the window we left has just blurred.
    if(isSwitch) {
      this.onActive();
    }
  }

  public getFocusPromise() {
    return this.focusPromise;
  }

  public setOfflineBlurTimeout(timeout: number) {
    this.offlineBlurTimeout = timeout;
  }


  public setOfflineIdleTimeout(timeout: number) {
    this.offlineIdleTimeout = timeout;
    // Config arrives after the first deadline is already armed, so the new value has to displace it
    // rather than wait for the next pointer move — otherwise a server asking for a shorter idle
    // window does not get one until the user happens to move.
    this.armIdleDeadline(true);
  }


  private armIdleDeadline(force: boolean) {
    if(this.isIdle || !this.boundWindow) {
      return;
    }

    const now = Date.now();
    if(!force && this.offlineIdleTimeoutId !== undefined && now - this.idleDeadlineArmedAt < IDLE_REARM_THROTTLE_MS) {
      return;
    }

    this.clearIdleDeadline();
    this.idleDeadlineArmedAt = now;
    this.offlineIdleTimeoutId = window.setTimeout(() => {
      this.offlineIdleTimeoutId = undefined;
      this.isIdle = true;
    }, this.offlineIdleTimeout);
  }


  private clearIdleDeadline() {
    clearTimeout(this.offlineIdleTimeoutId);
    this.offlineIdleTimeoutId = undefined;
  }

  public get isIdle() {
    return this._isIdle;
  }

  public set isIdle(value: boolean) {
    if(this._isIdle === value) {
      return;
    }

    if(DO_NOT_IDLE && value) {
      return;
    }

    this._isIdle = value;
    this.dispatchEvent('change', value);
  }
}

const idleController = new IdleController();
export default idleController;
