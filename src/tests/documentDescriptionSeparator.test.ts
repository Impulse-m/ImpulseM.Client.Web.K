import {describe, expect, it} from 'vitest';
import {DOCUMENT_DESCRIPTION_JOINER, fillDocumentDescription} from '@components/wrappers/documentDescription';

// What the user actually reads, which is not textContent: an invisible width reservation still
// contributes its characters there, so asserting on textContent would call the dangling separator a
// pass. Walk the children and skip anything hidden, exactly as the eye does.
function visibleText(container: HTMLElement) {
  return Array.from(container.childNodes)
    .filter((node) => !(node instanceof HTMLElement) || node.style.visibility !== 'hidden')
    .map((node) => node.textContent)
    .join('');
}

function span(text: string) {
  const el = document.createElement('span');
  el.textContent = text;
  return el;
}

function hiddenReservation(text: string) {
  const el = span(text);
  el.style.visibility = 'hidden';
  return el;
}

describe('document row subtitle', () => {
  it('renders a size on its own with no trailing separator', () => {
    const container = document.createElement('span');

    fillDocumentDescription(container, [span('202 KB')], hiddenReservation(' / 202 KB'));

    expect(visibleText(container)).toBe('202 KB');
  });

  it('still separates a size from a time', () => {
    const container = document.createElement('span');

    fillDocumentDescription(container, [span('202 KB'), span('21:14')]);

    expect(visibleText(container)).toBe(`202 KB${DOCUMENT_DESCRIPTION_JOINER}21:14`);
  });

  it('separates every present field, and only those', () => {
    const container = document.createElement('span');

    fillDocumentDescription(container, [span('202 KB'), span('21:14'), span('Kyle')]);

    expect(visibleText(container)).toBe(
      `202 KB${DOCUMENT_DESCRIPTION_JOINER}21:14${DOCUMENT_DESCRIPTION_JOINER}Kyle`
    );
  });

  // The reservation exists so the row does not reflow when download progress turns "202 KB" into
  // "12 KB / 202 KB". Dropping it would fix the separator and reintroduce the jump, so its presence
  // is asserted rather than left to be noticed later.
  it('keeps the width reservation in the DOM, merely unseen', () => {
    const container = document.createElement('span');
    const reservation = hiddenReservation(' / 202 KB');

    fillDocumentDescription(container, [span('202 KB')], reservation);

    expect(container.contains(reservation)).toBe(true);
    expect(container.textContent).toContain(' / 202 KB');
  });
});
