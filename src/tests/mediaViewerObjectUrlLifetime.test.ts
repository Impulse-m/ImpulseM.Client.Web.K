// * Pins the object-URL lifetime invariants behind the media viewer's video path:
// * the viewer asks the worker for a full-size video's cache context, receives a
// * blob: URL, pins it one message-port hop later, and hands it to a <video>
// * element. The board's live failure — "Unfortunately, this video can't be
// * played" with {code: 4, sourceKind: "blob", networkState: 3, readyState: 0} —
// * is exactly what a revoked blob URL produces, so these tests drive the REAL
// * ThumbsStorage + SharedObjectUrlCache + ObjectUrlCacheBudget +
// * ObjectUrlRegistry classes past their budgets and assert that no consumer is
// * ever left holding a dead URL and no cache context ever exposes one.

const mocks = vi.hoisted(() => ({
  createObjectURL: vi.fn<(blob: Blob) => string>(),
  mirror: vi.fn<(method: string, payload: MirroredThumbPayload) => void>(),
  registry: undefined as unknown as import('@lib/mainWorker/objectUrlRegistry').ObjectUrlRegistry,
  revokeObjectURL: vi.fn<(url: string) => void>()
}));

type MirroredThumbPayload = {
  name: 'stickerThumbs' | 'thumbs',
  key?: string,
  value?: unknown,
  previousUrl?: string,
  accountNumber: number
};

vi.mock('@lib/mainWorker/objectUrlRegistry', async(importOriginal) => {
  const actual: typeof import('@lib/mainWorker/objectUrlRegistry') = await importOriginal();
  mocks.registry = new actual.ObjectUrlRegistry({
    createObjectURL: mocks.createObjectURL,
    revokeObjectURL: mocks.revokeObjectURL
  });

  return {
    ...actual,
    default: mocks.registry
  };
});

vi.mock('@lib/mainWorker/mainMessagePort', () => ({
  default: {
    getInstance: () => ({
      invokeVoid: mocks.mirror
    })
  }
}));

import type {ThumbCache, ThumbsCache} from '@lib/storages/thumbs';
import reconcileObjectURLMirrorValue from '@lib/apiManagerProxyUtils/reconcileObjectURLMirrorValue';
import {OBJECT_URL_GRACE_TTL} from '@lib/mainWorker/objectUrlRegistry';
import {isObjectURL} from '@helpers/objectUrlUtils';
import {resetSharedObjectURLCaches} from '@lib/mainWorker/sharedObjectUrlCache';
import ThumbsStorage from '@lib/storages/thumbs';

// * The board's chat exchanges batches of ~1.7 MB videos; the full-size blobs
// * share the 128-URL / 32 MB thumbs object-URL budget with every thumbnail.
const VIDEO_BYTES = 1.7 * 1024 * 1024;
const THUMB_BYTES = 24 * 1024;

const videoBlob = () => new Blob([new Uint8Array(VIDEO_BYTES)]);
const thumbBlob = () => new Blob([new Uint8Array(THUMB_BYTES)]);
const makeDocument = (id: string) => ({_: 'document', id}) as any;

const makeStorage = () => {
  const storage = new ThumbsStorage();
  (storage as any).accountNumber = 1;
  return storage;
};

const makeTabSource = () => ({}) as MessageEventSource;

const revokedUrls = () => new Set(mocks.revokeObjectURL.mock.calls.map(([url]) => url));

// * Applies every worker-emitted 'mirror' message to a tab-shaped mirror the
// * way apiManagerProxy does, structured-clone included, so the sweep below
// * sees exactly what a rendering tab would read from its thumbs mirror.
function buildTabMirror(): ThumbsCache {
  const tabThumbs: ThumbsCache = {};
  for(const [method, payload] of mocks.mirror.mock.calls) {
    if(method !== 'mirror' || payload.name !== 'thumbs' || !payload.key) {
      continue;
    }

    reconcileObjectURLMirrorValue(
      tabThumbs,
      payload.key,
      payload.value === undefined ? undefined : structuredClone(payload.value as ThumbCache)
    );
  }

  return tabThumbs;
}

function collectExposedBlobUrls(storage: ThumbsStorage) {
  const exposed = new Map<string, string>();
  const thumbsCache = (storage as any).thumbsCache as ThumbsCache;
  for(const key in thumbsCache) {
    for(const size in thumbsCache[key]) {
      const url = thumbsCache[key][size].url;
      if(isObjectURL(url)) {
        exposed.set(`${key}/${size}`, url);
      }
    }
  }

  const stickerThumbs = (storage as any).stickerCachedThumbs as Record<string, {url: string}>;
  for(const key in stickerThumbs) {
    const url = stickerThumbs[key].url;
    if(isObjectURL(url)) {
      exposed.set(`sticker/${key}`, url);
    }
  }

  return exposed;
}

function churnVideos(storage: ThumbsStorage, count: number, prefix: string) {
  for(let i = 0; i < count; ++i) {
    storage.setCacheContextBlob(makeDocument(`${prefix}-${i}`), undefined, videoBlob(), VIDEO_BYTES);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  let nextUrl = 0;
  mocks.createObjectURL.mockImplementation(() => `blob:test/media-${++nextUrl}`);
});

