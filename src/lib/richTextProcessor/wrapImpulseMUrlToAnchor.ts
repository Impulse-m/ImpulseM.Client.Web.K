import wrapUrl from '@lib/richTextProcessor/wrapUrl';

/** An anchor for a link on the link host or on Telegram's hosts; undefined when there is no url to link to. */
export default function wrapImpulseMUrlToAnchor(url1: string | undefined): HTMLAnchorElement | undefined {
  if(!url1) {
    return;
  }

  const {url, onclick} = wrapUrl(url1);
  const element = document.createElement('a');
  (element as HTMLAnchorElement).href = url;
  if(onclick) {
    element.setAttribute('onclick', `${onclick}(this)`);
  }

  return element;
}
