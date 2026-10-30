import {canPostStories, giftsBlocked, starsUiBlocked, walletShown} from '@stores/appState';
import {findSettingsLink} from './link';
import {getSectionChain} from './registry';
import type {SettingsSearchItem} from './index';

const HIDDEN_SECTIONS: Map<string, () => boolean> = new Map([
  ['AppPrivacyGiftsTab', giftsBlocked]
]);

const HIDDEN_ROWS: Map<string, () => boolean> = new Map([
  ['AppSettingsTab:MenuImpulseMStars', starsUiBlocked],
  ['AppSettingsTab:MenuImpulseMStarsTon', () => !walletShown()],
  ['AppSettingsTab:Chat.Menu.SendGift', giftsBlocked],
  ['AppPrivacyAndSecurityTab:Privacy.GiftsRow', giftsBlocked],
  ['AppChatAutomationTab:ChatAutomation.TransferStars', starsUiBlocked],
  ['AppChatAutomationTab:ChatAutomation.ManageGifts', giftsBlocked],
  ['AppChatAutomationTab:ChatAutomation.ViewGifts', giftsBlocked],
  ['AppChatAutomationTab:ChatAutomation.SellGifts', giftsBlocked],
  ['AppChatAutomationTab:ChatAutomation.TransferGifts', giftsBlocked],
  ['AppChatAutomationTab:ChatAutomation.ChangeGiftSettings', giftsBlocked],
  ['AppChatAutomationTab:ChatAutomation.ManageStories', () => !canPostStories()]
]);

export const isSettingsSectionShown = (sectionId: string): boolean => {
  return !getSectionChain(sectionId).some((id) => HIDDEN_SECTIONS.get(id)?.());
};

export const isSettingsRowShown = (rowId: string): boolean => {
  return !HIDDEN_ROWS.get(rowId)?.();
};

export const isSettingsResultShown = (item: SettingsSearchItem): boolean => {
  return isSettingsSectionShown(item.sectionId) && isSettingsRowShown(item.id);
};

export const isSettingsLinkShown = (path: string, highlight?: string): boolean => {
  const link = findSettingsLink(path);
  if(!link) {
    return true;
  }

  return isSettingsSectionShown(link.sectionId) &&
    [link.highlight, highlight].every((key) => !key || isSettingsRowShown(link.sectionId + ':' + key));
};