afterEach(() => {
  resetSharedObjectURLCaches();
  mocks.registry.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('media viewer object URL lifetime', () => {
  it('never revokes the blob URL a viewer has pinned, however hard the thumbs budget churns', () => {
    const storage = makeStorage();
    const video = makeDocument('opened-in-viewer');
    storage.setCacheContextBlob(video, undefined, videoBlob(), VIDEO_BYTES);

    // * the viewer's exact consumption: read the context, then pin the URL
    const url = storage.getCacheContext(video).url;
    expect(isObjectURL(url)).toBe(true);

    const tab = makeTabSource();
    mocks.registry.registerSource(tab);
    mocks.registry.updateObjectURLPins([{url, active: true}], tab);

    // * ~50 MB of newer videos: several times past the 32 MB byte budget, so
    // * the opened video's owner is certainly LRU-evicted while it plays
    churnVideos(storage, 30, 'churn');
    vi.runOnlyPendingTimers();

    expect(
      revokedUrls().size,
      'the churn did not revoke anything at all, so this test proved nothing: the LRU eviction pipeline it exists to drive never fired'
    ).toBeGreaterThan(0);
    expect(
      revokedUrls().has(url),
      'the video the user is watching full-screen shows "Unfortunately, this video can\'t be played" because the blob URL its pin was supposed to protect was revoked while newer media churned the thumbs budget'
    ).toBe(false);
  });

  it('keeps a handed-out URL alive through the whole grace window between eviction and the pin landing', () => {
    const storage = makeStorage();
    const video = makeDocument('pin-in-flight');
    storage.setCacheContextBlob(video, undefined, videoBlob(), VIDEO_BYTES);
    const url = storage.getCacheContext(video).url;

    // * the URL is evicted right after the viewer read it, while the pin is
    // * still crossing the message port
    churnVideos(storage, 30, 'gap-churn');

    const tab = makeTabSource();
    mocks.registry.registerSource(tab);
    vi.advanceTimersByTime(OBJECT_URL_GRACE_TTL - 1);
    mocks.registry.updateObjectURLPins([{url, active: true}], tab);
    vi.runOnlyPendingTimers();

    expect(
      revokedUrls().size,
      'the churn did not revoke anything at all, so this test proved nothing: the eviction-into-grace pipeline it exists to drive never fired'
    ).toBeGreaterThan(0);
    expect(
      revokedUrls().has(url),
      'the video the user opened shows "Unfortunately, this video can\'t be played" because the blob URL it was given was revoked in the gap between the worker evicting it and the viewer\'s pin arriving, inside the grace window that exists to cover exactly that gap'
    ).toBe(false);
  });

  it('never leaves a worker cache context or a tab mirror exposing a revoked URL, even past the grace budget', () => {
    const storage = makeStorage();

    // * hostile interleave: enough video bytes to overflow not only the 32 MB
    // * thumbs budget but the 128 MB grace budget (forcing immediate revokes),
    // * with thumbnail traffic, re-reads, sender-side temp-to-final moves,
    // * stream-URL adoptions and deletions mixed in
    for(let wave = 0; wave < 10; ++wave) {
      churnVideos(storage, 10, `wave-${wave}`);

      for(let i = 0; i < 6; ++i) {
        storage.setCacheContextBlob(makeDocument(`thumb-${wave}-${i}`), 'm', thumbBlob(), THUMB_BYTES);
      }

      // * a rendering tab re-reads older contexts while they still exist
      storage.getCacheContext(makeDocument(`wave-${Math.max(0, wave - 1)}-5`));
      storage.getCacheContext(makeDocument(`thumb-${wave}-0`), 'm');

      // * sender flow: the temporary document is replaced by the server one
      const temp = makeDocument(`temp-${wave}`);
      storage.setCacheContextBlob(temp, undefined, videoBlob(), VIDEO_BYTES);
      storage.moveCacheContext(temp, makeDocument(`final-${wave}`));

      // * a document turning streamable adopts a non-blob URL over its blob one
      storage.setCacheContextURL(makeDocument(`wave-${wave}-3`), undefined, `stream/${wave}`, 0);

      storage.deleteCacheContext(makeDocument(`wave-${wave}-7`));
      storage.saveStickerPreview(`sticker-${wave}`, thumbBlob(), 128, 128, 0);
    }

    const overflowRevocations = mocks.revokeObjectURL.mock.calls.length;
    expect(
      overflowRevocations,
      'the workload never overflowed the 128 MB grace budget, so the immediate-revoke lane this test exists to drive never fired'
    ).toBeGreaterThan(0);

    vi.runOnlyPendingTimers();

    const revoked = revokedUrls();
    const exposed = collectExposedBlobUrls(storage);
    expect(
      exposed.size,
      'no cache context exposes any blob URL after the workload, so the exposure sweep below is vacuous and proves nothing'
    ).toBeGreaterThan(0);
    for(const [slot, url] of exposed) {
      expect(
        revoked.has(url),
        `opening the media at cache slot "${slot}" shows "Unfortunately, this video can't be played" because the worker's own cache context still hands out a blob URL that was already revoked`
      ).toBe(false);
      expect(
        mocks.registry.hasOwners(url),
        `the media at cache slot "${slot}" is one churn away from the "can't be played" toast: its cache context exposes a blob URL the registry no longer owns, so the next grace sweep revokes it while it is still being handed to consumers`
      ).toBe(true);
    }

    const tabMirror = buildTabMirror();
    for(const key in tabMirror) {
      const sizes = tabMirror[key];
      for(const size in sizes) {
        const url = sizes[size].url;
        if(!isObjectURL(url)) {
          continue;
        }

        expect(
          revoked.has(url),
          `a tab rendering the media mirrored at "${key}"/"${size}" shows "Unfortunately, this video can't be played" because its thumbs mirror still exposes a blob URL the worker already revoked — the eviction never invalidated the mirror`
        ).toBe(false);
      }
    }
  });
});
