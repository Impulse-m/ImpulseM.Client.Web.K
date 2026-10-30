import {afterEach, beforeAll, describe, expect, test, vi} from 'vitest';
import I18n, {LangPackKey} from '@lib/langPack';
import type {LangPackString} from '@layer';
import generated from '@lib/settingsSearch/generated';
import {getSettingsSearchSuggestions, searchSettings, SettingsSearchItem} from '@lib/settingsSearch';
import {setAppStateSilent} from '@stores/appState';
import lang from '../lang';
import langSign from '../langSign';

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
  hasTonTransactions: false
}));

vi.mock('@stores/stars', async(importOriginal) => {
  const actual = await importOriginal<typeof import('@stores/stars')>();
  return {...actual, default: () => () => 0, hasTonTransactions: () => mocks.hasTonTransactions};
});

const OPEN_CONFIG = {
  stars_purchase_blocked: false,
  stargifts_blocked: false,
  stars_gifts_enabled: true,
  stories_posting: 'enabled'
};

const BLOCKED_CONFIG = {
  stars_purchase_blocked: true,
  stargifts_blocked: true,
  stars_gifts_enabled: false,
  stories_posting: 'disabled'
};

const HIDDEN_ROW_IDS: string[] = [
  'AppSettingsTab:MenuImpulseMStars',
  'AppSettingsTab:MenuImpulseMStarsTon',
  'AppSettingsTab:Chat.Menu.SendGift',
  'AppPrivacyAndSecurityTab:Privacy.GiftsRow',
  'AppChatAutomationTab:ChatAutomation.TransferStars',
  'AppChatAutomationTab:ChatAutomation.ManageGifts',
  'AppChatAutomationTab:ChatAutomation.ViewGifts',
  'AppChatAutomationTab:ChatAutomation.SellGifts',
  'AppChatAutomationTab:ChatAutomation.TransferGifts',
  'AppChatAutomationTab:ChatAutomation.ChangeGiftSettings',
  'AppChatAutomationTab:ChatAutomation.ManageStories'
];

const HIDDEN_PRIVACY_GIFTS_ENTRY_ID: string = 'AppPrivacyGiftsTab:Privacy.GiftsTypePremium';
const HIDDEN_PRIVACY_GIFTS_SECTION_ID: string = 'section:AppPrivacyGiftsTab';

function setAppConfig(appConfig: Record<string, unknown>) {
  setAppStateSilent('appConfig', {...appConfig});
}

function titleOf(entryId: string): LangPackKey {
  const entry = generated.entries.find((candidate) => candidate.id === entryId);
  return entry.titleLangKey;
}

function resultIds(query: string): string[] {
  return searchSettings(query).map((item: SettingsSearchItem) => item.id);
}

beforeAll(() => {
  const pack: LangPackString[] = [];
  I18n.formatLocalStrings(lang, pack);
  I18n.formatLocalStrings(langSign, pack);
  for(const string of pack) {
    I18n.strings.set(string.key as LangPackKey, string);
  }
});

afterEach(() => {
  mocks.hasTonTransactions = false;
  setAppConfig({});
});

describe('settings search offers no row the switches hide', () => {
  test.each(HIDDEN_ROW_IDS)('%s is found while its switch allows it', (rowId) => {
    setAppConfig(OPEN_CONFIG);
    mocks.hasTonTransactions = true;

    const title = I18n.format(titleOf(rowId), true);
    expect(resultIds(title)).toContain(rowId);
  });

  test.each(HIDDEN_ROW_IDS)('%s is not offered while its switch blocks it', (rowId) => {
    setAppConfig(BLOCKED_CONFIG);

    const title = I18n.format(titleOf(rowId), true);
    expect(resultIds(title)).not.toContain(rowId);
  });

  test('the TON row is not offered for a zero balance with no history, even with Stars open', () => {
    setAppConfig(OPEN_CONFIG);
    mocks.hasTonTransactions = false;

    const title = I18n.format(titleOf('AppSettingsTab:MenuImpulseMStarsTon'), true);
    expect(resultIds(title)).not.toContain('AppSettingsTab:MenuImpulseMStarsTon');
  });

  test('a hidden section and every row inside it leave the results', () => {
    setAppConfig(OPEN_CONFIG);
    const sectionTitle = I18n.format('PrivacyGifts', true);
    expect(resultIds(sectionTitle)).toContain(HIDDEN_PRIVACY_GIFTS_SECTION_ID);

    const entryTitle = I18n.format(titleOf(HIDDEN_PRIVACY_GIFTS_ENTRY_ID), true);
    expect(resultIds(entryTitle)).toContain(HIDDEN_PRIVACY_GIFTS_ENTRY_ID);

    setAppConfig(BLOCKED_CONFIG);
    expect(resultIds(sectionTitle)).not.toContain(HIDDEN_PRIVACY_GIFTS_SECTION_ID);
    expect(resultIds(entryTitle)).not.toContain(HIDDEN_PRIVACY_GIFTS_ENTRY_ID);
  });

  test('recent suggestions drop a row the switches hide', () => {
    setAppConfig(OPEN_CONFIG);
    mocks.hasTonTransactions = true;
    expect(getSettingsSearchSuggestions(['AppSettingsTab:MenuImpulseMStars']).map((item) => item.id))
    .toEqual(['AppSettingsTab:MenuImpulseMStars']);

    setAppConfig(BLOCKED_CONFIG);
    expect(getSettingsSearchSuggestions(['AppSettingsTab:MenuImpulseMStars'])).toEqual([]);
  });
});
