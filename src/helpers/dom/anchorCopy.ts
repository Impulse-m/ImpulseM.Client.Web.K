import {toastNew} from '@components/toast';
import {LangPackKey} from '@lib/langPack';
import {copyTextToClipboard} from '@helpers/clipboard';
import cancelEvent from '@helpers/dom/cancelEvent';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import {impulsemShareLink} from '@config/impulsemConfig';

/** A copyable share link on the configured link host; undefined (no anchor) when no link host is set. */
export default function anchorCopy(options: Partial<{
  // href: string,
  mePath: string,
  username: string
}> = {}): HTMLAnchorElement | undefined {
  const href: string | undefined = impulsemShareLink('/' + (options.mePath || options.username || ''));
  if(!href) {
    return;
  }

  const anchor = document.createElement('a');
  anchor.classList.add('anchor-copy');

  let copyWhat: string = href, copyText: LangPackKey = 'LinkCopied';
  anchor.href = anchor.innerText = href;

  if(options.username) {
    copyWhat = anchor.innerText = '@' + options.username;
    copyText = 'UsernameCopied';
  }

  attachClickEvent(anchor, (e) => {
    cancelEvent(e);
    copyTextToClipboard(copyWhat ?? anchor.href);
    toastNew({langPackKey: copyText});
  });

  return anchor;
}
