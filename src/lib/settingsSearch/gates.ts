import {canPostStories, giftsBlocked, starsUiBlocked, walletShown} from '@stores/appState';
import {findSettingsLink} from './link';
import {getSectionChain} from './registry';
import type {SettingsSearchItem} from './index';

export type ChatAutomationRightGate = {
  titleKey: string,
  hidden: () => boolean
};

export const CHAT_AUTOMATION_RIGHT_GATES: ReadonlyMap<string, ChatAutomationRightGate> = new Map<string, ChatAutomationRightGate>([
  ['transfer_stars', {titleKey: 'ChatAutomation.TransferStars', hidden: starsUiBlocked}],
  ['view_gifts', {titleKey: 'ChatAutomation.ViewGifts', hidden: giftsBlocked}],
  ['sell_gifts', {titleKey: 'ChatAutomation.SellGifts', hidden: giftsBlocked}],
  ['change_gift_settings', {titleKey: 'ChatAutomation.ChangeGiftSettings', hidden: giftsBlocked}],
  ['transfer_and_upgrade_gifts', {titleKey: 'ChatAutomation.TransferGifts', hidden: giftsBlocked}],
  ['manage_stories', {titleKey: 'ChatAutomation.ManageStories', hidden: () => !canPostStories()}]
]);

const HIDDEN_SECTIONS: Map<string, () => boolean> = new Map([
  ['AppPrivacyGiftsTab', giftsBlocked]
]);

const chatAutomationHiddenRows: [string, () => boolean][] = [...CHAT_AUTOMATION_RIGHT_GATES.values()].map(
  ({titleKey, hidden}): [string, () => boolean] => ['AppChatAutomationTab:' + titleKey, hidden]
);

const HIDDEN_ROWS: Map<string, () => boolean> = new Map<string, () => boolean>([
  ['AppSettingsTab:MenuImpulseMStars', starsUiBlocked],
  ['AppSettingsTab:MenuImpulseMStarsTon', () => !walletShown()],
  ['AppSettingsTab:Chat.Menu.SendGift', giftsBlocked],
  ['AppPrivacyAndSecurityTab:Privacy.GiftsRow', giftsBlocked],
  ['AppPrivacyMessagesTab:PaidMessages.SetPrice', starsUiBlocked],
  ['AppChatAutomationTab:ChatAutomation.ManageGifts', giftsBlocked],
  ...chatAutomationHiddenRows
]);

const isSettingsSectionShown = (sectionId: string): boolean => {
  return !getSectionChain(sectionId).some((id) => HIDDEN_SECTIONS.get(id)?.());
};

const isSettingsRowShown = (rowId: string): boolean => {
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
