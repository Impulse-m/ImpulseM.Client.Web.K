import {joinElementsWith} from '@lib/langPack';

export const DOCUMENT_DESCRIPTION_JOINER = ' · ';

/**
 * Fills a document row's subtitle: the description fields joined by a separator, followed by an
 * optional invisible element that only reserves layout width.
 *
 * The reservation is appended AFTER the join rather than passed through it. It used to be pushed
 * into the same array, and `joinElementsWith` duly put a separator in front of it — but a separator
 * is a bare text node and `visibility: hidden` on the element after it hides nothing of the sort, so
 * a row with no time and no sender rendered as `202 KB ·`. The separator belongs between two
 * present fields; a width reservation is not one of them.
 */
export function fillDocumentDescription(
  container: HTMLElement,
  parts: (HTMLElement | string | DocumentFragment)[],
  widthReservation?: HTMLElement
) {
  container.append(...joinElementsWith(parts, DOCUMENT_DESCRIPTION_JOINER));

  if(widthReservation) {
    container.append(widthReservation);
  }
}
