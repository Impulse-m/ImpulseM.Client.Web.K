import {liveLane} from './lane';
import type {PersonaSession} from './personaSession';
import {expect, test} from './pair';
import {
  installRoundClickProbe,
  pressUnackedRoundNoteLikeAUser,
  RoundNoteTarget,
  roundNoteMidsOldestFirst,
  RoundTapOutcome,
  stopRoundPlayback,
  tapRoundNoteLikeAUser,
  UnackedPressOutcome,
  waitForRoundNoteCount
} from './roundClickTarget';

/*
 * Reported live from the board, on top of the fix that put the tap handler on the circle at build
 * time (f588256ad): "Кружок работает, но чтобы он заработал, мне надо покликать по другим кружкам
 * и вернуться к предыдущему" — the round note does NOT answer the first tap; after tapping other
 * round notes and coming back to it, it plays. Something a NEIGHBOUR's playback does, or the
 * re-render that follows it, is what makes a bubble tappable — so the defect is not spatial (the
 * press lands on the right element; roundNoteTap.live.spec.ts already proves that) but a state
 * the bubble is left in when the chat is built.
 *
 * The invariant this scenario pins is the user's, not a mechanism's: the FIRST tap on ANY round
 * note plays it. Four surfaces of the same invariant, each asserted separately so one dead tap
 * never hides another:
 *
 *   1. the OLDEST of three notes rebuilt from history after a reload, tapped FIRST — before any
 *      neighbour has been touched. This is the board's exact gesture and the only ordering that
 *      can catch a bubble whose tap only works once a neighbour has played;
 *   2. its neighbours, in the same freshly loaded tab;
 *   3. a note that arrived live over push, and the same note after the receiver reloads — the
 *      incoming twin of surface 1, which separates "rebuilt from history" from "my own message";
 *   4. a note just sent, tapped the moment the circle stops asking the user to wait.
 *
 * A green cannot be borrowed: every tap asserts the note is SILENT first, the press is a real
 * trusted mouse press at the geometric centre of the circle (page.mouse, no actionability
 * retargeting onto a node an author picked), and playback counts only when the element
 * appMediaPlaybackController holds for THAT note's (peerId, mid) is the one it is running, with
 * its clock past zero, and the tapped bubble has left its paused presentation.
 *
 * When the oldest note's first tap is dead, the scenario then does what the CEO did — taps the
 * neighbours and comes back — and attaches that second outcome as evidence. Together with the
 * per-tap capture (whether the circle carries a tap listener at all, whether the press it
 * received was ever cancelled by a playback toggle, whether the bubble still carries the
 * deferred-onLoad marker, whether its message still says pFlags.is_outgoing, and what the
 * playback controller holds for that mid) that names WHY the first press was dropped instead of
 * merely recording that it was.
 *
 * That capture, taken live, is what the SECOND scenario in this file pins deterministically: the
 * dead circle was a note whose send had not been acknowledged, and a round note's playback is
 * wired only by the ack, so the circle answers the user no sooner than the server does — and
 * never at all when the server's answer is lost.
 */
test.skip(!liveLane.enabled, liveLane.skipReason);

const roundNotesInDialog = 3;


/**
 * One gesture of the scenario: tap a named round note and leave the page silent afterwards, so
 * the NEXT tap is asserted from silence. The pause is plumbing between gestures — the judgement
 * of whether the tap worked belongs entirely to tapRoundNoteLikeAUser.
 */
async function tapAndSettle(
  session: PersonaSession,
  side: string,
  target: RoundNoteTarget
): Promise<RoundTapOutcome> {
  const outcome = await tapRoundNoteLikeAUser(session, side, target);
  await stopRoundPlayback(session.page);
  return outcome;
}


