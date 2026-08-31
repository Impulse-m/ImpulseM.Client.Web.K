import {assertVideoSentAsFileOpensInTheViewer, attachAsFileThroughUi} from './documentRow';
import {liveLane} from './lane';
import {recorderWebmVideo} from './mediaFixtures';
import {test} from './pair';

/*
 * Issue #118, pinned as the user meets it: the board sent a video AS A FILE, clicked it, and got
 * the row's little preview opened as a picture — pannable, zoomable, not playable. The real
 * Telegram Web opens the media viewer on that file and, when it cannot decode it, says so.
 *
 * Canon is settled and the wire is measured correct (VideoSentAsFilePreviewCanonScenario in the
 * backend repo): force_file means the document carries the filename attribute and nothing else,
 * with thumbs present, no video_thumbs and none of messageMediaDocument's media flags. So the
 * document that reaches the client here is deliberately the hostile one — a video the client can
 * only recognise from its MIME type, with a preview image sitting in the row, and NO width or
 * height anywhere on it, because documentAttributeVideo is exactly what force_file suppresses.
 *
 * The clip is the lane's real VP8+Opus capture, sent through the attach menu's "Document" item —
 * the surface that sets force_file (appMessagesManager.ts:1994). Chromium can decode it, so a
 * healthy client ends this scenario PLAYING the file; a client that cannot decode a given codec
 * is allowed to end it with the refusal toast instead. Both are the viewer answering for the
 * document. Neither of them is the row's preview left on screen as a still picture, and neither
 * of them is silence.
 *
 * The RECIPIENT's side is the one pinned, and deliberately only that one: it is the story the
 * board reported (someone sends a video as a file, the reader clicks it) and it is the side that
 * exercises what the server delivered rather than an echo of a local upload. The sender's own
 * copy is a second lane with failures of its own that are not this issue — see the side findings
 * on #118 — and folding it in here would give this scenario reds it cannot attribute.
 */
test.skip(!liveLane.enabled, liveLane.skipReason);


test('a video sent as a file opens in the recipient\'s media viewer, never as a still picture', async({pair}) => {
  const {sender, recipient} = pair;
  const nonce = Date.now().toString(36);

  await attachAsFileThroughUi(sender, [recorderWebmVideo(`vaf-${nonce}.webm`)]);

  await assertVideoSentAsFileOpensInTheViewer(recipient, 'recipient');
  await recipient.closeMediaViewer();
});
