/*
 * A popup whose own container goes fullscreen (the 1:1 and group call windows) must stay where it is:
 * moving it into its own descendant detaches it, the browser drops fullscreen, and the popup stays
 * registered as open. A popup opened over somebody else's fullscreen element (the media viewer) is
 * still mounted inside that element, or it would be invisible.
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import '@helpers/peerIdPolyfill';

vi.mock('@helpers/schedulers', async(importOriginal) => ({
  ...await importOriginal<typeof import('@helpers/schedulers')>(),
  doubleRaf: (): Promise<void> => Promise.resolve()
}));
// jsdom has no IntersectionObserver; the popup only asks the intersector to pause and resume.
vi.mock('@components/animationIntersector', () => ({
  default: {checkAnimations2: vi.fn()}
}));

import PopupElement, {createPopup, PopupContextValue, usePopupContext} from '@components/popups/indexTsx';

const POPUP_CLASS = 'popup-fullscreen-test';
const DESTROY_DELAY_MS = 250;
// Solid reports a throw inside an effect through console.error under this label instead of rethrowing.
const SOLID_ERROR_LABEL = 'solid error';

type OpenedPopup = {
  context: PopupContextValue,
  container: HTMLDivElement
};

let currentFullScreenElement: HTMLElement = null;
let reportedErrors: unknown[] = [];

const onWindowError = (event: ErrorEvent): void => {
  reportedErrors.push(event.error ?? event.message);
};

// Fullscreen API: `fullscreenchange` bubbles from the element that entered or left fullscreen, and is
// fired at the document instead when that element is no longer connected.
function setFullScreenElement(element: HTMLElement): void {
  const changed = element || currentFullScreenElement;
  currentFullScreenElement = element;
  const target: EventTarget = changed?.isConnected ? changed : document;
  try {
    target.dispatchEvent(new Event('fullscreenchange', {bubbles: true}));
  } catch(err) {
    reportedErrors.push(err);
  }
}

async function openPopup(): Promise<OpenedPopup> {
  let context: PopupContextValue;
  let container: HTMLDivElement;
  const Snitch = () => {
    context = usePopupContext();
    return <span class="popup-fullscreen-test-content" />;
  };

  createPopup(() => (
    <PopupElement
      class={POPUP_CLASS}
      containerProps={{ref: (element: HTMLDivElement) => container = element}}
    >
      <Snitch />
    </PopupElement>
  ));

  await vi.waitFor(() => expect(context.shown()).toBe(true));
  return {context, container};
}

function activePopups(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`.popup.${POPUP_CLASS}.active`)];
}

async function closePopup(popup: OpenedPopup): Promise<void> {
  popup.context.destroy();
  vi.advanceTimersByTime(DESTROY_DELAY_MS);
  await vi.waitFor(() => expect(PopupElement.POPUPS).not.toContain(popup.context));
}

beforeEach(() => {
  document.body.replaceChildren();
  reportedErrors = [];
  currentFullScreenElement = null;
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => currentFullScreenElement
  });
  window.addEventListener('error', onWindowError);
  const consoleError = console.error;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if(args[0] === SOLID_ERROR_LABEL) {
      reportedErrors.push(args[1]);
      return;
    }

    consoleError(...args);
  });
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
});

afterEach(() => {
  currentFullScreenElement = null;
  document.body.dispatchEvent(new Event('fullscreenchange'));
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.removeEventListener('error', onWindowError);
  PopupElement.POPUPS.slice().forEach((popup) => popup.destroy());
  delete (document as {fullscreenElement?: Element}).fullscreenElement;
});

describe('a popup whose own container goes fullscreen', () => {
  it('stays connected inside its active popup, with no error thrown', async() => {
    const popup = await openPopup();
    const popupElement = popup.context.element;
    expect(popup.container.isConnected).toBe(true);

    setFullScreenElement(popup.container);

    expect(reportedErrors, 'moving the popup into its own container must not throw').toEqual([]);
    expect(popup.container.isConnected, 'the fullscreen container must stay in the document').toBe(true);
    expect(popupElement.isConnected, 'the popup must stay in the document').toBe(true);
    expect(popup.container.closest('.popup.active'), 'the container must still sit in its active popup').toBe(popupElement);
    expect(popupElement.contains(popup.container)).toBe(true);
    expect(popup.container.contains(popupElement), 'the popup must not be moved inside its own container').toBe(false);
  });

  it('closes and opens again after leaving fullscreen', async() => {
    const first = await openPopup();
    setFullScreenElement(first.container);
    setFullScreenElement(null);
    expect(reportedErrors).toEqual([]);
    expect(first.context.element.isConnected).toBe(true);

    await closePopup(first);
    expect(activePopups()).toEqual([]);

    const second = await openPopup();
    expect(reportedErrors).toEqual([]);
    expect(second.context.element.isConnected).toBe(true);
    expect(activePopups()).toEqual([second.context.element]);
  });
});

describe('a popup opened while another element is fullscreen', () => {
  it('mounts inside that element, and returns to the page when fullscreen ends', async() => {
    const viewer = document.createElement('div');
    viewer.className = 'media-viewer-fullscreen-test';
    document.body.append(viewer);
    setFullScreenElement(viewer);

    const popup = await openPopup();
    expect(reportedErrors).toEqual([]);
    expect(viewer.contains(popup.context.element), 'a popup over a fullscreen viewer must be inside it').toBe(true);

    setFullScreenElement(null);
    expect(viewer.contains(popup.context.element)).toBe(false);
    expect(popup.context.element.isConnected).toBe(true);
  });
});