test('the first tap on a round video note plays it — the oldest note of a reloaded chat as much as the newest', async({pair}, testInfo) => {
  // Six taps, each of which is allowed a full 30s to become moving video before it counts as
  // dead, plus two sign-ups, four sends and three reloads: the default 300s budget would end the
  // run mid-evidence on a red instead of collecting every surface.
  test.setTimeout(900_000);

  const {sender, recipient} = pair;

  // The probe records which nodes register a tap handler, so it must be armed before any round
  // bubble is built — on both pages, and before the first send.
  await installRoundClickProbe(sender.page);
  await installRoundClickProbe(recipient.page);

  for(let index = 0; index < roundNotesInDialog; ++index) {
    await sender.sendRoundNoteAsRecorder();
  }
  await waitForRoundNoteCount(recipient.page, roundNotesInDialog);

  // The reload is what makes surface 1 reachable: every bubble is now built from server history
  // in a tab that has never seen the send, which is the state the CEO's chat is in when he opens
  // it and taps an older circle.
  await sender.reloadAndReopenDialog(recipient.persona.phone);
  await waitForRoundNoteCount(sender.page, roundNotesInDialog);

  const senderMids = await roundNoteMidsOldestFirst(sender.page);
  expect(
    senderMids,
    'the scenario cannot ask its question unless the reloaded chat really shows all three round ' +
    'notes — with fewer, "tap the oldest one first" is not the gesture the board reported'
  ).toHaveLength(roundNotesInDialog);

  const outcomes: RoundTapOutcome[] = [];
  const oldest = {mid: senderMids[0]};

  outcomes.push(await tapAndSettle(
    sender,
    `sender, the OLDEST round note (mid ${senderMids[0]}) of three rebuilt from history, tapped FIRST — the board's gesture`,
    oldest
  ));
  outcomes.push(await tapAndSettle(
    sender,
    `sender, the MIDDLE round note (mid ${senderMids[1]}) rebuilt from history`,
    {mid: senderMids[1]}
  ));
  outcomes.push(await tapAndSettle(
    sender,
    `sender, the NEWEST round note (mid ${senderMids[2]}) rebuilt from history`,
    {mid: senderMids[2]}
  ));

  // The CEO's workaround, run only when the first tap on the oldest note was in fact dead: tap
  // the neighbours (done above), come back, and see whether the same circle answers now. This is
  // evidence, not a second chance — the assertion below still judges the FIRST tap.
  let comeBack: RoundTapOutcome | undefined;
  if(!outcomes[0].played) {
    comeBack = await tapAndSettle(
      sender,
      `sender, back on the OLDEST round note (mid ${senderMids[0]}) after both neighbours were tapped`,
      oldest
    );
  }

  const recipientMids = await roundNoteMidsOldestFirst(recipient.page);
  expect(
    recipientMids,
    'the recipient must have received all three round notes over push before the incoming surface ' +
    'can be tapped'
  ).toHaveLength(roundNotesInDialog);

  outcomes.push(await tapAndSettle(
    recipient,
    `recipient, the OLDEST round note (mid ${recipientMids[0]}) of three that arrived live over push, tapped FIRST`,
    {mid: recipientMids[0]}
  ));

  await recipient.reloadAndReopenDialog(sender.persona.phone);
  await waitForRoundNoteCount(recipient.page, roundNotesInDialog);
  const recipientMidsAfterReload = await roundNoteMidsOldestFirst(recipient.page);
  outcomes.push(await tapAndSettle(
    recipient,
    `recipient, the OLDEST round note (mid ${recipientMidsAfterReload[0]}) rebuilt from history after a reload`,
    {mid: recipientMidsAfterReload[0]}
  ));

  // Surface 4, deliberately not awaiting the send's own settle signal: a user does not wait for
  // an ack either — the moment the progress spinner clears, the circle is on screen and they tap
  // it.
  const sending = sender.sendRoundNoteAsRecorder();
  outcomes.push(await tapAndSettle(
    sender,
    'sender, the round note just sent, tapped as soon as the circle stops asking the user to wait',
    'newest'
  ));
  await sending;

  // Kept on green as well as red: what the browser hands a finger at the centre of each circle,
  // and what the app has wired behind it, is the evidence every theory of a dead tap stands or
  // falls on, and a run that only records it when it fails can testify to nothing when it passes.
  await testInfo.attach('round-note tap points', {
    body: outcomes.map((outcome) => outcome.hitSummary).join('\n\n'),
    contentType: 'text/plain'
  });

  if(comeBack) {
    await testInfo.attach('the CEO workaround, replayed', {
      body: [
        'The first tap on the oldest round note was dead. The scenario then tapped both ' +
        'neighbours and came back to the same circle, exactly as the board described.',
        `Coming back played the note: ${comeBack.played}`,
        comeBack.hitSummary,
        comeBack.report
      ].join('\n\n'),
      contentType: 'text/plain'
    });
  }

  const dead = outcomes.filter((outcome) => !outcome.played).map((outcome) => outcome.report);
  expect(
    dead,
    'a round video note ignored the user\'s FIRST tap: the press landed on the centre of the ' +
    'circle and produced no playback, and the note only answers once its neighbours have been ' +
    'tapped (the board\'s live report on top of f588256ad). Every report below is one surface ' +
    'whose first tap was dropped; each carries the hit stack at the tapped pixel, whether the ' +
    'circle carried a tap listener at all, whether the press it received was ever cancelled by a ' +
    'playback toggle, whether the bubble still carries the deferred-onLoad marker and its ' +
    'message still says pFlags.is_outgoing, and what appMediaPlaybackController holds for that mid'
  ).toEqual([]);
});


