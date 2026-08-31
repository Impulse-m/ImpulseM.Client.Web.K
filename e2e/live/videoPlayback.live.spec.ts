import {liveLane} from './lane';
import {recorderWebmVideo} from './mediaFixtures';
import {test} from './pair';

/*
 * Defect A localization scenario (board report: "a video cannot be played at all"): a PLAIN
 * video — no round note, no album — exchanged on a fresh profile pair, click-to-played by
 * BOTH sides through the real UI (bubble click -> media viewer -> playback must advance).
 *
 * The point of this scenario is the answer to one question: does the board's dead-video
 * defect reproduce for plain video, or only for round notes (roundNote.live.spec.ts)?
 * Green here + red on the round note is a real localization to the round-note pipeline;
 * red here localizes further via the instrumented failure (mediaPlayback.ts), which names
 * the broken lane: no source, refused src (blob vs service-worker stream URL), decode
 * error, or a click that never turned into a play() call.
 *
 * Sender and recipient exercise DIFFERENT playback lanes on purpose: the sender plays the
 * video it just uploaded (locally cached bytes), the recipient plays what the server
 * delivered over push (typically the service-worker /stream/ lane) — a red on exactly one
 * side is itself a localization.
 */
test.skip(!liveLane.enabled, liveLane.skipReason);


test('a plain video message click-plays for the sender and for the recipient', async({pair}) => {
  const {sender, recipient} = pair;
  const nonce = Date.now().toString(36);

  await sender.attachMediaThroughUi([recorderWebmVideo(`plain-video-${nonce}.webm`)]);

  await sender.playVideoFromBubble('sender');
  await sender.closeMediaViewer();

  await recipient.waitForIncomingVideo();
  await recipient.playVideoFromBubble('recipient');
  await recipient.closeMediaViewer();
});
