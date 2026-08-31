import type {Document, DocumentAttribute} from '@layer';

import appManagersManager from '@appManagers/appManagersManager';
import getDocumentURL from '@appManagers/utils/docs/getDocumentURL';
import MTProtoMessagePort from '@lib/mainWorker/mainMessagePort';
import ThumbsStorage from '@lib/storages/thumbs';
import {AppDocsManager, MyDocument} from '@appManagers/appDocsManager';
import {EXTENSION_MIME_TYPE_MAP} from '@environment/mimeTypeMap';
import {resetSharedObjectURLCaches} from '@lib/mainWorker/sharedObjectUrlCache';

/**
 * Whether a video streams is a property of the ENVIRONMENT — is there a service worker able to
 * answer `/stream/` requests — and not of the instant the document happened to reach the client.
 * `appDocsManager.saveDoc` decides it once, at save time (appDocsManager.ts:285-306), and the
 * decision it takes then is the one every later playback obeys: `supportsStreaming` picks the
 * lane in the media viewer (mediaViewer/base.ts:2575) and `getDocumentURL` picks `stream/...`
 * versus `document/...` off the same flag.
 *
 * The client already knows the decision has to be revisited: `onServiceWorkerFail`
 * (appDocsManager.ts:90-100) exists to strip `supportsStreaming` and the `stream/` cache context
 * off every document it has already saved when the worker turns out to be unavailable. What it
 * does NOT have is the other half — nothing re-derives the decision when a worker that was
 * unavailable becomes available — and, as the delivery test below shows, the half that does
 * exist never runs.
 *
 * The user-visible shape of both halves is the same one the board reports: the videos that were
 * in the chat history when the tab loaded refuse to play for the rest of that session, while
 * videos that arrive later play fine, because the two groups were classified against two
 * different service-worker states and only the later group's classification is true.
 *
 * Everything here is the real machinery: the real `AppDocsManager` with the real `ThumbsStorage`
 * behind it, the real `appManagersManager` flag, and the real `MTProtoMessagePort` carrying the
 * real `serviceWorkerOnline` message into the real `SuperMessagePort` dispatch. The one thing
 * that cannot be used is the wire itself — `SuperMessagePort.postMessage` returns early under
 * `import.meta.env.MODE === 'test'` (superMessagePort.ts:363), production code refusing to post
 * in a test run — so the message is handed to the port's own `onMessage` with the exact task a
 * `invokeVoid('serviceWorkerOnline', ...)` would have put on the wire.
 */
type DocumentFixture = {
  attributes: DocumentAttribute[],
  mimeType: string,
  size: number
};

const megabyte = 1024 * 1024;

let port: MTProtoMessagePort<false>;
let manager: AppDocsManager;
let thumbsStorage: ThumbsStorage;


function videoAttribute(): DocumentAttribute {
  return {
    _: 'documentAttributeVideo',
    pFlags: {supports_streaming: true},
    w: 640,
    h: 480,
    duration: 6
  } as unknown as DocumentAttribute;
}


function audioAttribute(): DocumentAttribute {
  return {
    _: 'documentAttributeAudio',
    pFlags: {},
    duration: 180
  } as unknown as DocumentAttribute;
}


function animatedAttribute(): DocumentAttribute {
  return {_: 'documentAttributeAnimated'} as unknown as DocumentAttribute;
}


function stickerAttribute(): DocumentAttribute {
  return {
    _: 'documentAttributeSticker',
    pFlags: {},
    alt: '🐱',
    stickerset: {_: 'inputStickerSetEmpty'}
  } as unknown as DocumentAttribute;
}


function imageSizeAttribute(): DocumentAttribute {
  return {_: 'documentAttributeImageSize', w: 512, h: 512} as unknown as DocumentAttribute;
}


function fileNameAttribute(name: string): DocumentAttribute {
  return {_: 'documentAttributeFilename', file_name: name} as unknown as DocumentAttribute;
}


const video: DocumentFixture = {
  attributes: [videoAttribute(), fileNameAttribute('clip.mp4')],
  mimeType: EXTENSION_MIME_TYPE_MAP.mp4,
  size: 1.7 * megabyte
};

const audio: DocumentFixture = {
  attributes: [audioAttribute(), fileNameAttribute('track.mp3')],
  mimeType: EXTENSION_MIME_TYPE_MAP.mp3,
  size: 6 * megabyte
};

const bigGif: DocumentFixture = {
  attributes: [animatedAttribute(), fileNameAttribute('loop.gif')],
  mimeType: EXTENSION_MIME_TYPE_MAP.gif,
  size: 12 * megabyte
};

