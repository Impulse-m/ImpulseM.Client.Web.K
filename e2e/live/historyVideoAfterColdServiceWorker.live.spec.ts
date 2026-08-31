import {expect, test} from '@playwright/test';

import {ephemeralPersona} from '../../src/tests/liveharness/personas';
import {liveLane} from './lane';
import {recorderWebmVideo} from './mediaFixtures';
import {PersonaSession} from './personaSession';

/*
 * The board's report has a shape: the videos that were already in the chat refuse to play, while
 * the ones sent afterwards play fine. This scenario reproduces that ordering in a real browser.
 *
 * Whether a video streams is decided ONCE, when `appDocsManager.saveDoc` first sees the document
 * (appDocsManager.ts:285-306), against whatever the client believes about its service worker at
 * that instant — and the client's belief starts optimistic: the worker realm boots with
 * `isServiceWorkerOnline = true` (appManagersManager.ts:50) and only learns otherwise when the
 * tab's registration finally fails (apiManagerProxy.ts:829). Right after a hard refresh — which
 * this client performs by UNREGISTERING the worker and navigating (apiManagerProxy.ts:804) — the
 * chat history loads within the first seconds, long before that answer arrives. Every document
 * saved in that window is frozen as "streams", and when the answer turns out to be "there is no
 * service worker" nothing re-classifies them: the handler written to do it
 * (`onServiceWorkerFail`, appDocsManager.ts:90) is never delivered the message, because
 * `SuperMessagePort` hands a notification to its FIRST listener only (superMessagePort.ts:675)
 * and the worker's own module-scope handler is registered first. So those documents keep asking
 * a service worker that does not exist for their bytes, for the rest of the tab's life, while
 * every document saved after the answer landed is classified correctly and plays.
 *
 * The sabotage is one honest thing: the service-worker SCRIPT is made slow and then unavailable
 * on the recipient's context — a stalled, failing service-worker update, one of the browser
 * states this client explicitly carries a fallback for. Nothing in the app is patched. The stall
 * is what makes the race deterministic instead of hoping the history wins it; the scenario still
 * refuses to run vacuously and asserts, before touching playback, that the history video really
 * was classified while the client still believed a worker was coming.
 *
 * The other half of the report — "the videos sent afterwards play" — is deliberately NOT sent
 * here. A second album send through this stack reliably trips the sender-side lost ack already
 * pinned by textSendRebind.live.spec.ts (the bubble keeps is-sending although message_sent
 * reached the main thread), which would make this scenario fail for somebody else's defect
 * before it reaches its own subject. What that control would have shown is asserted instead
 * where it is free: the document is read through the page's own managers after the tab has
 * learned it has no service worker, and the red quotes what it still says.
 *
 * Unit cover for the same defect (no live stack): src/tests/documentStreamingFollowsServiceWorker.test.ts
 * and src/tests/voidWorkerMessagesReachEveryListener.test.ts.
 */
test.skip(!liveLane.enabled, liveLane.skipReason);

/**
 * How long the service-worker script is held before it fails. It only has to outlast the chat
 * history load on the reloaded page — the scenario waits for the app's own "SW registration
 * failed!" line rather than for this timer, so a browser that gives up earlier is handled.
 */
const serviceWorkerScriptStallMs = 20_000;

type HistoryVideoState = {
  mid: number,
  documentId: string,
  supportsStreaming: boolean,
  cacheContextUrl: string
};


/**
 * The oldest video bubble's document, read through the page's OWN managers — the same objects the
 * media viewer consults when the user clicks that bubble, not a parallel model.
 */
