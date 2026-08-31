import {expect, Locator, Page} from '@playwright/test';

import type {MediaPayload} from './mediaFixtures';
import type {PersonaSession} from './personaSession';

/*
 * Issue #118 instrumentation: "a video sent AS A FILE, clicked, opens its THUMBNAIL as a photo".
 *
 * The reference client answers that click with the media viewer — it either plays the video or
 * says it cannot be played there. What it never does is hand the user the row's little preview
 * as a still picture to pan and zoom, and it never answers the click with silence.
 *
 * The gesture driven here is the user's: one trusted click on the file row, at its centre, once
 * the row has stopped LOOKING busy. "Looks busy" is deliberately measured the way the user
 * measures it — a spinner they can see — and not by the presence of a `.preloader-container`
 * node, because that node is exactly what bubbles.ts:3725 consults before routing the click to
 * the media viewer: a spinner that finished but left its node behind is invisible to the user
 * and fatal to the click, and this module has to be able to catch that rather than wait for it.
 *
 * Everything else here exists for the red. When the click does not end in the viewer, the
 * capture separates causes that look identical on screen:
 *
 *   - what the row actually is: its classes (document-with-thumb is what makes the row a media
 *     viewer target at all, bubbles.ts:3690), every preloader node still inside it with whether
 *     the user can see it, and the document object the row itself carries
 *     (wrappers/document.ts:158 pins `doc` onto the div) with mime, size, thumbs and attribute
 *     vector — so a client-side routing defect is distinguishable from a wire that arrived
 *     without thumbs or without a video mime;
 *   - the document's cache context, which is what the viewer feeds to the <video> element: a
 *     context that claims `downloaded` while holding no url produces a viewer with nothing to
 *     play and a still thumbnail on screen — the board's exact report;
 *   - what the user's pointer was over, and the whole hit stack at that pixel — so "the click
 *     went to the thumbnail image" is a measurement, not a theory;
 *   - whether a media viewer was constructed at all and WHAT it was handed
 *     (window.appMediaViewer.target.message, set by mediaViewer/index.ts:511) — document id vs
 *     photo id, which is the difference between "the viewer opened on the file" and "the viewer
 *     opened on its preview";
 *   - the viewer's <video> element in full (src, paused, currentTime, readyState, error): a
 *     video element that exists and never moves IS the still picture the user complained about,
 *     so its presence alone is never accepted as success;
 *   - whether the click merely produced a file download instead of an open;
 *   - every toast raised, so the legitimate refusal ("this video can't be played on ImpulseM
 *     Web", mediaViewer/base.ts:2874) is never confused with silence.
 */
export type ViewerMedia = {
  /** The media constructor the viewer was handed: messageMediaDocument / messageMediaPhoto / … */
  messageMediaType: string,
  documentId: string,
  photoId: string,
  mimeType: string
};

export type RowDocument = {
  id: string,
  mimeType: string,
  size: number,
  /** appDocsManager's classification — undefined for a force_file video, which is the point. */
  type: string,
  fileName: string,
  thumbCount: number,
  videoThumbCount: number,
  attributeTypes: string[],
  supportsStreaming: boolean
};

export type ViewerVideoState = {
  paused: boolean,
  currentTime: number,
  readyState: number,
  networkState: number,
  errorCode: number,
  src: string
};

export type DocumentCacheState = {
  downloaded: boolean,
  url: string,
  type: string
};

export type DocumentRowClickCapture = {
  rowFound: boolean,
  rowClasses: string,
  /** bubbles.ts routes a click to the media viewer only through a `document-with-thumb` row. */
  rowHasThumbClass: boolean,
  /** Every `.preloader-container` left in the row, each labelled visible or invisible. */
  rowPreloaders: string[],
  rowShowsVisibleSpinner: boolean,
  /** A finished spinner whose node stayed behind: the user sees nothing, the router sees a block. */
  rowHasInvisiblePreloaderNode: boolean,
  rowDoc: RowDocument | null,
  rowDocCache: DocumentCacheState | null,
  elementUnderClick: string,
  hitStack: string[],
  viewerOpen: boolean,
  viewerVideo: ViewerVideoState | null,
  viewerStillImages: string[],
  viewerReceived: ViewerMedia | null,
  toasts: string[],
  downloads: string[]
};

