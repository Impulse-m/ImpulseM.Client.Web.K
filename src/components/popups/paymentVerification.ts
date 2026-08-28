import PopupElement from '.';
import appImManager from '@lib/appImManager';
import ImpulseMWebView from '@components/impulsemWebView';
import getWebViewTgLink from '@helpers/getWebViewTgLink';

export function createVerificationIframe(options: ConstructorParameters<typeof ImpulseMWebView>[0]) {
  const result = new ImpulseMWebView({
    ...options,
    sandbox: 'allow-forms allow-scripts allow-same-origin allow-modals'
  });
  const {iframe} = result;
  iframe.allow = 'payment';
  iframe.classList.add('payment-verification');
  return result;
}

export default class PopupPaymentVerification extends PopupElement<{
  finish: () => void
}> {
  private impulsemWebView: ImpulseMWebView;

  constructor(private url: string, private openPathAfter?: boolean) {
    super('popup-payment popup-payment-verification', {
      closable: true,
      overlayClosable: true,
      body: true,
      title: 'Checkout.WebConfirmation.Title'
    });

    this.d();
  }

  private d() {
    const impulsemWebView = this.impulsemWebView = createVerificationIframe({
      url: this.url
    });

    impulsemWebView.addEventListener('web_app_open_tg_link', (e) => {
      this.dispatchEvent('finish');
      this.hide();
      if(this.openPathAfter) {
        appImManager.openUrl(getWebViewTgLink(e.path_full));
      }
    });

    this.body.append(impulsemWebView.iframe);
    this.show();
    impulsemWebView.onMount();
  }

  protected destroy() {
    this.impulsemWebView.destroy();
    return super.destroy();
  }
}
