import {assertVideoSentAsFileOpensInTheViewer, attachAsFileThroughUi, ownDocumentRow, receivedDocumentRow} from './documentRow';
import {liveLane} from './lane';
import {recorderWebmVideo} from './mediaFixtures';
import {test} from './pair';

/*
 * Issue #118, pinned as the user meets it: the board sent a video AS A FILE, clicked it, and got
 * the row's little preview opened as a picture — pannable, zoomable, not playable. The real
 * Telegram Web opens the media viewer on that file and, when it cannot decode it, says so.
 *
 * Issue #119 is the same gesture on the other side of the same send: the board could not open his
 * OWN copy of the file he had just sent. The click landed on a download instead of the viewer.
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
 * healthy client ends these scenarios PLAYING the file; a client that cannot decode a given codec
 * is allowed to end them with the refusal toast instead. Both are the viewer answering for the
 * document. Neither of them is the row's preview left on screen as a still picture, neither is
 * silence, and neither is a download.
 *
 * The two sides are two scenarios on purpose. They are separate stories — one exercises what the
 * server delivered, the other the sender's own echo of an upload that never left his disk — they
 * fail for separate reasons, and keeping them apart is what makes each red attributable and stops
 * a fix for one from quietly trading away the other.
 */
test.skip(!liveLane.enabled, liveLane.skipReason);


test('a video sent as a file opens in the recipient\'s media viewer, never as a still picture', async({pair}) => {
  const {sender, recipient} = pair;
  const nonce = Date.now().toString(36);

  await attachAsFileThroughUi(sender, [recorderWebmVideo(`vaf-${nonce}.webm`)]);

  await assertVideoSentAsFileOpensInTheViewer(recipient, receivedDocumentRow);
  await recipient.closeMediaViewer();
});


/*
 * Issue #119. The sender has the file: it came off his own disk seconds ago and the send has
 * settled. One click on his own row must open it in the media viewer — the same answer his
 * recipient gets. Handing him a download of a file he already has, or nothing at all, is the
 * defect: his copy is the one he is most entitled to open.
 *
 * The click is driven whether or not the row still looks busy (see DocumentRowLane): there is
 * nothing for the sender to wait for, so a download affordance sitting on his row is the state
 * under test rather than a state to wait out, and the capture on failure records whether the row
 * was rebuilt after the server's answer and what the rebuild left behind.
 */
test('the sender can open his own copy of the file he just sent', async({pair}) => {
  const {sender} = pair;
  const nonce = Date.now().toString(36);

  await attachAsFileThroughUi(sender, [recorderWebmVideo(`own-${nonce}.webm`)]);

  await assertVideoSentAsFileOpensInTheViewer(sender, ownDocumentRow);
  await sender.closeMediaViewer();
});