async function readOldestVideoDocument(session: PersonaSession): Promise<HistoryVideoState> {
  return session.page.evaluate(async() => {
    const w = window as any;
    const chat = w.appImManager?.chat;
    const container: HTMLElement | undefined = chat?.bubbles?.container;
    if(!container) {
      throw new Error('the oldest video document was requested with no open dialog');
    }

    const bubble = Array.from(container.querySelectorAll<HTMLElement>('.bubble[data-mid]'))
      .find((candidate) => !!candidate.querySelector('.video-time'));
    if(!bubble) {
      throw new Error('the open dialog renders no video bubble at all');
    }

    const mid = +bubble.dataset.mid;
    const message = await w.rootScope.managers.appMessagesManager.getMessageByPeer(chat.peerId, mid);
    const document = message?.media?.document;
    if(!document) {
      throw new Error(`the oldest video bubble (mid ${mid}) carries no document in the client's own message`);
    }

    const cacheContext = await w.rootScope.managers.thumbsStorage.getCacheContext(document);
    return {
      mid,
      documentId: String(document.id),
      supportsStreaming: !!document.supportsStreaming,
      cacheContextUrl: cacheContext?.url ?? ''
    };
  });
}


function describeDocument(state: HistoryVideoState): string {
  return `document ${state.documentId} (mid ${state.mid}): supportsStreaming=${state.supportsStreaming}, ` +
    `cache context url="${state.cacheContextUrl.slice(0, 120)}"`;
}


/**
 * Waits for a line the app itself prints. Used for the one transition this scenario cannot
 * observe any other way: the moment the client gives up on its service worker.
 */
async function waitForConsoleEntry(session: PersonaSession, needle: string, timeout: number): Promise<void> {
  await expect
    .poll(() => session.consoleTrail.some((entry) => entry.text.includes(needle)), {
      timeout,
      message: `the ${session.persona.firstName} page never printed "${needle}" — the failing ` +
        'service-worker registration this scenario depends on never landed, so nothing below ' +
        'would be measuring the ordering it exists to measure'
    })
    .toBe(true);
}


