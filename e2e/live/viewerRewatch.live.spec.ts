import {liveLane} from './lane';
import {recorderWebmVideo, structuredPhoto} from './mediaFixtures';
import {test} from './pair';

/*
 * The board's live failure shape for the MEDIA VIEWER: opening a video full-screen dies with
 * the "Unfortunately, this video can't be played" toast, and the viewer's own failure record
 * says {code: 4, sourceKind: "blob", networkState: 3, readyState: 0} — a blob: src the
 * browser could read nothing from. Server bytes are exonerated (document sizes match storage,
 * the converted media probes valid), so the suspect is the URL's LIFETIME inside the client:
 * full-size media blobs share the worker's capped object-URL budget with every thumbnail, and
 * a wrongly released URL only becomes observably dead after the worker's grace TTL fires.
 *
 * videoPlayback.live.spec.ts already proves the FRESH journey green: attach, click, viewer
 * plays. What it never exercises is the journey the board actually performs — REWATCHING a
 * video it had already opened, after newer media went through the same session and the
 * object-URL grace TTL has long expired. This scenario pins exactly that journey, on both
 * sides (the sender rewatches its own upload, the recipient rewatches what push delivered).
 *
 * On a red, the mediaPlayback.ts capture names the dead lane and — decisive for this defect —
 * probes fetch(src) from the page: a rejected fetch on a blob: src IS a revoked object URL; a
 * resolved fetch (size and type reported) means the bytes are alive and the browser refused
 * the CONTENT instead. The viewer's own 'video failed to play' record is captured verbatim.
 */
test.skip(!liveLane.enabled, liveLane.skipReason);

// Mirrors OBJECT_URL_GRACE_TTL in src/lib/mainWorker/objectUrlRegistry.ts: a shared blob URL
// that loses its last owner and pin is revoked this long after the release. Rewatching before
// the TTL fires can ride the grace period and stay green even when the release was wrong —
// dwelling past it is what makes a lifetime defect observable.
const objectUrlGraceTtlMs = 30_000;

test('a video watched earlier still plays in the media viewer after newer media churned the session', async({pair}) => {
  const {sender, recipient} = pair;
  const nonce = Date.now().toString(36);

  // The video under test: exchanged, then watched once by BOTH sides — this is what hands
  // each side's media pipeline a blob URL to (mis)manage for the rest of the session.
  await sender.attachMediaThroughUi([recorderWebmVideo(`rewatch-target-${nonce}.webm`)]);
  await sender.playVideoFromBubble('sender', 'oldest');
  await sender.closeMediaViewer();

  await recipient.waitForIncomingVideoCount(1);
  await recipient.playVideoFromBubble('recipient', 'oldest');
  await recipient.closeMediaViewer();

  // Newer media through the same session: a photo album (thumbnail traffic through the same
  // shared object-URL budget) plus two more videos, the newest of which both sides watch —
  // the board's chat is exactly this kind of media churn between two viewings.
  await sender.attachMediaThroughUi([
    structuredPhoto(`churn-photo-1-${nonce}.png`, 640, 480),
    structuredPhoto(`churn-photo-2-${nonce}.png`, 480, 640)
  ]);
  await sender.attachMediaThroughUi([recorderWebmVideo(`churn-clip-1-${nonce}.webm`)]);
  await sender.attachMediaThroughUi([recorderWebmVideo(`churn-clip-2-${nonce}.webm`)]);

  await recipient.waitForIncomingVideoCount(3);
  await recipient.playVideoFromBubble('recipient', 'newest');
  await recipient.closeMediaViewer();
  await sender.playVideoFromBubble('sender', 'newest');
  await sender.closeMediaViewer();

  // Dwell past the worker's object-URL grace TTL: a URL whose ownership was wrongly released
  // during the churn is still fetchable until the grace timer fires, so rewatching earlier
  // would ride the grace period and mask the defect.
  await sender.page.waitForTimeout(objectUrlGraceTtlMs + 5_000);

  // The board's failing gesture: reopen the FIRST video full-screen. Playback must start —
  // anything else is the "Unfortunately, this video can't be played" toast, and the capture
  // says whether the blob URL was revoked or the content was refused.
  await recipient.playVideoFromBubble('recipient', 'oldest');
  await recipient.closeMediaViewer();
  await sender.playVideoFromBubble('sender', 'oldest');
  await sender.closeMediaViewer();
});
