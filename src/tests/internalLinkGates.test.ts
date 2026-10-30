import {afterEach, beforeAll, describe, expect, test, vi} from 'vitest';
import {setAppStateSilent} from '@stores/appState';

vi.hoisted(() => {
  class IntersectionObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  vi.stubGlobal('IntersectionObserver', IntersectionObserverMock);
  vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, {status: 204}))));
});

vi.mock('@environment/webpSupport', () => ({default: true}));
vi.mock('@components/sidebarRight', () => ({default: {}}));
vi.mock('@components/sidebarLeft', () => ({default: {}}));
vi.mock('@lib/logger', async(importActual) => {
  const actual = await importActual<typeof import('@lib/logger')>();
  const silent = (): void => {};
  const silentLogger = Object.assign(silent, {
    warn: silent,
    info: silent,
    error: silent,
    trace: silent,
    debug: silent,
    assert: silent,
    group: silent,
    groupCollapsed: silent,
    groupEnd: silent,
    setPrefix: silent,
    setLevel: silent,
    bindPrefix: () => silentLogger
  });
  return {...actual, logger: () => silentLogger};
});

const mocks = vi.hoisted(() => ({
  toastNew: vi.fn(),
  showStarsPopup: vi.fn(),
  showGiftStarsPicker: vi.fn(),
  showSendGiftPicker: vi.fn(),
  showSendGiftPopup: vi.fn(),
  showGiftLinkPopup: vi.fn(),
  openSettingsDeepLink: vi.fn(() => Promise.resolve(true)),
  openSettingsSection: vi.fn(),
  openSettingsSearchItem: vi.fn(),
  hasOwnStories: vi.fn(() => false),
  isPremiumPurchaseBlocked: vi.fn(() => Promise.resolve(false)),
  getGiftBySlug: vi.fn(),
  hasTonTransactions: false
}));

vi.mock('@components/toast', () => ({toastNew: mocks.toastNew, hideToast: vi.fn()}));
vi.mock('@components/popups/stars', () => ({
  default: mocks.showStarsPopup,
  showGiftStarsPicker: mocks.showGiftStarsPicker
}));
vi.mock('@components/popups/sendGiftPicker', () => ({default: mocks.showSendGiftPicker}));
vi.mock('@components/popups/sendGift', () => ({default: mocks.showSendGiftPopup}));
vi.mock('@components/popups/giftLink', () => ({default: mocks.showGiftLinkPopup}));
vi.mock('@lib/settingsSearch/navigate', () => ({
  openSettingsDeepLink: mocks.openSettingsDeepLink,
  openSettingsSection: mocks.openSettingsSection,
  openSettingsSearchItem: mocks.openSettingsSearchItem
}));
vi.mock('@appManagers/utils/stories/hasOwnStories', () => ({default: mocks.hasOwnStories}));
vi.mock('@stores/stars', async(importOriginal) => {
  const actual = await importOriginal<typeof import('@stores/stars')>();
  return {...actual, default: () => () => 0, hasTonTransactions: () => mocks.hasTonTransactions};
});
vi.mock('@lib/apiManagerProxy', async(importOriginal) => {
  const actual = await importOriginal<typeof import('@lib/apiManagerProxy')>();
  return {
    default: Object.assign(actual.default, {isPremiumPurchaseBlocked: mocks.isPremiumPurchaseBlocked})
  };
});

import internalLinkProcessor from '@lib/internalLinkProcessor';

const NOT_SUPPORTED: {langPackKey: string} = {langPackKey: 'Link.NotSupported'};

const BLOCKED_CONFIG = {
  stars_purchase_blocked: true,
  stargifts_blocked: true,
  stars_gifts_enabled: false,
  stories_posting: 'disabled',
  premium_purchase_blocked: true
};

const STARS_OPEN_GIFTS_BLOCKED_CONFIG = {
  stars_purchase_blocked: false,
  stargifts_blocked: true,
  stars_gifts_enabled: true,
  stories_posting: 'disabled',
  premium_purchase_blocked: false
};

const OPEN_CONFIG = {
  stars_purchase_blocked: false,
  stargifts_blocked: false,
  stars_gifts_enabled: true,
  stories_posting: 'enabled',
  premium_purchase_blocked: false
};

function setAppConfig(appConfig: Record<string, unknown>) {
  setAppStateSilent('appConfig', {...appConfig});
}

function openLink(href: string, handlerName: string) {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.textContent = href;
  return (window as unknown as Record<string, (element: HTMLAnchorElement) => unknown>)[handlerName](anchor);
}

beforeAll(() => {
  internalLinkProcessor.construct({appGiftsManager: {getGiftBySlug: mocks.getGiftBySlug}} as any);
});

afterEach(() => {
  vi.clearAllMocks();
  mocks.hasTonTransactions = false;
  mocks.hasOwnStories.mockReturnValue(false);
  mocks.isPremiumPurchaseBlocked.mockResolvedValue(false);
  setAppConfig({});
});

