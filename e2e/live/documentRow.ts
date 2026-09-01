import {expect, Locator, Page} from '@playwright/test';

import type {MediaPayload} from './mediaFixtures';
import type {PersonaSession} from './personaSession';

/*
 * Issue #118 instrumentation: "a video sent AS A FILE, clicked, opens its THUMBNAIL as a photo".
 * Issue #119 reuses it for the other half of the same gesture: the SENDER cannot open his own
 * copy of the file he just sent.
 *
 * The reference client answers that click with the media viewer — it either plays the video or
 * says it cannot be played there. What it never does is hand the user the row's little preview
 * as a still picture to pan and zoom, it never answers the click with silence, and it never
 * answers it with a download of a file the user already has.
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
 *     the user can see it and whether it is waiting for a manual click (preloader.ts:152), and
 *     the document object the row itself carries (wrappers/document.ts:158 pins `doc` onto the
 *     div) with mime, size, thumbs and attribute vector — so a client-side routing defect is
 *     distinguishable from a wire that arrived without thumbs or without a video mime;
 *   - whether the row the user clicked is the one the client first built or a REBUILT one, and
 *     what the rebuild swapped in: bubbles.ts:1057-1071 replaces the whole `.document` div when
 *     the server's document carries thumbs the temp one did not, and the replacement is wrapped
 *     without `autoDownloadSize`, so it comes back carrying a manual preloader that nothing will
 *     ever click. The rebuild log records both sides of every swap with their thumb counts, which
 *     is the exact asymmetry issue #119 names — a red can then say "the row was rebuilt, from a
 *     0-thumb temp document into a 4-thumb one, and the new row came with a manual preloader"
 *     rather than only "the click did nothing";
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

/**
 * The lookup bubbles.ts:3730-3745 performs before it will open anything: it reads the mid and the
 * peer off the row's own `.document-container` (or the bubble, for a grouped item) and asks the
 * chat for that message. A row whose click does nothing at all, with no viewer, no toast and no
 * console entry, is most often a row whose message the client can no longer find behind it — so
 * the capture resolves the same lookup and reports what came back, rather than leaving the red to
 * say only that nothing happened.
 */
export type RowMessageLookup = {
  bubbleMid: string,
  bubblePeerId: string,
  containerMid: string,
  containerPeerId: string,
  containerIndex: string,
  fullMidTheClientWouldLookUp: string,
  messageFound: boolean,
  messageMediaType: string,
  messageDocumentId: string
};

export type DocumentCacheState = {
  downloaded: boolean,
  url: string,
  type: string
};

/**
 * One swap of a `.document` row for a freshly wrapped one, as the page saw it happen. The thumb
 * counts on both sides are what decides whether bubbles.ts:1061 rebuilds at all.
 */
export type DocumentRowRebuild = {
  msAfterArming: number,
  removedDocId: string,
  removedThumbs: number,
  removedClasses: string,
  addedDocId: string,
  addedThumbs: number,
  addedClasses: string,
  addedPreloaders: number,
  /** Preloaders in the new row waiting for a click that only `autoDownloadSize` would deliver. */
  addedManualPreloaders: number
};

/**
 * What the page recorded from the moment it was armed: every row swap, and when the DOM last
 * moved at all. The second one is not decoration — bubbles.ts drops a click that lands inside a
 * heavy-animation window entirely (no viewer, no toast, no handler), so a click driven while the
 * page is still re-rendering measures that drop instead of the defect under test. The lane waits
 * the page out and records how long it was still, so the red can never be confused for it.
 */
export type RowRecorder = {
  armedAt: number,
  lastMutationAt: number,
  rebuilds: DocumentRowRebuild[]
};

/**
 * The state the user's click was driven from. Every field exists to keep a red attributable:
 * a click on a row that was still spinning, or on a page that was still moving under it, is a
 * measurement of something other than "can he open his file".
 */
export type ClickReadiness = {
  rowWentQuiet: boolean,
  msWaitedForTheRowToGoQuiet: number,
  pageWentStill: boolean,
  msWaitedForThePageToGoStill: number,
  /** Row swaps already recorded when the click was driven; more after it means a race. */
  rebuildsBeforeTheClick: number
};