/**
 * What the user ended up with after the single click. Only the first two are the contract; the
 * rest are the failure shapes issue #118 is made of.
 */
export type DocumentRowOutcome =
  'the media viewer is playing the file' |
  'the client reported the video cannot be played here' |
  'the media viewer opened on the still preview and never played it' |
  'the click only downloaded the file' |
  'nothing opened at all';

const playedOutcome: DocumentRowOutcome = 'the media viewer is playing the file';
const refusedOutcome: DocumentRowOutcome = 'the client reported the video cannot be played here';

/**
 * The rendered refusal, apostrophe-free on purpose so the assertion never depends on how the
 * lang string's typography is rendered ('Video.Unsupported.Desktop' / '.Mobile', lang.ts:435).
 */
const refusalMarker = 'be played on ImpulseM Web';


/**
 * Real attach-as-FILE flow: attach menu -> "Document" -> file chooser -> PopupNewMedia ->
 * confirm. This is the surface that produces force_file on the wire; the "Photo or Video" item
 * (personaSession.attachMediaThroughUi) produces the opposite and cannot reach this defect.
 */
export async function attachAsFileThroughUi(session: PersonaSession, files: MediaPayload[]): Promise<void> {
  const page = session.page;
  await page.locator('.attach-file').click();

  const menuItem = page.locator('.btn-menu-item:visible', {hasText: 'Document'}).first();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    menuItem.click()
  ]);
  await chooser.setFiles(files);

  const confirm = page.locator('.popup-new-media button.btn-primary');
  await confirm.waitFor({state: 'visible', timeout: 30_000});
  await confirm.click();
  await page.locator('.popup-new-media').waitFor({state: 'hidden', timeout: 30_000});

  await session.waitForOutgoingSettled('attached file');
}


/**
 * The file row of the newest RECEIVED message that carries one. Incoming and settled, always: a
 * scenario about what the server delivered must never be able to assert against the sender's own
 * echo of its upload.
 */
export function documentRow(page: Page): Locator {
  return page.locator(rowSelector).last();
}


export async function waitForDocumentRow(session: PersonaSession, side: string): Promise<void> {
  await documentRow(session.page)
    .waitFor({state: 'visible', timeout: 90_000})
    .catch(() => {
      throw new Error(
        `the file the sender attached never appeared as a file row on the ${side} side — the ` +
        'message either never arrived or was rendered as something other than a document'
      );
    });
}


/**
 * The whole invariant of issue #118, driven as the user drives it: one click on the file row of
 * a video sent as a file must end in the media viewer showing THAT document — playing it, or
 * saying it cannot be played — and never in the row's preview left on screen as a still picture,
 * never in a bare download, never in silence.
 */
