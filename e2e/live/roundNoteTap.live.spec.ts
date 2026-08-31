import {liveLane} from './lane';
import {expect, test} from './pair';
import {installRoundClickProbe, tapRoundNoteLikeAUser} from './roundClickTarget';

/*
 * Issue #112, reported live: the user taps a round video note and nothing happens — no player,
 * no spinner, no error. The bytes were healthy at the captured failure (the playback element in
 * the DOM with a correct blob src, readyState 4, no MediaError) and play() had never been
 * called; the tap simply never turned into playback.
 *
 * roundNote.live.spec.ts cannot see that shape, and that is not a gap in it: it drives
 * `canvas.video-round-canvas` — the node wrappers/video.ts happens to have attached its handler
 * to — so it asks "does the handler work when called", while the user asks "does my tap reach a
 * handler at all". This scenario asks only the user's question: press the geometric centre of
 * the rendered circle with a real trusted mouse press (page.mouse, no actionability retargeting
 * onto a node an author picked) and require moving video.
 *
 * The invariant is deliberately mechanism-free: tapping a round note plays it, no matter which
 * element the browser decides is topmost at that pixel and no matter how far the send has got.
 * A CSS change that reorders the layers, a refactor that renames the canvas, a wrapper that
 * inserts an overlay — none of them may turn this green while the user's tap stays dead. Nor can
 * the scenario pass without earning it: every tap first asserts the note is SILENT, so a green
 * can only mean the gesture started it.
 *
 * Three surfaces, three different renders of the same bubble, and the tap must work on all:
 *
 *   1. the sender's own note as soon as the client stops asking the user to wait — the send is
 *      NOT awaited first, because a user does not wait for an ack either: the moment the
 *      progress spinner clears, the circle is on screen with its preview moving, so they tap it.
 *      This is the window issue #112 was captured in;
 *   2. the recipient's note as it arrives over push;
 *   3. the sender's note after a reload, rebuilt from server history with no local recording.
 *
 * A dead tap on one surface never hides the others: each outcome is collected and the assertion
 * names every surface that failed, with the hit stack at the tapped pixel, the nodes of the
 * bubble that carry a tap handler, the pointer events the page observed, and the media state.
 */
test.skip(!liveLane.enabled, liveLane.skipReason);


test('tapping the circle of a round video note plays it — as it is sent, as it arrives, and after a reload', async({pair}, testInfo) => {
  const {sender, recipient} = pair;

  // The probe records which nodes register a tap handler, so it must be armed before the round
  // bubble is rendered — i.e. before the send. It needs no reload: the bubble under test does
  // not exist yet on either side.
  await installRoundClickProbe(sender.page);
  await installRoundClickProbe(recipient.page);

  // Deliberately concurrent: the tap waits for the circle to appear and its spinner to clear, and
  // presses it then — what the user does. Awaiting the send's own settle signal first would hand
  // the client an arbitrary head start and turn a defect into a coin toss.
  const sending = sender.sendRoundNoteAsRecorder();
  const outcomes = [await tapRoundNoteLikeAUser(sender, 'sender, as soon as the circle stops asking the user to wait')];
  await sending;

  await recipient.waitForIncomingRoundNote();
  outcomes.push(await tapRoundNoteLikeAUser(recipient, 'recipient, on the note that arrived over push'));

  await sender.reloadAndReopenDialog(recipient.persona.phone);
  outcomes.push(await tapRoundNoteLikeAUser(sender, 'sender, after a reload'));

  // Kept on green as well as red: what the browser hands a finger at the centre of the circle is
  // the evidence every layering theory of a dead tap stands or falls on, and a run that only
  // records it when it fails can testify to nothing when it passes.
  await testInfo.attach('round-note tap points', {
    body: outcomes.map((outcome) => outcome.hitSummary).join('\n\n'),
    contentType: 'text/plain'
  });

  const dead = outcomes.filter((outcome) => !outcome.played).map((outcome) => outcome.report);
  expect(
    dead,
    'the user taps a round video note and nothing happens — no player, no spinner, no error ' +
    '(issue #112). Every report below is one surface whose tap on the centre of the circle ' +
    'produced no moving video; each carries the hit stack at the tapped pixel, the nodes of the ' +
    'bubble that carry a tap handler, the pointer events the page observed, and the media state'
  ).toEqual([]);
});
