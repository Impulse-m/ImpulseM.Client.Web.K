import rootScope from '@lib/rootScope';
import confirmationPopup from '@components/confirmationPopup';
import {toastNew} from '@components/toast';
import {reportSignOutFailure} from '@lib/impulse/backgroundFailures';
import noop from '@helpers/noop';

export default function showLogOutPopup() {
  confirmationPopup({
    titleLangKey: 'LogOut',
    descriptionLangKey: 'LogOut.Description',
    button: {
      langKey: 'LogOut',
      isDanger: true
    }
  }).then(() => {
    rootScope.managers.apiManager.logOut().catch((error: unknown): void => {
      reportSignOutFailure(error);
      toastNew({langPackKey: 'Error.AnError'});
    });
  }, noop);
}