export async function assertVideoSentAsFileOpensInTheViewer(
  session: PersonaSession,
  side: string
): Promise<void> {
  const page = session.page;
  const row = documentRow(page);
  await waitForDocumentRow(session, side);

  // A row the user can still SEE spinning is a row asking for a download, not a row asking to be
  // opened; auto-download (3 MiB in a private chat, config/state.ts:457) clears it on its own for
  // a clip this size. A spinner that never clears is a named failure of its own rather than a
  // click landing on a state the user would never click in.
  await page
    .waitForFunction((selector: string) => {
      const rows = document.querySelectorAll(selector);
      const element = rows.length > 0 ? rows[rows.length - 1] : undefined;
      if(!element) {
        return false;
      }

      return !Array.from(element.querySelectorAll('.preloader-container')).some((preloader) => {
        const rect = preloader.getBoundingClientRect();
        const style = getComputedStyle(preloader);
        return rect.width > 0 && rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          parseFloat(style.opacity) > 0.01;
      });
    }, rowSelector, {timeout: 90_000})
    .catch(async() => {
      const capture = await captureDocumentRowState(page, {x: 0, y: 0});
      throw new Error(
        `the file row on the ${side} side never stopped showing its download spinner, so the user ` +
        'never reached the state in which a click means "open this file".\n' +
        describeDocumentRowClick(capture)
      );
    });

  const box = await row.boundingBox();
  expect(
    box,
    `the file row on the ${side} side has no layout box at all — there is nothing for the user to click`
  ).not.toBeNull();
  const point = {x: box.x + box.width / 2, y: box.y + box.height / 2};

  const downloads: string[] = [];
  const onDownload = (download: {suggestedFilename: () => string}) => {
    downloads.push(download.suggestedFilename());
  };
  page.on('download', onDownload);

  const clickAt = Date.now();
  try {
    await row.click({timeout: 30_000});

    // Terminal states only: video that is actually MOVING in the viewer, or the client's refusal
    // in words. Anything else keeps arriving until the deadline, so a slow open is never
    // mistaken for a defect — and a <video> element that exists without ever playing never
    // ends the wait, because on screen that is precisely the still picture under investigation.
    const deadline = Date.now() + 60_000;
    let capture = await captureDocumentRowState(page, point);
    while(!isPlaying(capture) && !hasRefusal(capture) && Date.now() < deadline) {
      await page.waitForTimeout(250);
      capture = await captureDocumentRowState(page, point);
    }
    capture.downloads = [...downloads];

    const outcome = classifyOutcome(capture);
    const report = `${describeDocumentRowClick(capture)}\nconsole around the click:\n${session.formatConsoleTrailSince(clickAt - 2_000)}`;

    // Sanity before the invariant: without the row's own document object the viewer assertion
    // below would compare '' with '' and go green on a page that rendered nothing.
    expect(
      capture.rowDoc?.id ?? '',
      `the file row on the ${side} side carries no document object, so this scenario has nothing ` +
      'to judge the media viewer against and would pass vacuously.\n' +
      report
    ).not.toBe('');

    expect(
      capture.viewerOpen || outcome === refusedOutcome,
      `one click on the video-sent-as-a-file row on the ${side} side did not open the media viewer ` +
      `at all — the user got "${outcome}". The reference client answers this click with the ` +
      'viewer, which then plays the video or says it cannot be played here (issue #118).\n' +
      report
    ).toBe(true);

    expect(
      capture.viewerReceived?.documentId ?? '',
      `the media viewer on the ${side} side opened on something other than the file the user ` +
      `clicked: it was handed ${describeViewerMedia(capture.viewerReceived)} while the row carries ` +
      `document ${capture.rowDoc?.id ?? '(unknown)'}. Opening the message's PREVIEW instead of the ` +
      'message\'s document is exactly the "the file behaves like a picture" report of issue #118.\n' +
      report
    ).toBe(capture.rowDoc?.id ?? '');

    expect(
      outcome === playedOutcome || outcome === refusedOutcome,
      `after one click on the video sent as a file, the user on the ${side} side ended with ` +
      `"${outcome}". A video sent as a file must either play in the media viewer or be refused ` +
      'there in words; a still preview the user can only pan and zoom is the defect the board ' +
      'reported in issue #118 — the file behaving like a picture.\n' +
      report
    ).toBe(true);
  } finally {
    page.off('download', onDownload);
  }
}


