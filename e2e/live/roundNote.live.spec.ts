import {assertRenderCompleteness} from './invariants';
import {liveLane} from './lane';
import {expect, test} from './pair';

/*
 * CEO script #1 — the round note (issues #91 and #93, both live incidents):
 * sender sends a round video note, sees its bubble, clicks play and gets playback (not the
 * #91 eternal spinner), reloads and still has the bubble (#93), and can stream it again after
 * the reload; the recipient receives it over push and can play it too.
 *
 * Fidelity boundary (documented in personaSession.ts): headless chromium has no camera, so
 * the send is appMessagesManager.sendFile from the page context with the recorder's exact
 * options and a real VP8+Opus capture — everything else (pending bubble, ack rebind, playback
 * clicks, reload) is the real UI.
 */
test.skip(!liveLane.enabled, liveLane.skipReason);


test('round note plays for the sender, survives reload on both sides, and plays for the recipient', async({pair}) => {
  const {sender, recipient} = pair;

  await sender.sendRoundNoteAsRecorder();

  await expect(
    sender.page.locator('.media-round[data-mid]'),
    'the sender must see exactly one round-note bubble after the acked send — zero is the ' +
    'vanish class, more than one is a duplicated render of the same message'
  ).toHaveCount(1);

  // Pre-reload playback: the #91 lane — the click must resolve against the FINAL message and
  // document, playing the just-recorded media instead of spinning forever.
  await sender.playRoundNote('sender, before reload');

  await sender.reloadAndReopenDialog(recipient.persona.phone);
  await assertRenderCompleteness(sender.page, 'sender', 'round note after sender reload');
  await expect(
    sender.page.locator('.media-round[data-mid]'),
    'the round-note bubble is gone from the sender\'s chat after a reload although the server ' +
    'still returns the message — the exact user-visible loss of issue #93'
  ).toHaveCount(1);

  // Post-reload playback streams from the server (no local recording blob exists any more).
  await sender.playRoundNote('sender, after reload');

  await recipient.waitForIncomingRoundNote();
  await recipient.playRoundNote('recipient');

  await recipient.reloadAndReopenDialog(sender.persona.phone);
  await assertRenderCompleteness(recipient.page, 'recipient', 'round note after recipient reload');
  await expect(
    recipient.page.locator('.media-round[data-mid]'),
    'the round-note bubble is gone from the recipient\'s chat after a reload although the ' +
    'server still returns the message'
  ).toHaveCount(1);
});
