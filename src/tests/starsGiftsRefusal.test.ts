import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {setAppStateSilent} from '@stores/appState';

const mocks = vi.hoisted(() => ({
  confirmationPopup: vi.fn(() => Promise.resolve())
}));

vi.mock('@components/confirmationPopup', () => ({default: mocks.confirmationPopup}));

import {refuseWhenStarsBlocked} from '@components/starsNotAvailable';

function setAppConfig(appConfig: Record<string, any>) {
  setAppStateSilent('appConfig', appConfig);
}

beforeEach(() => {
  mocks.confirmationPopup.mockClear();
});

afterEach(() => {
  setAppConfig({});
});

describe('Stars refusal at a popup entry', () => {
  test('blocked Stars answer "Stars not available" and report the refusal', () => {
    setAppConfig({stars_purchase_blocked: true});
    expect(refuseWhenStarsBlocked()).toBe(true);
    expect(mocks.confirmationPopup).toHaveBeenCalledWith(expect.objectContaining({
      titleLangKey: 'StarsNotAvailableTitle',
      descriptionLangKey: 'StarsNotAvailableText'
    }));
  });

  test('an absent key blocks Stars', () => {
    setAppConfig({});
    expect(refuseWhenStarsBlocked()).toBe(true);
    expect(mocks.confirmationPopup).toHaveBeenCalledTimes(1);
  });

  test('allowed Stars answer nothing and let the popup open', () => {
    setAppConfig({stars_purchase_blocked: false});
    expect(refuseWhenStarsBlocked()).toBe(false);
    expect(mocks.confirmationPopup).not.toHaveBeenCalled();
  });
});