export function describeDocumentRowClick(capture: DocumentRowClickCapture): string {
  const lines: string[] = [];
  lines.push(`  what the user ended with: ${classifyOutcome(capture)}`);
  lines.push(`  file row found: ${capture.rowFound}, classes: ${capture.rowClasses || '(none)'}`);
  lines.push(`  row is a media-viewer target (document-with-thumb): ${capture.rowHasThumbClass}`);
  lines.push(`  preloader nodes left in the row: ${capture.rowPreloaders.length ? capture.rowPreloaders.join(', ') : '(none)'}`);
  lines.push(`  spinner the user can see: ${capture.rowShowsVisibleSpinner}; invisible spinner node still blocking the route: ${capture.rowHasInvisiblePreloaderNode}`);
  lines.push(`  the document the row carries: ${describeRowDocument(capture.rowDoc)}`);
  lines.push(`  that document's cache context: ${describeDocumentCache(capture.rowDocCache)}`);
  lines.push(`  element under the click point: ${capture.elementUnderClick}`);
  lines.push(`  hit stack at that pixel: ${capture.hitStack.length ? capture.hitStack.join(' > ') : '(nothing)'}`);
  lines.push(`  media viewer open: ${capture.viewerOpen}`);
  lines.push(`  media viewer was handed: ${describeViewerMedia(capture.viewerReceived)}`);
  lines.push(`  <video> in the viewer: ${describeViewerVideo(capture.viewerVideo)}`);
  lines.push(`  still images in the viewer: ${capture.viewerStillImages.length ? capture.viewerStillImages.join(', ') : '(none)'}`);
  lines.push(`  toasts on screen: ${capture.toasts.length ? capture.toasts.join(' | ') : '(none)'}`);
  lines.push(`  browser downloads the click produced: ${capture.downloads.length ? capture.downloads.join(', ') : '(none)'}`);
  return lines.join('\n');
}


export function classifyOutcome(capture: DocumentRowClickCapture): DocumentRowOutcome {
  if(isPlaying(capture)) {
    return playedOutcome;
  }

  if(hasRefusal(capture)) {
    return refusedOutcome;
  }

  if(capture.viewerOpen) {
    return 'the media viewer opened on the still preview and never played it';
  }

  if(capture.downloads.length > 0) {
    return 'the click only downloaded the file';
  }

  return 'nothing opened at all';
}


/**
 * Moving pictures, judged exactly as the lane's other playback scenarios judge them
 * (personaSession.playVideoFromBubble): past HAVE_CURRENT_DATA, unpaused, clock advanced.
 */
function isPlaying(capture: DocumentRowClickCapture): boolean {
  const video = capture.viewerVideo;
  return !!video && !video.paused && video.currentTime > 0 && video.readyState > 2;
}


function hasRefusal(capture: DocumentRowClickCapture): boolean {
  return capture.toasts.some((toast) => toast.includes(refusalMarker));
}


function describeRowDocument(doc: RowDocument | null): string {
  if(!doc) {
    return '(the row carries no document object)';
  }

  return `id=${doc.id} mime=${doc.mimeType} size=${doc.size} type=${doc.type} name=${doc.fileName} ` +
    `thumbs=${doc.thumbCount} video_thumbs=${doc.videoThumbCount} ` +
    `attributes=[${doc.attributeTypes.join(', ')}] supportsStreaming=${doc.supportsStreaming}`;
}


function describeDocumentCache(cache: DocumentCacheState | null): string {
  if(!cache) {
    return '(unreadable)';
  }

  return `downloaded=${cache.downloaded} url=${cache.url || '(EMPTY — the viewer has nothing to play)'} type=${cache.type}`;
}


function describeViewerVideo(video: ViewerVideoState | null): string {
  if(!video) {
    return 'none';
  }

  return `present, paused=${video.paused} currentTime=${video.currentTime} readyState=${video.readyState} ` +
    `networkState=${video.networkState} errorCode=${video.errorCode} src=${video.src || '(EMPTY)'}`;
}


function describeViewerMedia(media: ViewerMedia | null): string {
  if(!media) {
    return '(no media viewer was ever constructed on this page)';
  }

  if(media.documentId) {
    return `document ${media.documentId} (${media.messageMediaType}, mime ${media.mimeType})`;
  }

  if(media.photoId) {
    return `PHOTO ${media.photoId} (${media.messageMediaType}) — a picture, not the file`;
  }

  return `${media.messageMediaType} with neither a document nor a photo`;
}


const rowSelector = '.bubble[data-mid]:not(.is-outgoing):not(.is-sending) .document[data-doc-id]';


