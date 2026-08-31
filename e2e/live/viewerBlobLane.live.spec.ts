import {expect, test} from '@playwright/test';

import {ephemeralPersona} from '../../src/tests/liveharness/personas';
import {liveLane} from './lane';
import {recorderWebmVideo, structuredPhoto} from './mediaFixtures';
import {PersonaSession} from './personaSession';

/*
 * The BLOB lane of media-viewer video playback — the lane behind the board's live failure
 * record {code: 4, sourceKind: "blob", networkState: 3, readyState: 0} and its
 * "Unfortunately, this video can't be played" toast.
 *
 * With a service worker online this client streams every plain video (/stream/ URLs), so no
 * default-configured scenario can ever reproduce a blob-src failure: viewerRewatch run #1
 * proved every exchanged video plays over the stream lane. The blob lane is reached when
 * appDocsManager marks a document supportsStreaming=false (appDocsManager.ts:286-306), which
 * happens for every ROUND message and — for ALL videos — whenever the service worker is not
 * online: a real browser state (first load before SW activation, a private window, a failed
 * SW update) the client explicitly carries a fallback for. This scenario opens both personas
 * with service workers BLOCKED, so every viewer playback must ride the worker-minted blob
 * URL: download -> object URL created in the worker realm -> <video src="blob:...">.
 *
 * The journey then mirrors the board: watch a video, let newer media churn the shared
 * object-URL budget, dwell past the worker's grace TTL (a wrongly released URL is only
 * OBSERVABLY dead once the grace timer fires), and rewatch the same video full-screen. On a
 * red, mediaPlayback.ts probes fetch(src) from the page: a rejected fetch on the blob src IS
 * a revoked object URL; a resolved fetch (size/type reported) means the bytes were alive and
 * the browser refused the content — the two defects the board's toast cannot distinguish.
 */
test.skip(!liveLane.enabled, liveLane.skipReason);

// Mirrors OBJECT_URL_GRACE_TTL in src/lib/mainWorker/objectUrlRegistry.ts.
const objectUrlGraceTtlMs = 30_000;

async function expectViewerPlayedFromBlob(session: PersonaSession, side: string): Promise<void> {
  const src = await session.viewerVideoSrc();
  expect(
    src.startsWith('blob:'),
    `the ${side} side's media viewer played from "${src.slice(0, 80)}" instead of a blob: URL — ` +
    'with the service worker blocked every video must take the worker-minted blob lane, so this ' +
    'scenario stopped testing the lane the board\'s failure record names'
  ).toBe(true);
}

test('with no service worker, viewer playback rides the blob lane and survives churn and the grace TTL', async({browser}, testInfo) => {
  const sender = await PersonaSession.open(
    browser,
    ephemeralPersona(`sender-${testInfo.testId}`),
    {blockServiceWorkers: true}
  );
  const recipient = await PersonaSession.open(
    browser,
    ephemeralPersona(`recipient-${testInfo.testId}`),
    {blockServiceWorkers: true}
  );

  try {
    await Promise.all([
      sender.signUpThroughUi(),
      recipient.signUpThroughUi()
    ]);
    await sender.openDialogWithPhone(recipient.persona.phone);
    await recipient.openDialogWithPhone(sender.persona.phone);

    // Non-vacuity: the app itself must see the service worker as offline, otherwise every
    // assertion below silently runs on the stream lane again.
    for(const [side, session] of [['sender', sender], ['recipient', recipient]] as const) {
      const swOnline = await session.page.evaluate(() => {
        return (window as any).apiManagerProxy?.isServiceWorkerOnline?.();
      });
      expect(
        swOnline,
        `the ${side} page still reports its service worker as online although the context ` +
        'blocks service workers — the blob-lane precondition failed and this scenario would ' +
        'test nothing'
      ).not.toBe(true);
    }

    const nonce = Date.now().toString(36);

    // The video under test, watched once by both sides — this hands each side a blob URL.
    await sender.attachMediaThroughUi([recorderWebmVideo(`blob-target-${nonce}.webm`)]);
    await sender.playVideoFromBubble('sender', 'oldest');
    await expectViewerPlayedFromBlob(sender, 'sender');
    await sender.closeMediaViewer();

    await recipient.waitForIncomingVideoCount(1);
    await recipient.playVideoFromBubble('recipient', 'oldest');
    await expectViewerPlayedFromBlob(recipient, 'recipient');
    await recipient.closeMediaViewer();

    // Newer media through the same shared object-URL budget.
    await sender.attachMediaThroughUi([
      structuredPhoto(`blob-churn-photo-1-${nonce}.png`, 640, 480),
      structuredPhoto(`blob-churn-photo-2-${nonce}.png`, 480, 640)
    ]);
    await sender.attachMediaThroughUi([recorderWebmVideo(`blob-churn-clip-${nonce}.webm`)]);

    await recipient.waitForIncomingVideoCount(2);
    await recipient.playVideoFromBubble('recipient', 'newest');
    await expectViewerPlayedFromBlob(recipient, 'recipient');
    await recipient.closeMediaViewer();
    await sender.playVideoFromBubble('sender', 'newest');
    await expectViewerPlayedFromBlob(sender, 'sender');
    await sender.closeMediaViewer();

    // Past the grace TTL a wrongly released blob URL is revoked and observably dead.
    await sender.page.waitForTimeout(objectUrlGraceTtlMs + 5_000);

    // The board's failing gesture: reopen the earlier video full-screen, on the blob lane.
    await recipient.playVideoFromBubble('recipient', 'oldest');
    await expectViewerPlayedFromBlob(recipient, 'recipient');
    await recipient.closeMediaViewer();
    await sender.playVideoFromBubble('sender', 'oldest');
    await expectViewerPlayedFromBlob(sender, 'sender');
    await sender.closeMediaViewer();

    // Same console-clean discipline as the standing pair fixture: any error-level entry on
    // either page is a user-visible failure this scenario must not swallow.
    const combined = [
      ...[...new Set(sender.consoleClean.failures)].map((entry) => `[sender] ${entry}`),
      ...[...new Set(recipient.consoleClean.failures)].map((entry) => `[recipient] ${entry}`)
    ];
    expect(
      combined,
      `CONSOLE CLEAN violated during "${testInfo.title}" — every entry below is an error the ` +
      'real user\'s console showed. Entries are verbatim, prefixed with the persona whose ' +
      'page produced them'
    ).toEqual([]);
  } finally {
    await sender.close();
    await recipient.close();
  }
});
