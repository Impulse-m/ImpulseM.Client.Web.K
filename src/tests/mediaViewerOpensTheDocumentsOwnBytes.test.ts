import {beforeAll, describe, expect, it} from 'vitest';

import {THUMB_TYPE_FULL} from '@appManagers/constants';

// CONTRACT — this module does not exist yet; the implementer adds it and routes the media
// viewer's cache reads through it:
//
//   // src/components/mediaViewer/mediaCacheType.ts
//   export default function getMediaViewerCacheType(
//     media: MyPhoto | MyDocument,
//     layoutSize: PhotoSize | undefined
//   ): string;
//
// One rule, and it follows from what the viewer itself downloads:
//
//   - a DOCUMENT is fetched whole — `appDownloadManager.downloadMediaURL({media})` with no
//     `thumb` (mediaViewer/base.ts:2846 for the video lane, :2985 for the still lane) — so its
//     bytes land in, and must be read back from, the full-file slot (THUMB_TYPE_FULL);
//   - a PHOTO is fetched per size — `downloadMediaURL({media, thumb: size})` — so it is read
//     back from that size's slot, and the layout size stays the answer for it.
//
// mediaViewer/base.ts then uses it for the default type of `getCacheContext` (:2578) — the
// accessor every read of the MEDIA'S OWN bytes goes through (:2850, :2865, :2993, :3005) — in
// place of today's `size?.type`. Not for the mover's placeholder read at :2524: that one is
// deliberately fetching a THUMBNAIL to paint into an <img>, and the layout size is its right
// answer.
type MediaViewerCacheType = (media: unknown, layoutSize: unknown) => string;

// Resolved at run time rather than imported statically, and deliberately so: the module below is
// the contract this file states, it does not exist yet, and a static import would paint the
// whole project's type-check red instead of this one suite. The load failure IS the red.
const contractPath: string = '../components/mediaViewer/mediaCacheType';

let getMediaViewerCacheType: MediaViewerCacheType;

beforeAll(async() => {
  const loaded = await import(contractPath).catch((error: unknown) => {
    throw new Error(
      'CONTRACT MISSING: src/components/mediaViewer/mediaCacheType.ts is not there, so the media ' +
      'viewer still reads a document\'s bytes out of whichever thumbnail slot the LAYOUT happened ' +
      'to pick, and a video sent as a file opens as a still picture that never plays ' +
      `(${String(error)})`
    );
  });

  getMediaViewerCacheType = loaded.default as MediaViewerCacheType;
});


// The live shape this pins (e2e/live/videoSentAsFile.live.spec.ts, run against the dev stack):
// a video sent as a FILE arrives exactly as canon requires — attributes=[documentAttributeFilename],
// four thumbs, no video_thumbs — which means it carries NO width and NO height, because
// documentAttributeVideo is precisely what force_file suppresses. Without w/h the viewer's layout
// pass cannot push the document's own size into choosePhotoSize (base.ts:2502,
// `pushDocumentSize: !!(isDocument && media.w && media.h)`), so the size it settles on is one of
// the THUMBNAILS. That layout size then leaks into the cache read, and the measured result is:
//
//   the document the row carries: id=322161833114606811 mime=video/webm size=206717 type=undefined
//     thumbs=4 video_thumbs=0 attributes=[documentAttributeFilename] supportsStreaming=false
//   that document's cache context: downloaded=true url=blob:http://localhost:8199/5eab44a7-…
//   media viewer was handed: document 322161833114606811 (messageMediaDocument, mime video/webm)
//   <video> in the viewer: present, paused=true currentTime=0 readyState=0 networkState=0
//     errorCode=0 src=(EMPTY)
//   still images in the viewer: <img class="thumbnail">
//   [console.error] renderImageFromUrl: no url? JSHandle@node
//
// The bytes are downloaded and the blob URL exists — in the FULL slot, which the capture above
// reads. The viewer looked in the thumbnail's slot, found nothing, handed the <video> an empty
// src, and left the user with the still thumbnail to pan around. That is issue #118 verbatim:
// "the file behaves like a picture".
const ladderTypes = ['i', 's', 'm', 'x', 'y', 'w'];


function videoSentAsFile() {
  return {
    _: 'document',
    id: '322161833114606811',
    mime_type: 'video/webm',
    size: 206717,
    // No w/h and no documentAttributeVideo: that IS what force_file means.
    attributes: [{_: 'documentAttributeFilename', file_name: 'clip.webm'}],
    thumbs: ladderTypes.map((type) => ({_: 'photoSize', type, w: 320, h: 240, size: 4096})),
    video_thumbs: [] as unknown[]
  };
}


function thumbnailSize(type: string) {
  return {_: 'photoSize', type, w: 320, h: 240, size: 4096};
}


describe('getMediaViewerCacheType', () => {
  it('reads a video sent as a file out of the slot its own bytes were downloaded into', () => {
    // Invariant over the whole ladder, not one sampled letter: which rung the layout pass lands
    // on depends on the viewport, the device pixel ratio and whatever thumbnails the server
    // generated, so any rung that answers with itself is a viewer that shows the user a picture
    // instead of their video on some screen size.
    for(const type of ladderTypes) {
      expect(
        getMediaViewerCacheType(videoSentAsFile(), thumbnailSize(type)),
        `the media viewer would look for the video's bytes in the "${type}" thumbnail's cache slot because the LAYOUT picked that thumbnail — the bytes are in the document's own slot, so the <video> is handed an empty src and the user is left panning around the still preview: issue #118, the file behaving like a picture`
      ).toBe(THUMB_TYPE_FULL);
    }
  });


  it('reads a document out of its own slot even when the layout pass produced no size at all', () => {
    expect(
      getMediaViewerCacheType(videoSentAsFile(), undefined),
      'a document with no layout size resolved to something other than its own full-file slot, so the viewer opens on nothing at all'
    ).toBe(THUMB_TYPE_FULL);
  });


  it('keeps reading an ordinary video document out of its own slot', () => {
    const ordinaryVideo = {
      ...videoSentAsFile(),
      type: 'video',
      w: 1280,
      h: 720,
      attributes: [
        {_: 'documentAttributeFilename', file_name: 'clip.webm'},
        {_: 'documentAttributeVideo', w: 1280, h: 720, duration: 2}
      ]
    };

    expect(
      getMediaViewerCacheType(ordinaryVideo, {_: 'photoSize', type: THUMB_TYPE_FULL, w: 1280, h: 720, size: 206717}),
      'an ordinary video stopped being read out of its own full-file slot — the fix for the file-sent video broke the video lane that already worked'
    ).toBe(THUMB_TYPE_FULL);
  });


  it('still reads a photo out of the slot of the size that was downloaded for it', () => {
    // Photos are fetched per size (`downloadMediaURL({media, thumb: size})`), so for them the
    // layout size IS the right slot. A rule that answered THUMB_TYPE_FULL for everything would
    // pass the assertions above and quietly send every photo in the viewer looking for bytes
    // nobody ever downloaded.
    const photo = {
      _: 'photo',
      id: '77',
      sizes: ladderTypes.map((type) => thumbnailSize(type))
    };

    for(const type of ladderTypes) {
      expect(
        getMediaViewerCacheType(photo, thumbnailSize(type)),
        `a photo opened at its "${type}" size would be looked up in a different slot than the one its bytes were downloaded into, so the viewer shows the user an empty frame`
      ).toBe(type);
    }
  });
});