async function captureDocumentRowState(
  page: Page,
  point: {x: number, y: number}
): Promise<DocumentRowClickCapture> {
  return page.evaluate(async({selector, x, y}) => {
    const describe = (element: Element | null): string => {
      if(!element) {
        return '(nothing)';
      }

      const className = element.getAttribute('class');
      return `<${element.tagName.toLowerCase()}${className ? ` class="${className}"` : ''}>`;
    };

    const isVisible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        parseFloat(style.opacity) > 0.01;
    };

    const rows = Array.from(document.querySelectorAll(selector));
    const row = rows.length > 0 ? rows[rows.length - 1] as HTMLElement : null;
    const doc = row ? (row as any).doc : undefined;
    const preloaders = row ? Array.from(row.querySelectorAll('.preloader-container')) : [];

    let rowDocCache: {downloaded: boolean, url: string, type: string} | null = null;
    if(doc) {
      try {
        const context = await (window as any).rootScope.managers.thumbsStorage.getCacheContext(doc);
        rowDocCache = {
          downloaded: !!context?.downloaded,
          url: String(context?.url ?? ''),
          type: String(context?.type ?? '')
        };
      } catch(ignored) {
        rowDocCache = null;
      }
    }

    const viewerWhole = document.querySelector('.media-viewer-whole');
    const viewerVideoElement = viewerWhole ? viewerWhole.querySelector('video') : null;
    const viewerImages = viewerWhole ?
      Array.from(viewerWhole.querySelectorAll('img, canvas')).map((image) => describe(image)) :
      [];

    const viewerInstance = (window as any).appMediaViewer;
    const viewerMessage = viewerInstance?.target?.message;
    const viewerMedia = viewerMessage?.media;
    const viewerDocument = viewerMedia?.document;
    const viewerPhoto = viewerMedia?.photo;

    return {
      rowFound: !!row,
      rowClasses: row ? row.className : '',
      rowHasThumbClass: !!row?.classList.contains('document-with-thumb'),
      rowPreloaders: preloaders.map((preloader) => `${describe(preloader)} ${isVisible(preloader) ? 'VISIBLE' : 'invisible'}`),
      rowShowsVisibleSpinner: preloaders.some((preloader) => isVisible(preloader)),
      rowHasInvisiblePreloaderNode: preloaders.some((preloader) => !isVisible(preloader)),
      rowDoc: doc ? {
        id: String(doc.id),
        mimeType: String(doc.mime_type),
        size: Number(doc.size),
        type: String(doc.type),
        fileName: String(doc.file_name),
        thumbCount: (doc.thumbs ?? []).length,
        videoThumbCount: (doc.video_thumbs ?? []).length,
        attributeTypes: (doc.attributes ?? []).map((attribute: any) => String(attribute._)),
        supportsStreaming: !!doc.supportsStreaming
      } : null,
      rowDocCache,
      elementUnderClick: describe(document.elementFromPoint(x, y)),
      hitStack: document.elementsFromPoint(x, y).slice(0, 6).map((element) => describe(element)),
      viewerOpen: !!viewerWhole,
      viewerVideo: viewerVideoElement ? {
        paused: viewerVideoElement.paused,
        currentTime: viewerVideoElement.currentTime,
        readyState: viewerVideoElement.readyState,
        networkState: viewerVideoElement.networkState,
        errorCode: viewerVideoElement.error ? viewerVideoElement.error.code : 0,
        src: viewerVideoElement.currentSrc || viewerVideoElement.getAttribute('src') || ''
      } : null,
      viewerStillImages: viewerImages,
      viewerReceived: viewerMedia ? {
        messageMediaType: String(viewerMedia._),
        documentId: viewerDocument ? String(viewerDocument.id) : '',
        photoId: viewerPhoto ? String(viewerPhoto.id) : '',
        mimeType: viewerDocument ? String(viewerDocument.mime_type) : ''
      } : null,
      toasts: Array.from(document.querySelectorAll('.toast')).map((toast) => toast.textContent ?? ''),
      downloads: [] as string[]
    };
  }, {selector: rowSelector, x: point.x, y: point.y});
}
