import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import './mocks/popupEntryStubs';
import {setAppStateSilent} from '@stores/appState';

const mocks = vi.hoisted(() => ({
  confirmationPopup: vi.fn(() => Promise.resolve())
}));

vi.mock('@environment/webpSupport', () => ({default: true}));
vi.mock('@components/confirmationPopup', () => ({default: mocks.confirmationPopup}));
vi.mock('@components/sidebarRight', () => ({default: {}}));
vi.mock('@components/sidebarLeft', () => ({default: {}}));
vi.mock('@lib/logger', async(importActual) => {
  const {silentLoggerModule} = await import('./mocks/popupEntryStubs');
  return silentLoggerModule(await importActual<Record<string, unknown>>());
});
vi.mock('@stores/stars', async(importOriginal) => {
  const actual = await importOriginal<typeof import('@stores/stars')>();
  return {...actual, default: () => () => 0, hasTonTransactions: () => false};
});

import type {AppManagers} from '@lib/managers';
import rootScope from '@lib/rootScope';
import showStarsPayPopup from '@components/popups/starsPay';
import showStarsPopup from '@components/popups/stars';
import showSendGiftPopup from '@components/popups/sendGift';
import showSendGiftPicker from '@components/popups/sendGiftPicker';

const STARS_NOT_AVAILABLE = expect.objectContaining({
  titleLangKey: 'StarsNotAvailableTitle',
  descriptionLangKey: 'StarsNotAvailableText'
});

function unansweredManagers(): AppManagers {
  const manager = new Proxy({}, {get: () => () => new Promise(() => {})});
  return new Proxy({}, {get: () => manager}) as unknown as AppManagers;
}

function blockStarsAndGifts() {
  setAppStateSilent('appConfig', {
    stars_purchase_blocked: true,
    stargifts_blocked: true,
    stars_gifts_enabled: false
  });
}

beforeEach(() => {
  mocks.confirmationPopup.mockClear();
  rootScope.managers = unansweredManagers();
  blockStarsAndGifts();
});

afterEach(() => {
  setAppStateSilent('appConfig', {});
  document.body.innerHTML = '';
});

describe('Stars and gifts popup entries under the app config switches', () => {
  test('the Stars payment popup answers Stars not available and finishes cancelled', async() => {
    const emitter = showStarsPayPopup({});
    const finish = vi.fn();
    emitter.addEventListener('finish', finish);

    await vi.waitFor(() => expect(finish).toHaveBeenCalledWith('cancelled'));
    expect(mocks.confirmationPopup).toHaveBeenCalledWith(STARS_NOT_AVAILABLE);
  });

  test('the send-gift popup opens nothing while gifts are blocked', async() => {
    const bodyChildren = document.body.childElementCount;

    await showSendGiftPopup({peerId: 42 as PeerId});

    expect(document.body.childElementCount).toBe(bodyChildren);
    expect(mocks.confirmationPopup).not.toHaveBeenCalled();
  });

  test('the send-gift picker opens nothing while gifts are blocked', () => {
    const bodyChildren = document.body.childElementCount;

    expect(showSendGiftPicker()).toBeUndefined();

    expect(document.body.childElementCount).toBe(bodyChildren);
    expect(mocks.confirmationPopup).not.toHaveBeenCalled();
  });

  test('the Stars popup answers Stars not available and opens nothing for a non-TON open', () => {
    const bodyChildren = document.body.childElementCount;
    const onCancel = vi.fn();

    showStarsPopup({onCancel});

    expect(mocks.confirmationPopup).toHaveBeenCalledWith(STARS_NOT_AVAILABLE);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(document.body.childElementCount).toBe(bodyChildren);
  });

  test('the Stars popup is not refused for the TON open', () => {
    const onCancel = vi.fn();

    showStarsPopup({ton: true, onCancel});

    expect(mocks.confirmationPopup).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