describe('a destination the switches hide answers the unsupported-link toast and opens nothing', () => {
  test('tg://settings/stars while Stars are blocked', () => {
    setAppConfig(BLOCKED_CONFIG);
    openLink('tg://settings/stars', 'tg_settings');

    expect(mocks.toastNew).toHaveBeenCalledWith(NOT_SUPPORTED);
    expect(mocks.showStarsPopup).not.toHaveBeenCalled();
  });

  test('tg://settings/stars opens the Stars popup while Stars are allowed', () => {
    setAppConfig(OPEN_CONFIG);
    openLink('tg://settings/stars', 'tg_settings');

    expect(mocks.showStarsPopup).toHaveBeenCalled();
    expect(mocks.toastNew).not.toHaveBeenCalled();
  });

  test('tg://settings/stars/gift with Stars allowed and gifts blocked toasts and opens no picker', () => {
    setAppConfig(STARS_OPEN_GIFTS_BLOCKED_CONFIG);
    openLink('tg://settings/stars/gift', 'tg_settings');

    expect(mocks.toastNew).toHaveBeenCalledWith(NOT_SUPPORTED);
    expect(mocks.showGiftStarsPicker).not.toHaveBeenCalled();
  });

  test('tg://settings/stars/gift opens the picker while Stars and gifts are allowed', () => {
    setAppConfig(OPEN_CONFIG);
    openLink('tg://settings/stars/gift', 'tg_settings');

    expect(mocks.showGiftStarsPicker).toHaveBeenCalled();
    expect(mocks.toastNew).not.toHaveBeenCalled();
  });

  test('tg://settings/send-gift while gifts are blocked', () => {
    setAppConfig(BLOCKED_CONFIG);
    openLink('tg://settings/send-gift', 'tg_settings');

    expect(mocks.toastNew).toHaveBeenCalledWith(NOT_SUPPORTED);
    expect(mocks.showSendGiftPicker).not.toHaveBeenCalled();
  });

  test('tg://settings/send-gift/self while gifts are blocked', () => {
    setAppConfig(BLOCKED_CONFIG);
    openLink('tg://settings/send-gift/self', 'tg_settings');

    expect(mocks.toastNew).toHaveBeenCalledWith(NOT_SUPPORTED);
    expect(mocks.showSendGiftPopup).not.toHaveBeenCalled();
  });

  test('tg://settings/ton with a zero balance and no history', () => {
    setAppConfig(OPEN_CONFIG);
    mocks.hasTonTransactions = false;
    openLink('tg://settings/ton', 'tg_settings');

    expect(mocks.toastNew).toHaveBeenCalledWith(NOT_SUPPORTED);
    expect(mocks.showStarsPopup).not.toHaveBeenCalled();
  });

  test('tg://settings/ton opens the wallet once there is TON history', () => {
    setAppConfig(OPEN_CONFIG);
    mocks.hasTonTransactions = true;
    openLink('tg://settings/ton', 'tg_settings');

    expect(mocks.showStarsPopup).toHaveBeenCalledWith({ton: true});
    expect(mocks.toastNew).not.toHaveBeenCalled();
  });

  test('tg://settings/my-profile/posts/all-stories with posting disabled and no stories of one\'s own', () => {
    setAppConfig(BLOCKED_CONFIG);
    mocks.hasOwnStories.mockReturnValue(false);
    openLink('tg://settings/my-profile/posts/all-stories', 'tg_settings');

    expect(mocks.toastNew).toHaveBeenCalledWith(NOT_SUPPORTED);
  });

  test('tg://settings/my-profile/archived-posts with posting disabled and no stories of one\'s own', () => {
    setAppConfig(BLOCKED_CONFIG);
    mocks.hasOwnStories.mockReturnValue(false);
    openLink('tg://settings/my-profile/archived-posts', 'tg_settings');

    expect(mocks.toastNew).toHaveBeenCalledWith(NOT_SUPPORTED);
  });

  test('a unique gift link while gifts are blocked fetches nothing', () => {
    setAppConfig(BLOCKED_CONFIG);
    openLink('tg://nft?slug=gift-1', 'tg_nft');

    expect(mocks.toastNew).toHaveBeenCalledWith(NOT_SUPPORTED);
    expect(mocks.getGiftBySlug).not.toHaveBeenCalled();
  });

  test('a gift-code link while premium purchase is blocked opens no gift', async() => {
    setAppConfig(BLOCKED_CONFIG);
    mocks.isPremiumPurchaseBlocked.mockResolvedValue(true);
    openLink('tg://giftcode?slug=code-1', 'tg_giftcode');

    await vi.waitFor(() => expect(mocks.toastNew).toHaveBeenCalledWith(NOT_SUPPORTED));
    expect(mocks.showGiftLinkPopup).not.toHaveBeenCalled();
  });

  test('a settings link whose row the switches hide toasts and is not handed to the search', async() => {
    setAppConfig(BLOCKED_CONFIG);
    openLink('tg://settings/privacy?highlight=Privacy.GiftsRow', 'tg_settings');

    await vi.waitFor(() => expect(mocks.toastNew).toHaveBeenCalledWith(NOT_SUPPORTED));
    expect(mocks.openSettingsDeepLink).not.toHaveBeenCalled();
  });

  test('the same settings link opens while gifts are allowed', async() => {
    setAppConfig(OPEN_CONFIG);
    openLink('tg://settings/privacy?highlight=Privacy.GiftsRow', 'tg_settings');

    await vi.waitFor(() => expect(mocks.openSettingsDeepLink).toHaveBeenCalled());
    expect(mocks.toastNew).not.toHaveBeenCalled();
  });
});