/*
 * The same invariant, pinned where it is deterministic rather than where the stack happens to
 * put it. The live capture of the board's dead circle showed a note whose send had not been
 * acknowledged: the bubble carried its tap listener, the trusted press reached it, the press was
 * never cancelled by any playback toggle, and appMediaPlaybackController held nothing at all for
 * that note — because wrappers/video.ts wires a round note's playback inside `onLoad`, and for an
 * outgoing message onLoad is parked until the server ack rebinds the bubble.
 *
 * So the circle answers the user only as fast as the server does, and not at all when the answer
 * is lost — which this stack does lose (one of several round notes sent in a row keeps the sending
 * clock forever while the recipient already has it).
 *
 * The user's own recording is on this machine. The circle is playing it as a preview while the
 * press lands on it. Nothing about pressing it needs a round trip, so this scenario judges the
 * ORDER of two events on one page-side clock: the first moving frame of the note, and the arrival
 * of the ack. Playback must come first.
 */
test('the round note the user just recorded answers the first press without waiting for the server', async({pair}, testInfo) => {
  test.setTimeout(600_000);

  const {sender} = pair;
  await installRoundClickProbe(sender.page);

  // The press has to land while the note is unacknowledged, and this stack answers a round-note
  // send in under a fifth of a second, so an attempt can legitimately miss the window. Missing it
  // is never a pass: the run retries, and a run that never lands one fails as unable to judge.
  const attempts: UnackedPressOutcome[] = [];
  for(let attempt = 1; attempt <= 4 && !attempts.some((outcome) => outcome.pressedWhileUnacked); ++attempt) {
    // Deliberately not awaited: the gesture under test IS the one made while the send is in
    // flight — the moment the circle appears with its preview looping and nothing asking the
    // user to wait.
    void sender.sendRoundNoteAsRecorder().catch((): void => undefined);
    attempts.push(await pressUnackedRoundNoteLikeAUser(sender, `attempt ${attempt}`));
    await stopRoundPlayback(sender.page);
  }

  await testInfo.attach('presses on the unacknowledged circle', {
    body: attempts.map((outcome) => outcome.hitSummary).join('\n\n'),
    contentType: 'text/plain'
  });

  const judged = attempts.find((outcome) => outcome.pressedWhileUnacked);
  expect(
    judged,
    'the scenario never managed to press the circle before the server answered, so it could not ' +
    'judge the invariant at all — it reports that instead of passing. Attempts:\n' +
    attempts.map((outcome) => outcome.report).join('\n\n')
  ).toBeDefined();

  expect(
    judged.playedBeforeAck,
    'the round note the user had just recorded ignored their press until the server answered: ' +
    (judged.playedAfterMs < 0 ?
      'it never started at all' :
      `the first moving frame came ${judged.playedAfterMs}ms after the press`) +
    ', and the server\'s answer ' +
    (judged.ackedAfterMs < 0 ? 'never arrived' : `came ${judged.ackedAfterMs}ms after the press`) +
    '. The recording is already on this machine — the circle is ' +
    'playing it as a preview under the finger — so a press on it must start playback from that ' +
    'file. Wiring the playback to the ack instead is why a circle whose ack is slow or lost stays ' +
    'dead for as long as the chat is open, and only starts working after its neighbours are ' +
    'tapped and the user comes back to it.\n' +
    judged.report
  ).toBe(true);
});
