import {AppDocsManager} from '@appManagers/appDocsManager';
import StickerType from '@config/stickerType';
import {EXTENSION_MIME_TYPE_MAP} from '@environment/mimeTypeMap';
import type {Document, DocumentAttribute} from '@layer';

/**
 * The wire shape our server sends for a sticker must classify as a sticker in THIS client.
 *
 * This is not a restatement of the server's own tests. The server can be perfectly self-consistent
 * and still ship a document this client files under `type: 'photo'`, because the classification
 * rule lives here, in `saveDoc`, and it is stricter than the specification. The specification
 * identifies an animated sticker by mime type alone; `appDocsManager` additionally demands an exact
 * file name, and for a `.tgs` that demand is the ONLY thing standing between a sticker and a
 * generic file — the `documentAttributeSticker` arm never fires for one, since it tests for webp
 * and webm and a `.tgs` is neither.
 *
 * That is how one omission produced two unrelated-looking complaints at once. A `.tgs` fell through
 * to `documentAttributeImageSize`, which sets `type: 'photo'`; the chat drew it with the browser's
 * own file rendering, and sending it back put a FILE in the chat instead of a sticker. Both are the
 * same line.
 *
 * The shapes below are measured, not assumed. They were read off the real Telegram service with a
 * read-only probe (`tools/sticker-fetch/probe-media-shapes.mjs` in the backend repository) across
 * whole sticker sets rather than samples: 599 animated stickers carried exactly one file name
 * between them, 66 static and 116 video stickers likewise, and every one of them ordered its
 * attributes size-carrier first and file name last.
 */
describe('a sticker document our server emits classifies as a sticker', () => {
  function classify(attributes: DocumentAttribute[], mimeType: string) {
    const manager = new AppDocsManager();
    Object.assign(manager as any, {
      docs: {},
      referencesStorage: {saveContext: vi.fn()}
    });

    const document = {
      _: 'document',
      pFlags: {},
      id: '1',
      access_hash: '1',
      file_reference: new Uint8Array(),
      date: 0,
      mime_type: mimeType,
      size: 4096,
      dc_id: 1,
      attributes,
      thumbs: []
    } as unknown as Document.document;

    return manager.saveDoc(document);
  }

  const sticker = (alt: string): DocumentAttribute => ({
    _: 'documentAttributeSticker',
    pFlags: {},
    alt,
    stickerset: {_: 'inputStickerSetEmpty'}
  }) as unknown as DocumentAttribute;

  const imageSize = (w: number, h: number): DocumentAttribute =>
    ({_: 'documentAttributeImageSize', w, h}) as unknown as DocumentAttribute;

  const fileName = (name: string): DocumentAttribute =>
    ({_: 'documentAttributeFilename', file_name: name}) as unknown as DocumentAttribute;

  it('files an animated sticker as Lottie rather than as a photo', () => {
    const document = classify(
      [imageSize(512, 512), sticker('🐱'), fileName('AnimatedSticker.tgs')],
      EXTENSION_MIME_TYPE_MAP.tgs
    );

    expect(
      document.type,
      'a .tgs classified as anything but "sticker" is drawn by the browser as a generic file AND ' +
      'sent back into the chat as a file — the two complaints that turned out to be one line'
    ).toBe('sticker');
    expect(
      document.sticker,
      'without StickerType.Lottie nothing routes this document to rlottie, so it never animates'
    ).toBe(StickerType.Lottie);
    expect(document.animated).toBe(true);
  });

  it('files a static and a video sticker as stickers too', () => {
    const staticSticker = classify(
      [imageSize(512, 512), sticker('🐱'), fileName('sticker.webp')],
      EXTENSION_MIME_TYPE_MAP.webp
    );
    expect(staticSticker.type).toBe('sticker');
    expect(staticSticker.sticker).toBe(StickerType.Static);

    const videoSticker = classify(
      [
        {_: 'documentAttributeVideo', pFlags: {supports_streaming: true}, w: 512, h: 512, duration: 3} as unknown as DocumentAttribute,
        sticker('🐱'),
        fileName('sticker.webm')
      ],
      EXTENSION_MIME_TYPE_MAP.webm
    );
    expect(videoSticker.type).toBe('sticker');
    expect(videoSticker.sticker).toBe(StickerType.WebM);
  });

  /**
   * The two traps this pins, so that removing either server-side rule reddens something here rather
   * than in a chat window.
   */
  it('stops being a sticker if the file name is the uploader\'s own', () => {
    const document = classify(
      [imageSize(512, 512), sticker('🐱'), fileName('my cat final (2).tgs')],
      EXTENSION_MIME_TYPE_MAP.tgs
    );

    expect(
      document.type,
      'this is characterization, not a wish: it records WHY the server replaces the uploader name ' +
      'with a constant. If this ever starts passing as "sticker", the client rule changed and the ' +
      'server rule may be relaxed — until then, passing a name through breaks every animated sticker'
    ).not.toBe('sticker');
  });

  it('stops being a sticker if the size carrier is ordered after the sticker attribute', () => {
    const document = classify(
      [sticker('🐱'), imageSize(512, 512), fileName('sticker.webp')],
      EXTENSION_MIME_TYPE_MAP.webp
    );

    expect(
      document.type,
      'saveDoc walks attributes in wire order and lets the LAST arm win, so a size carrier placed ' +
      'after the sticker attribute overwrites "sticker" with "photo". Attribute order is a wire ' +
      'contract, not cosmetics — this is what the measured size-carrier-first ordering protects'
    ).toBe('photo');
  });
});
