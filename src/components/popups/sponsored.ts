import {i18n} from '@lib/langPack';
import showPeerPopup from '@components/popups/peer';

export default function showSponsoredPopup() {
  showPeerPopup('popup-sponsored', {
    titleLangKey: 'Chat.Message.Sponsored.What',
    descriptionLangKey: 'Chat.Message.Ad.Text',
    descriptionLangArgs: [i18n('Chat.Message.Sponsored.Link')],
    buttons: [{
      langKey: 'OK',
      isCancel: true
    }],
    scrollable: true
  });
}