export type DocumentRowClickCapture = {
  rowFound: boolean,
  rowClasses: string,
  /** bubbles.ts routes a click to the media viewer only through a `document-with-thumb` row. */
  rowHasThumbClass: boolean,
  /** Every `.preloader-container` left in the row, each labelled visible/invisible and manual. */
  rowPreloaders: string[],
  rowShowsVisibleSpinner: boolean,
  /** A finished spinner whose node stayed behind: the user sees nothing, the router sees a block. */
  rowHasInvisiblePreloaderNode: boolean,
  rowDoc: RowDocument | null,
  rowDocCache: DocumentCacheState | null,
  rowMessage: RowMessageLookup | null,
  readiness: ClickReadiness,
  /** null when this page was never armed to record. */
  rowRecorder: RowRecorder | null,
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
 * rest are the failure shapes issues #118 and #119 are made of.
 */
export type DocumentRowOutcome =
  'the media viewer is playing the file' |
  'the client reported the video cannot be played here' |
  'the media viewer opened on the still preview and never played it' |
  'the click only downloaded the file' |
  'nothing opened at all';

/**
 * Which copy of the file the scenario drives. The two are the same gesture on two different
 * stories, and they need to be told apart in three places:
 *
 *   - the bubble: the recipient clicks what the server delivered, the sender clicks his own
 *     settled echo of an upload, and a scenario about one must never be able to satisfy itself
 *     against the other;
 *   - the patience: the recipient's row legitimately has bytes to fetch before "click" can mean
 *     "open", so a row still spinning at the deadline is a failure of its own and is named as
 *     one. The sender's copy came off his own disk — there is nothing to fetch, so a download
 *     affordance left sitting on it is not a state to wait out, it is precisely the state issue
 *     #119 reports, and the click has to be driven THROUGH it or the outcome is never measured;
 *   - the words a missing row deserves.
 */
export type DocumentRowLane = {
  side: string,
  selector: string,
  requiresQuietRowBeforeClick: boolean,
  quietTimeoutMs: number,
  missingRowReason: string
};

export const receivedDocumentRow: DocumentRowLane = {
  side: 'recipient',
  selector: '.bubble[data-mid].is-in:not(.is-outgoing):not(.is-sending) .document[data-doc-id]',
  requiresQuietRowBeforeClick: true,
  quietTimeoutMs: 90_000,
  missingRowReason: 'the message either never arrived or was rendered as something other than a document'
};

export const ownDocumentRow: DocumentRowLane = {
  side: 'sender',
  selector: '.bubble[data-mid].is-out:not(.is-outgoing):not(.is-sending) .document[data-doc-id]',
  requiresQuietRowBeforeClick: false,
  quietTimeoutMs: 30_000,
  missingRowReason: 'the sender\'s own bubble settled without a file row — the send was rebuilt ' +
    'into something that is not a document, or never settled at all'
};

/**
 * How long the page must have stopped moving before the click counts as the user's, and how long
 * the lane is willing to wait for that. A page that never goes still is not a reason to skip the
 * scenario — the click is driven anyway and the capture records that it was.
 */
const pageStillnessMs = 1_500;
const pageStillnessTimeoutMs = 30_000;

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
 *
 * The rebuild recorder is armed on the sender's page BEFORE the file is attached, because the
 * swap it exists to catch happens between the temp bubble and the server's answer.
 */
export async function attachAsFileThroughUi(session: PersonaSession, files: MediaPayload[]): Promise<void> {
  const page = session.page;
  await recordDocumentRowRebuilds(session);
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
 * Watches the page for `.document` rows being swapped out for freshly wrapped ones — the
 * bubbles.ts:1057-1071 rebuild — records both sides of every swap, and keeps the timestamp of the
 * last DOM movement of any kind. Reading the DOM rather than patching the client keeps the
 * observation outside the code under test: nothing here can change what the client does, only
 * witness it. Idempotent, so a scenario can arm it early and the assertion can arm it again.
 */
export async function recordDocumentRowRebuilds(session: PersonaSession): Promise<void> {
  await session.page.evaluate(() => {
    const holder = window as unknown as {impulseRowRecorder?: {armedAt: number, lastMutationAt: number, rebuilds: unknown[]}};
    if(holder.impulseRowRecorder) {
      return;
    }

    const armedAt = Date.now();
    const recorder = {armedAt, lastMutationAt: armedAt, rebuilds: [] as unknown[]};
    holder.impulseRowRecorder = recorder;
    const log = recorder.rebuilds;

    const asDocumentRow = (node: Node): Element | null => {
      if(!(node instanceof Element)) {
        return null;
      }

      return node.matches('.document') ? node : node.querySelector('.document');
    };

    const thumbsOf = (element: Element | null): number => {
      const doc = element ? (element as unknown as {doc?: {thumbs?: unknown[]}}).doc : undefined;
      return (doc?.thumbs ?? []).length;
    };

    const observer = new MutationObserver((records) => {
      recorder.lastMutationAt = Date.now();
      for(const record of records) {
        const removed = Array.from(record.removedNodes).map(asDocumentRow).find((element) => !!element);
        if(!removed) {
          continue;
        }

        const added = Array.from(record.addedNodes).map(asDocumentRow).find((element) => !!element) ?? null;
        const preloaders = added ? Array.from(added.querySelectorAll('.preloader-container')) : [];
        log.push({
          msAfterArming: Date.now() - armedAt,
          removedDocId: removed.getAttribute('data-doc-id') ?? '',
          removedThumbs: thumbsOf(removed),
          removedClasses: removed.className,
          addedDocId: added?.getAttribute('data-doc-id') ?? '',
          addedThumbs: thumbsOf(added),
          addedClasses: added ? added.className : '(nothing replaced it)',
          addedPreloaders: preloaders.length,
          addedManualPreloaders: preloaders.filter((preloader) => preloader.classList.contains('manual')).length
        });
      }
    });

    observer.observe(document.body, {childList: true, subtree: true});
  });
}


/**
 * The file row of the newest settled message on the lane's own side. Which side is never left to
 * the ambient DOM: a scenario about what the server delivered must not be able to assert against
 * the sender's own echo of its upload, and a scenario about the sender's own copy must not be
 * able to satisfy itself against anything else.
 */
export function documentRow(page: Page, lane: DocumentRowLane): Locator {
  return page.locator(lane.selector).last();
}


export async function waitForDocumentRow(session: PersonaSession, lane: DocumentRowLane): Promise<void> {
  await documentRow(session.page, lane)
    .waitFor({state: 'visible', timeout: 90_000})
    .catch(() => {
      throw new Error(
        `the file the sender attached never appeared as a file row on the ${lane.side} side — ` +
        lane.missingRowReason
      );
    });
}


/**
 * The whole invariant of issues #118 and #119, driven as the user drives it: one click on the
 * file row of a video sent as a file must end in the media viewer showing THAT document —
 * playing it, or saying it cannot be played — and never in the row's preview left on screen as a
 * still picture, never in a bare download, never in silence. It holds for the reader of the file
 * and for the person who sent it; the sender's own copy is already on his device, so for him a
 * download is not merely the wrong answer, it is an answer to a question he never asked.
 */
export async function assertVideoSentAsFileOpensInTheViewer(
  session: PersonaSession,
  lane: DocumentRowLane
): Promise<void> {
  const page = session.page;
  const side = lane.side;
  const row = documentRow(page, lane);
  await recordDocumentRowRebuilds(session);
  await waitForDocumentRow(session, lane);

  // A row the user can still SEE spinning is a row asking for a download, not a row asking to be
  // opened; auto-download (3 MiB in a private chat, config/state.ts:457) clears it on its own for
  // a clip this size. On the receiving lane a spinner that never clears is a named failure of its
  // own rather than a click landing on a state the user would never click in. On the sender's own
  // copy there is nothing to download in the first place, so the wait is a grace period for the
  // rebuild to land and never a verdict — the click is driven either way and judged on its result.
  const rowQuietFrom = Date.now();
  const rowWentQuiet = await page
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
    }, lane.selector, {timeout: lane.quietTimeoutMs})
    .then(() => true)
    .catch(() => false);
  const msWaitedForTheRowToGoQuiet = Date.now() - rowQuietFrom;

  if(!rowWentQuiet && lane.requiresQuietRowBeforeClick) {
    const capture = await captureDocumentRowState(page, lane, {x: 0, y: 0}, {
      rowWentQuiet,
      msWaitedForTheRowToGoQuiet,
      pageWentStill: false,
      msWaitedForThePageToGoStill: 0,
      rebuildsBeforeTheClick: 0
    });
    throw new Error(
      `the file row on the ${side} side never stopped showing its download spinner, so the user ` +
      'never reached the state in which a click means "open this file".\n' +
      describeDocumentRowClick(capture)
    );
  }

  // The user does not click at millisecond 18 of a re-render — he looks at a row that has stopped
  // moving and then clicks it. The client makes that distinction load-bearing: bubbles.ts drops a
  // click that lands inside a heavy-animation window on the floor, with no viewer, no toast and no
  // handler, which is indistinguishable on screen from the defect under test. So the gesture waits
  // until the page itself has been still, and the wait's own result is recorded either way: a red
  // driven from a page that never went still says so in its own words instead of being mistaken
  // for "the click does not open the file".
  const stillFrom = Date.now();
  const pageWentStill = await page
    .waitForFunction((stillnessMs: number) => {
      const recorder = (window as any).impulseRowRecorder;
      return !!recorder && (Date.now() - recorder.lastMutationAt) >= stillnessMs;
    }, pageStillnessMs, {timeout: pageStillnessTimeoutMs})
    .then(() => true)
    .catch(() => false);

  const readiness: ClickReadiness = {
    rowWentQuiet,
    msWaitedForTheRowToGoQuiet,
    pageWentStill,
    msWaitedForThePageToGoStill: Date.now() - stillFrom,
    rebuildsBeforeTheClick: await page.evaluate(() => {
      return ((window as any).impulseRowRecorder?.rebuilds ?? []).length as number;
    })
  };

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
    let capture = await captureDocumentRowState(page, lane, point, readiness);
    while(!isPlaying(capture) && !hasRefusal(capture) && Date.now() < deadline) {
      await page.waitForTimeout(250);
      capture = await captureDocumentRowState(page, lane, point, readiness);
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
      'viewer, which then plays the video or says it cannot be played here (issues #118/#119).\n' +
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
      'reported in issue #118 — the file behaving like a picture — and a silent download of a ' +
      'file the sender already has is issue #119.\n' +
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
  lines.push(describeReadiness(capture.readiness, capture.rowRecorder));
  lines.push(`  the document the row carries: ${describeRowDocument(capture.rowDoc)}`);
  lines.push(`  that document's cache context: ${describeDocumentCache(capture.rowDocCache)}`);
  lines.push(`  the message the client resolves behind the row: ${describeRowMessage(capture.rowMessage)}`);
  lines.push(describeRebuilds(capture.rowRecorder));
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


function describeReadiness(readiness: ClickReadiness, recorder: RowRecorder | null): string {
  const rebuiltAfterTheClick = recorder ?
    recorder.rebuilds.length - readiness.rebuildsBeforeTheClick :
    0;
  return `  row stopped looking busy before the click: ${readiness.rowWentQuiet} ` +
    `(waited ${readiness.msWaitedForTheRowToGoQuiet}ms); page stopped moving before the click: ` +
    `${readiness.pageWentStill} (waited ${readiness.msWaitedForThePageToGoStill}ms for ` +
    `${pageStillnessMs}ms of stillness); row swaps that landed AFTER the click: ${rebuiltAfterTheClick}`;
}


function describeRebuilds(recorder: RowRecorder | null): string {
  if(recorder === null) {
    return '  row rebuilds: (this page was never armed to record them)';
  }

  const armedFor = Date.now() - recorder.armedAt;
  if(recorder.rebuilds.length === 0) {
    return `  row rebuilds in the ${armedFor}ms since the recorder was armed: none — the row the ` +
      'user clicked is the one the client first built';
  }

  const lines = recorder.rebuilds.map((rebuild) => {
    return `    +${rebuild.msAfterArming}ms: doc ${rebuild.removedDocId || '(none)'} with ` +
      `${rebuild.removedThumbs} thumbs [${rebuild.removedClasses}] -> doc ` +
      `${rebuild.addedDocId || '(none)'} with ${rebuild.addedThumbs} thumbs ` +
      `[${rebuild.addedClasses}], preloaders in the new row: ${rebuild.addedPreloaders} ` +
      `(waiting for a manual click: ${rebuild.addedManualPreloaders})`;
  });
  return [`  row rebuilds in the ${armedFor}ms since the recorder was armed: ${recorder.rebuilds.length}`, ...lines].join('\n');
}


function describeRowMessage(lookup: RowMessageLookup | null): string {
  if(!lookup) {
    return '(no row to resolve one from)';
  }

  return `bubble mid=${lookup.bubbleMid || '(none)'} peer=${lookup.bubblePeerId || '(none)'}; ` +
    `document-container mid=${lookup.containerMid || '(none)'} peer=${lookup.containerPeerId || '(none)'} ` +
    `index=${lookup.containerIndex || '(none)'}; the client would look up ` +
    `"${lookup.fullMidTheClientWouldLookUp || '(nothing — it cannot even build a full mid)'}" and ` +
    `${lookup.messageFound ?
      `finds ${lookup.messageMediaType} carrying document ${lookup.messageDocumentId || '(none)'}` :
      'FINDS NOTHING — bubbles.ts refuses the click at this point and returns in silence'}`;
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


async function captureDocumentRowState(
  page: Page,
  lane: DocumentRowLane,
  point: {x: number, y: number},
  readiness: ClickReadiness
): Promise<DocumentRowClickCapture> {
  return page.evaluate(async({selector, x, y, readiness}) => {
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

    let rowMessage: {
      bubbleMid: string,
      bubblePeerId: string,
      containerMid: string,
      containerPeerId: string,
      containerIndex: string,
      fullMidTheClientWouldLookUp: string,
      messageFound: boolean,
      messageMediaType: string,
      messageDocumentId: string
    } | null = null;
    if(row) {
      const bubbleElement = row.closest('.bubble') as HTMLElement | null;
      const containerElement = row.closest('.document-container') as HTMLElement | null;
      const index = containerElement?.dataset.index;
      const lookupFrom = (index !== undefined && +index !== -1) ?
        bubbleElement :
        (containerElement ?? bubbleElement);
      const peerId = lookupFrom?.dataset.peerId ?? '';
      const mid = lookupFrom?.dataset.mid ?? '';
      const fullMid = peerId && mid ? `${peerId}_${mid}` : '';

      let message: any = null;
      try {
        message = fullMid ? (window as any).appImManager?.chat?.getMessage?.(fullMid) : null;
      } catch(ignored) {
        message = null;
      }

      rowMessage = {
        bubbleMid: bubbleElement?.dataset.mid ?? '',
        bubblePeerId: bubbleElement?.dataset.peerId ?? '',
        containerMid: containerElement?.dataset.mid ?? '',
        containerPeerId: containerElement?.dataset.peerId ?? '',
        containerIndex: index ?? '',
        fullMidTheClientWouldLookUp: fullMid,
        messageFound: !!message,
        messageMediaType: String(message?.media?._ ?? ''),
        messageDocumentId: message?.media?.document ? String(message.media.document.id) : ''
      };
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
      rowPreloaders: preloaders.map((preloader) => {
        return `${describe(preloader)} ${isVisible(preloader) ? 'VISIBLE' : 'invisible'} ` +
          `${preloader.classList.contains('manual') ? 'MANUAL (waiting for a click nothing sends)' : 'not-manual'}`;
      }),
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
      rowMessage,
      readiness,
      rowRecorder: ((window as any).impulseRowRecorder ?? null) as RowRecorder | null,
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
  }, {selector: lane.selector, x: point.x, y: point.y, readiness});
}