const smallGif: DocumentFixture = {
  attributes: [animatedAttribute(), fileNameAttribute('tiny.gif')],
  mimeType: EXTENSION_MIME_TYPE_MAP.gif,
  size: 2 * megabyte
};

const sticker: DocumentFixture = {
  attributes: [imageSizeAttribute(), stickerAttribute(), fileNameAttribute('sticker.webp')],
  mimeType: EXTENSION_MIME_TYPE_MAP.webp,
  size: 48 * 1024
};

const photo: DocumentFixture = {
  attributes: [imageSizeAttribute(), fileNameAttribute('shot.jpg')],
  mimeType: 'image/jpeg',
  size: 900 * 1024
};

const plainFile: DocumentFixture = {
  attributes: [fileNameAttribute('contract.pdf')],
  mimeType: EXTENSION_MIME_TYPE_MAP.pdf,
  size: 3 * megabyte
};


/**
 * The wire shape of one document, saved through the real `saveDoc`. `id` is the caller's own
 * label so a re-save (what a history reload does) can hand the manager a NEW object carrying the
 * same identity, exactly as the server would.
 */
function save(id: string, fixture: DocumentFixture): MyDocument {
  const wire = {
    _: 'document',
    pFlags: {},
    id,
    access_hash: '17',
    file_reference: new Uint8Array([1, 2, 3]),
    date: 0,
    mime_type: fixture.mimeType,
    size: fixture.size,
    dc_id: 2,
    attributes: fixture.attributes.map((attribute) => ({...attribute})) as DocumentAttribute[],
    thumbs: []
  } as unknown as Document.document;

  return manager.saveDoc(wire);
}


function cacheContextUrl(document: MyDocument): string {
  return thumbsStorage.getCacheContext(document).url;
}


/**
 * The message the tab sends its worker when it learns whether a service worker is there
 * (apiManagerProxy.ts:829 sends `false` on a failed registration; the port's own contract —
 * mainMessagePort.ts:45 — declares the payload as a plain boolean, so `true` is in-contract and
 * simply never sent today). Delivered through the port's real dispatch so that WHICH listeners
 * receive it is decided by production code, not by this test.
 */
function reportServiceWorker(online: boolean): void {
  const rawPort = port as any;
  rawPort.onMessage({
    data: {
      type: 'invoke',
      id: rawPort.getNextTaskId(),
      payload: {type: 'serviceWorkerOnline', payload: online, void: true}
    },
    source: undefined,
    currentTarget: undefined
  });
}


beforeEach(() => {
  // Order matters and is production's: `index.worker.ts` registers its own `serviceWorkerOnline`
  // handler at module scope (index.worker.ts:61,206) — long before `getManagersByAccount()`
  // (index.worker.ts:362) builds the managers whose `after()` registers the second one.
  port = new MTProtoMessagePort<false>(false);
  port.addMultipleEventsListeners({
    serviceWorkerOnline: (online) => {
      appManagersManager.isServiceWorkerOnline = online;
    }
  });

  thumbsStorage = new ThumbsStorage();
  manager = new AppDocsManager();
  Object.assign(thumbsStorage as any, {accountNumber: 1});
  Object.assign(manager as any, {
    accountNumber: 1,
    thumbsStorage,
    referencesStorage: {saveContext: () => {}}
  });
  (manager as any).after();

  appManagersManager.isServiceWorkerOnline = true;
});

afterEach(() => {
  resetSharedObjectURLCaches();
});

