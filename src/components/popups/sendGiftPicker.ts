import showPickUserPopup from '@components/popups/pickUser';
import showSendGiftPopup from '@components/popups/sendGift';
import {giftsBlocked} from '@stores/appState';

type PickUserOptions = Parameters<typeof showPickUserPopup>[0];

/**
 * The recipient picker behind every "send a gift" entry — the Settings row, the
 * birthday suggestion and `tg://settings/send-gift` all open the same one, and
 * pass only what is their own (the birthdays it puts on top, for instance).
 */
export default function showSendGiftPicker(options?: Partial<PickUserOptions>) {
  if(giftsBlocked()) {
    return;
  }

  return showPickUserPopup({
    titleLangKey: 'SendGiftTo',
    placeholder: 'Chat.Menu.SendGift',
    selfPresence: 'SendGiftSelfCaption',
    meAsSaved: false,
    filterPeerTypeBy: ['isRegularUser', 'isBroadcast'],
    onSelect: ([{peerId}]) => {
      showSendGiftPopup({peerId});
    },
    ...options
  });
}
