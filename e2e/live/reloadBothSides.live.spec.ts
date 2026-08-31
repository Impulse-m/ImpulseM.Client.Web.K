import {assertRenderCompleteness} from './invariants';
import {liveLane} from './lane';
import {recorderWebmVideo, structuredPhoto} from './mediaFixtures';
import {test} from './pair';

/*
 * CEO script #3 — reload both sides: both personas interleave text and media into the same
 * dialog, both pages reload, and BOTH sides must still render every message the server holds
 * (render completeness), with every text still user-visible. This is the standing net for the
 * #93 class on a mixed conversation rather than a single message.
 */
test.skip(!liveLane.enabled, liveLane.skipReason);


test('interleaved text+media from both personas survive a reload of both pages', async({pair}) => {
  const {sender, recipient} = pair;
  const nonce = Date.now().toString(36);

  await sender.sendTextThroughUi(`alpha-${nonce}-1`);
  await recipient.waitForIncomingText(`alpha-${nonce}-1`);

  await recipient.sendTextThroughUi(`bravo-${nonce}-1`);
  await sender.waitForIncomingText(`bravo-${nonce}-1`);

  await sender.attachMediaThroughUi([structuredPhoto(`interleaved-${nonce}.png`, 512, 384)]);
  await recipient.attachMediaThroughUi([recorderWebmVideo(`interleaved-${nonce}.webm`)]);

  await sender.sendTextThroughUi(`alpha-${nonce}-2`);
  await recipient.sendTextThroughUi(`bravo-${nonce}-2`);
  await sender.waitForIncomingText(`bravo-${nonce}-2`);
  await recipient.waitForIncomingText(`alpha-${nonce}-2`);

  // 6 messages total (4 texts + 2 media); both sides must have RECEIVED everything live
  // before reloading — a reload racing the push would test nothing.
  await sender.waitForSettledMessageCount(6);
  await recipient.waitForSettledMessageCount(6);

  await sender.reloadAndReopenDialog(recipient.persona.phone);
  await recipient.reloadAndReopenDialog(sender.persona.phone);

  await assertRenderCompleteness(sender.page, 'sender', 'interleaved conversation after reload');
  await assertRenderCompleteness(recipient.page, 'recipient', 'interleaved conversation after reload');

  // Explicit user-visible check on top of the mid-level invariant: every text is still
  // readable on both sides (a bubble that exists but renders empty would pass a mid count).
  for(const text of [`alpha-${nonce}-1`, `alpha-${nonce}-2`, `bravo-${nonce}-1`, `bravo-${nonce}-2`]) {
    await sender.waitForIncomingText(text);
    await recipient.waitForIncomingText(text);
  }
});