describe('a document\'s streaming lane follows the service worker, not the moment it was saved', () => {
  it('streams a video saved while the service worker is online', () => {
    const clip = save('sent-while-online', video);

    expect(
      clip.supportsStreaming,
      'a video saved with a service worker present must stream: this is the lane the whole client ' +
      'is built around, and if it is not taken here nothing below is testing a regression'
    ).toBe(true);
    expect(
      cacheContextUrl(clip),
      'the streaming video must carry the service worker stream URL as its cache context, because ' +
      'that string IS what the media viewer hands to the <video> element'
    ).toBe(getDocumentURL(clip));
    expect(cacheContextUrl(clip).startsWith('stream/')).toBe(true);
  });

  it('stops streaming the videos it already saved when the service worker turns out to be missing', () => {
    const fromHistory = save('already-in-history', video);
    expect(
      fromHistory.supportsStreaming,
      'precondition: the history video was saved while the client still believed a service worker ' +
      'was there — without that this test never reaches the transition it exists to drive'
    ).toBe(true);

    reportServiceWorker(false);

    expect(
      manager.getDoc('already-in-history').supportsStreaming,
      'a video that was in the history when the tab loaded can never be played in this tab: it was ' +
      'classified as streamable in the first moments of the boot, the service worker then turned ' +
      'out not to be there, and nothing re-classified it — so every playback asks a service worker ' +
      'that does not exist for the bytes and the user gets "Unfortunately, this video can\'t be played"'
    ).toBeFalsy();
    expect(
      cacheContextUrl(fromHistory),
      'the dead "stream/..." URL is still the document\'s cache context, so the media viewer keeps ' +
      'handing it to the <video> element on every single retry — the video is unplayable for the ' +
      'life of this tab, not just once'
    ).toBe('');
  });

  it('streams the video that was already in the history once the service worker is online', () => {
    reportServiceWorker(false);
    const fromHistory = save('already-in-history', video);
    expect(
      fromHistory.supportsStreaming,
      'precondition: the history video really was saved during the service worker outage — if it ' +
      'was not, the recovery below proves nothing'
    ).toBe(false);

    reportServiceWorker(true);
    const justSent = save('sent-after-the-worker-came-up', video);

    expect(
      justSent.supportsStreaming,
      'control: a video that arrives AFTER the service worker is up streams — this is the half the ' +
      'user sees working, and it is what makes the failure read as "the old videos are broken"'
    ).toBe(true);
    expect(
      manager.getDoc('already-in-history').supportsStreaming,
      'a video that was in the history when the tab loaded can never be played in this tab the way ' +
      'the videos sent afterwards can: it was classified while the service worker was still absent ' +
      'and stays frozen that way, so it downloads whole through the blob lane — the lane the ' +
      'board\'s dead-video record names — while every newer video streams'
    ).toBe(true);
    expect(
      cacheContextUrl(fromHistory).startsWith('stream/'),
      'the recovered video must also be given the stream URL as its cache context, otherwise the ' +
      'flag says "streams" while the media viewer still hands the element the whole-file lane'
    ).toBe(true);
  });

  it('recovers every kind of document that streams, not just plain video', () => {
    reportServiceWorker(false);
    const track = save('audio-already-in-history', audio);
    const loop = save('big-gif-already-in-history', bigGif);

    reportServiceWorker(true);

    expect(
      manager.getDoc('audio-already-in-history').supportsStreaming,
      'a music file that was in the history when the tab loaded never streams again in this tab: ' +
      'the user waits for the whole track to download before the first note instead of hearing it ' +
      'immediately, for every track that predates the service worker coming up'
    ).toBe(true);
    expect(
      manager.getDoc('big-gif-already-in-history').supportsStreaming,
      'a large GIF that was in the history when the tab loaded never streams again in this tab — ' +
      'the same freeze, on the other document kind the streaming rule covers'
    ).toBe(true);
    expect(cacheContextUrl(track).startsWith('stream/')).toBe(true);
    expect(cacheContextUrl(loop).startsWith('stream/')).toBe(true);
  });

  it('never turns a document that must not stream into a streaming one', () => {
    reportServiceWorker(false);
    const savedDuringOutage = {
      sticker: save('sticker-during-outage', sticker),
      smallGif: save('small-gif-during-outage', smallGif),
      photo: save('photo-during-outage', photo),
      file: save('file-during-outage', plainFile)
    };

    reportServiceWorker(true);

    for(const [kind, document] of Object.entries(savedDuringOutage)) {
      expect(
        manager.getDoc(document.id).supportsStreaming,
        `the ${kind} document became streamable when the service worker came up. Nothing but ` +
        'video, audio and a GIF over 8 MB may stream (appDocsManager.ts:286-292); marking anything ' +
        'else streamable points the client at a stream URL for bytes no stream lane serves, which ' +
        'is the same dead media the user is already complaining about'
      ).toBeFalsy();
      expect(
        cacheContextUrl(document),
        `the ${kind} document was handed a stream cache context although it must never stream`
      ).toBe('');
    }

    // The reverse direction of the same guard: an outage must not strip a classification that
    // never depended on the service worker in the first place.
    const stickerBeforeOutage = save('sticker-before-outage', sticker);
    expect(stickerBeforeOutage.type).toBe('sticker');
    reportServiceWorker(false);
    expect(
      manager.getDoc('sticker-before-outage').type,
      'a service worker outage re-filed a sticker as something else — stickers stop rendering as ' +
      'stickers and start rendering as generic files for the rest of the session'
    ).toBe('sticker');
    expect(manager.getDoc('small-gif-during-outage').type).toBe('gif');
  });
});
