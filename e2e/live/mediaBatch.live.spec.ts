import {assertRenderCompleteness} from './invariants';
import {liveLane} from './lane';
import {assertAlbumPreviews} from './mediaAsserts';
import {noisePhoto, recorderWebmVideo} from './mediaFixtures';
import {test} from './pair';

/*
 * CEO script #2 — the media batch: sender attaches several photos and videos through the real
 * attach menu and sends them as one album (PopupNewMedia, grouping on — canon allows photos
 * and videos to share an album, cap 10); the recipient sees the album arrive over push; after
 * a reload BOTH sides still show every album member with a real decoded preview — not the
 * blurred stripped thumb ("шакальные превью") and not an empty box.
 */
test.skip(!liveLane.enabled, liveLane.skipReason);

const albumSize = 4;


test('photos+videos album renders fully with real previews on both sides, before and after reload', async({pair}) => {
  const {sender, recipient} = pair;

  await sender.attachMediaThroughUi([
    noisePhoto('batch-photo-1.png', 640, 480),
    noisePhoto('batch-photo-2.png', 480, 640),
    recorderWebmVideo('batch-clip-1.webm'),
    recorderWebmVideo('batch-clip-2.webm')
  ]);

  await assertAlbumPreviews(sender.page, 'sender', albumSize);
  await assertAlbumPreviews(recipient.page, 'recipient', albumSize);

  await sender.reloadAndReopenDialog(recipient.persona.phone);
  await recipient.reloadAndReopenDialog(sender.persona.phone);

  await assertRenderCompleteness(sender.page, 'sender', 'media batch after reload');
  await assertRenderCompleteness(recipient.page, 'recipient', 'media batch after reload');

  await assertAlbumPreviews(sender.page, 'sender (after reload)', albumSize);
  await assertAlbumPreviews(recipient.page, 'recipient (after reload)', albumSize);
});
