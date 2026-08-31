import {expect, Page} from '@playwright/test';

/*
 * Album (grouped media) asserts shared by the media scenarios.
 *
 * The "шакальные превью" / empty-preview bug class: a bubble that only ever shows the inline
 * stripped thumb (a <=40px blurred stripped-JPEG by canon — api/files.md photoStrippedSize) or
 * nothing at all, because the real ladder preview never loads. A stripped thumb inflated into
 * an <img> still reports a tiny natural size, so the invariant demands a decoded preview of at
 * least MIN_REAL_PREVIEW_PX natural width — comfortably above any stripped thumb, comfortably
 * below the smallest real ladder letter an album box requests. Blurred <canvas> placeholders
 * are deliberately NOT counted as previews.
 */
const MIN_REAL_PREVIEW_PX = 100;

type AlbumItemState = {
  mid: string,
  previewNaturalWidth: number,
  hasRealPreview: boolean
};


async function albumSnapshot(page: Page): Promise<AlbumItemState[]> {
  return page.evaluate((minRealPreviewPx: number) => {
    const container: HTMLElement | undefined = (window as any).appImManager?.chat?.bubbles?.container;
    const items = container ? Array.from(container.querySelectorAll<HTMLElement>('.grouped-item')) : [];

    return items.map((item) => {
      const imageWidths = Array.from(item.querySelectorAll('img'))
        .map((image) => (image as HTMLImageElement).naturalWidth);
      const videoWidths = Array.from(item.querySelectorAll('video'))
        .map((video) => (video as HTMLVideoElement).videoWidth);
      const previewNaturalWidth = Math.max(0, ...imageWidths, ...videoWidths);

      return {
        mid: item.dataset.mid ?? '(no mid)',
        previewNaturalWidth,
        hasRealPreview: previewNaturalWidth >= minRealPreviewPx
      };
    });
  }, MIN_REAL_PREVIEW_PX);
}


export async function waitForAlbum(page: Page, side: string, expectedCount: number): Promise<void> {
  await expect
    .poll(async() => (await albumSnapshot(page)).length, {
      timeout: 120_000,
      message: `the ${side} side never rendered the ${expectedCount}-item album as grouped media — ` +
        'either the messages did not arrive on this side at all, or they arrived ungrouped ' +
        '(each count below the expectation is an album member the user does not see)'
    })
    .toBe(expectedCount);
}


export async function assertAlbumPreviews(page: Page, side: string, expectedCount: number): Promise<void> {
  await waitForAlbum(page, side, expectedCount);

  let last: AlbumItemState[] = [];
  await expect
    .poll(async() => {
      last = await albumSnapshot(page);
      return last.filter((item) => !item.hasRealPreview).map((item) => `mid=${item.mid} widestPreview=${item.previewNaturalWidth}px`);
    }, {
      timeout: 60_000,
      message: `album preview(s) on the ${side} side never rendered a real decoded image/video ` +
        `frame (>= ${MIN_REAL_PREVIEW_PX}px natural width) — the user sees the blurred stripped-thumb ` +
        'placeholder or an empty box instead of the media ("шакальные превью"). The received array ' +
        'lists each broken album member with the widest preview it managed'
    })
    .toEqual([]);

  expect(
    last.length,
    `album preview sanity on the ${side} side: the album disappeared between the count wait and ` +
    'the preview check — a vanishing bubble must fail loudly, not pass vacuously'
  ).toBe(expectedCount);
}