test('a video already in the history still plays after the tab loads without its service worker', async({browser}, testInfo) => {
  // Two sign-ups, two video exchanges, a reload and the deliberate service-worker stall do not
  // fit the lane's standing 300s budget.
  test.setTimeout(480_000);

  const sender = await PersonaSession.open(browser, ephemeralPersona(`sender-${testInfo.testId}`));
  const recipient = await PersonaSession.open(browser, ephemeralPersona(`recipient-${testInfo.testId}`));

  try {
    await Promise.all([
      sender.signUpThroughUi(),
      recipient.signUpThroughUi()
    ]);
    await sender.openDialogWithPhone(recipient.persona.phone);
    await recipient.openDialogWithPhone(sender.persona.phone);

    const nonce = Date.now().toString(36);

    // The video under test, exchanged while both sides have a healthy service worker.
    await sender.attachMediaThroughUi([recorderWebmVideo(`cold-sw-history-${nonce}.webm`)]);
    await recipient.waitForIncomingVideoCount(1);

    // Control: on a healthy tab this client streams, so the lane the rest of the scenario
    // measures against is reachable on this stack.
    await recipient.playVideoFromBubble('recipient', 'oldest');
    const healthySrc = await recipient.viewerVideoSrc();
    expect(
      healthySrc.includes('/stream/'),
      `on a tab with a working service worker the video played from "${healthySrc.slice(0, 120)}" ` +
      'instead of the service-worker stream lane — the streaming lane is not what a healthy tab ' +
      'uses on this stack, so every conclusion this scenario draws from the lane would be wrong'
    ).toBe(true);
    await recipient.closeMediaViewer();

    // The sabotage: the service-worker script becomes slow and then unavailable on the
    // recipient's context. Matched on the FULL registered URL, never on the path alone — the
    // page's own module graph imports the same file under a different query
    // (`sw.ts?worker&url`, apiManagerProxy.ts:31) to learn the worker's URL, and stalling that
    // one stops the app from booting at all instead of stalling its service worker.
    const scriptUrl = await recipient.page.evaluate(async() => {
      const registrations = await navigator.serviceWorker.getRegistrations();
      const registration = registrations[0];
      const worker = registration?.active ?? registration?.waiting ?? registration?.installing;
      return worker?.scriptURL ?? '';
    });
    expect(
      scriptUrl,
      'the recipient page has no registered service worker to begin with, so the scenario cannot ' +
      'stall its script and would silently test a tab that never had a worker at all'
    ).not.toBe('');

    const stalledRequests: string[] = [];
    await recipient.page.context().route(
      (url) => url.href === scriptUrl,
      async(route) => {
        stalledRequests.push(route.request().url());
        await new Promise((resolve) => setTimeout(resolve, serviceWorkerScriptStallMs));
        await route.abort();
      }
    );

    // What the client's own hard-refresh path does before navigating (apiManagerProxy.ts:804):
    // drop the registration, so the next load has to register from scratch.
    await recipient.page.evaluate(async() => {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    });

    await recipient.reloadAndReopenDialog(sender.persona.phone);
    await recipient.waitForIncomingVideoCount(1);

    // Non-vacuity, and the race asserted directly: the history video must have been classified
    // while the client still believed a service worker was coming. If the failure had already
    // landed, the document would have been classified correctly and the run would prove nothing.
    const whileWorkerPending = await readOldestVideoDocument(recipient);
    expect(
      whileWorkerPending.supportsStreaming,
      'the history video was NOT classified as streamable during the boot window — the client ' +
      'learned it has no service worker before the history loaded, so this run never reproduced ' +
      `the ordering it exists to reproduce (${describeDocument(whileWorkerPending)})`
    ).toBe(true);

    await waitForConsoleEntry(recipient, 'SW registration failed', serviceWorkerScriptStallMs + 90_000);
    expect(
      stalledRequests,
      'the stall hit something other than exactly the service-worker registration script — the ' +
      'scenario is no longer isolating the service worker and whatever it broke instead would be ' +
      'blamed on the defect under test'
    ).toEqual([scriptUrl]);

    const afterWorkerFailed = await readOldestVideoDocument(recipient);

    // The board's gesture: open the video that was already in the chat when the tab loaded.
    await recipient.playVideoFromBubble('recipient', 'oldest').catch((error: Error) => {
      throw new Error(
        'a video that was in the history when the tab loaded can never be played in this tab. It ' +
        'was classified as streamable in the first seconds of the boot, before the tab found out ' +
        'it has no service worker, and nothing ever re-classified it — so every click on it asks a ' +
        'service worker that does not exist for the bytes and the user gets "Unfortunately, this ' +
        'video can\'t be played". A video that arrives after the tab found out is classified ' +
        'against the truth and plays, which is why the report reads as "the old videos are broken".\n' +
        `the same document, read through the page's own managers, right after the tab found out:\n` +
        `  ${describeDocument(afterWorkerFailed)}\n${error.message}`
      );
    });
    await recipient.closeMediaViewer();

    expect(
      afterWorkerFailed.supportsStreaming,
      'the tab knows it has no service worker and still has the history video marked as streamable ' +
      '— every playback of it will keep being pointed at a stream URL nothing answers, for the ' +
      `life of this tab (${describeDocument(afterWorkerFailed)})`
    ).toBe(false);

    // Console clean over both pages, minus the one failure this scenario deliberately caused:
    // the service-worker registration it stalled. Everything else still counts.
    const deliberate = 'SW registration failed';
    const combined = [
      ...[...new Set(sender.consoleClean.failures)].map((entry) => `[sender] ${entry}`),
      ...[...new Set(recipient.consoleClean.failures)]
        .filter((entry) => !entry.includes(deliberate))
        .map((entry) => `[recipient] ${entry}`)
    ];
    expect(
      combined,
      `CONSOLE CLEAN violated during "${testInfo.title}" — every entry below is an error the real ` +
      'user\'s console showed. The service-worker registration failure this scenario caused on ' +
      'purpose is excluded; nothing else is'
    ).toEqual([]);
  } finally {
    await sender.close();
    await recipient.close();
  }
});
