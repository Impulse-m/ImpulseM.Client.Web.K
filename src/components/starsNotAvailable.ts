import confirmationPopup from '@components/confirmationPopup';
import {starsUiBlocked} from '@stores/appState';

export function showStarsNotAvailable(): Promise<void> {
  return confirmationPopup({
    titleLangKey: 'StarsNotAvailableTitle',
    descriptionLangKey: 'StarsNotAvailableText',
    button: {langKey: 'OK', isCancel: true}
  }).then(() => {}, () => {});
}

export function refuseWhenStarsBlocked(): boolean {
  if(!starsUiBlocked()) {
    return false;
  }

  showStarsNotAvailable();
  return true;
}
