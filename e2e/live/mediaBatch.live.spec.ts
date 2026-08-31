import {assertRenderCompleteness} from './invariants';
import {liveLane} from './lane';
import {assertAlbumFidelity, fidelityExpectationsFor} from './mediaAsserts';
import {recorderWebmVideo, structuredPhoto} from './mediaFixtures';
import {test} from './pair';

/*
 * CEO script #2 — the media batch: sender attaches several photos and videos through the real
 * attach menu and sends them as one album (PopupNewMedia, grouping on — canon allows photos
 * and videos to share an album, cap 10); the recipient sees the album arrive over push; after
 * a reload BOTH sides still show every album member at real fidelity — no upscaled rung in
 * the box and a perceptual match against the very bytes this scenario uploaded (issue #108;
 * invariant in mediaAsserts.ts, metric in perceptual.ts). "Present but шакально" fails here.
 */
test.skip(!liveLane.enabled, liveLane.skipReason);


test('photos+videos album renders fully at source fidelity on both sides, before and after reload', async({pair}) => {
  const {sender, recipient} = pair;

  const album = [
    structuredPhoto('batch-photo-1.png', 640, 480),
    structuredPhoto('batch-photo-2.png', 480, 640),
    recorderWebmVideo('batch-clip-1.webm'),
    recorderWebmVideo('batch-clip-2.webm')
  ];
  const expectations = fidelityExpectationsFor(album);

  await sender.attachMediaThroughUi(album);

  await assertAlbumFidelity(sender.page, 'sender', expectations, 'fresh render');
  await assertAlbumFidelity(recipient.page, 'recipient', expectations, 'fresh render');

  await sender.reloadAndReopenDialog(recipient.persona.phone);
  await recipient.reloadAndReopenDialog(sender.persona.phone);

  await assertRenderCompleteness(sender.page, 'sender', 'media batch after reload');
  await assertRenderCompleteness(recipient.page, 'recipient', 'media batch after reload');

  await assertAlbumFidelity(sender.page, 'sender', expectations, 'after reload');
  await assertAlbumFidelity(recipient.page, 'recipient', expectations, 'after reload');
});
