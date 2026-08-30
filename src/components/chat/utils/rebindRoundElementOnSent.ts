import {DeferredMediaElement} from '@components/audio';
import {Message} from '@layer';

export default function rebindRoundElementOnSent(element: HTMLElement, message: Message.message): void {
  (element as any).message = message;
  element.dataset.mid = '' + message.mid;
  delete element.dataset.isOutgoing;
  (element as DeferredMediaElement).onLoad(true);
}
