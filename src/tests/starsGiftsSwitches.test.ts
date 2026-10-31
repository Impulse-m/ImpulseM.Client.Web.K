import '@helpers/peerIdPolyfill';
import {afterEach, describe, expect, test} from 'vitest';
import rootScope from '@lib/rootScope';
import {canPostStories, giftsBlocked, ownStoriesShown, setAppStateSilent, starsUiBlocked} from '@stores/appState';

function setAppConfig(appConfig: Record<string, any>) {
  setAppStateSilent('appConfig', appConfig);
}

afterEach(() => {
  setAppConfig({});
  rootScope.premium = false;
});

describe('Stars and gifts switches read canon defaults for absent keys', () => {
  test('an empty app config blocks Stars and gifts', () => {
    setAppConfig({});
    expect(starsUiBlocked()).toBe(true);
    expect(giftsBlocked()).toBe(true);
  });

  test('stars_purchase_blocked=false opens Stars', () => {
    setAppConfig({stars_purchase_blocked: false});
    expect(starsUiBlocked()).toBe(false);
  });

  test('stars_purchase_blocked=true blocks Stars', () => {
    setAppConfig({stars_purchase_blocked: true});
    expect(starsUiBlocked()).toBe(true);
  });

  test('gifts stay blocked while either stargifts_blocked or stars_gifts_enabled says so', () => {
    setAppConfig({stargifts_blocked: false, stars_gifts_enabled: true});
    expect(giftsBlocked()).toBe(false);

    setAppConfig({stargifts_blocked: true, stars_gifts_enabled: true});
    expect(giftsBlocked()).toBe(true);

    setAppConfig({stargifts_blocked: false, stars_gifts_enabled: false});
    expect(giftsBlocked()).toBe(true);
  });

  test('a key present as false opens gifts when the other key is absent', () => {
    setAppConfig({stargifts_blocked: false});
    expect(giftsBlocked()).toBe(false);

    setAppConfig({stars_gifts_enabled: true});
    expect(giftsBlocked()).toBe(true);
  });
});

describe('story posting follows stories_posting', () => {
  test('an absent key means enabled', () => {
    setAppConfig({});
    expect(canPostStories()).toBe(true);
  });

  test('disabled posting cannot post, even for premium', () => {
    setAppConfig({stories_posting: 'disabled'});
    rootScope.premium = true;
    expect(canPostStories()).toBe(false);
  });

  test('premium posting needs a premium account', () => {
    setAppConfig({stories_posting: 'premium'});
    rootScope.premium = false;
    expect(canPostStories()).toBe(false);

    rootScope.premium = true;
    expect(canPostStories()).toBe(true);
  });

  test('own stories show when the user has some or may post', () => {
    setAppConfig({stories_posting: 'disabled'});
    expect(ownStoriesShown(false)).toBe(false);
    expect(ownStoriesShown(true)).toBe(true);

    setAppConfig({stories_posting: 'enabled'});
    expect(ownStoriesShown(false)).toBe(true);
  });
});
