// * Pins the object-URL lifetime invariant behind wrapSticker's cached-preview
// * branch (sticker.ts:257-275): the tab reads a sticker preview out of the
// * stickerThumbs mirror and hands its blob: URL to an <img> that then lives in
// * the container for as long as the cell shows a preview. #315 - the emoji
// * panel's 38 search-strip group icons are the first previews rendered and, past
// * the 64-URL / 8 MB sticker-thumb budget (thumbs.ts:33-34), the first ones the
// * LRU evicts; their URLs were revoked while their <img> elements were still
// * attached, so the strip repainted as the browser's broken-image placeholder.
// * These tests drive the REAL ThumbsStorage + SharedObjectUrlCache +
// * ObjectUrlCacheBudget + ObjectUrlRegistry + createStickerAppearance +
// * renderImageFromUrl and assert that an attached preview never points at a
// * revoked URL - while an unattached one is still reclaimed, so the budget keeps
// * meaning something.

type MirroredStickerThumbPayload = {
  name: 'stickerThumbs' | 'thumbs',
  key?: string,
  value?: unknown,
  previousUrl?: string,
  accountNumber: number
};

const mocks = vi.hoisted(() => ({
  createObjectURL: vi.fn<(blob: Blob) => string>(),
  mirror: vi.fn<(method: string, payload: MirroredStickerThumbPayload) => void>(),
  proxyInvokeVoid: vi.fn<(method: string, payload: unknown) => void>(),
  registry: undefined as unknown as import('@lib/mainWorker/objectUrlRegistry').ObjectUrlRegistry,
  revokeObjectURL: vi.fn<(url: string) => void>()
}));

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

vi.mock('@lib/apiManagerProxy', () => ({
  default: {
    invokeVoid: mocks.proxyInvokeVoid
  }
}));

vi.mock('@helpers/liteMode', () => ({
  default: {isAvailable: () => true}
}));

import type LottiePlayer from '@lib/lottie/lottiePlayer';
import type {ObjectURLPinUpdate} from '@helpers/objectUrlUtils';
import type {StickerCachedThumb, StickerCachedThumbs} from '@lib/storages/thumbs';
import createStickerAppearance, {type StickerAppearance} from '@components/wrappers/stickerAppearance';
import getStickerThumbKey from '@lib/storages/utils/thumbs/getStickerThumbKey';
import reconcileObjectURLMirrorValue from '@lib/apiManagerProxyUtils/reconcileObjectURLMirrorValue';
import renderImageFromUrl from '@helpers/dom/renderImageFromUrl';
import ThumbsStorage from '@lib/storages/thumbs';
import {forgetLoadedURL} from '@helpers/dom/loadedUrlCache';
import {getMiddleware, type MiddlewareHelper} from '@helpers/middleware';
import {isObjectURL} from '@helpers/objectUrlUtils';
import {resetSharedObjectURLCaches} from '@lib/mainWorker/sharedObjectUrlCache';

// * thumbs.ts:33 - the sticker preview budget the emoji panel walks straight past
const STICKER_THUMB_OBJECT_URL_CACHE_LIMIT = 64;
// * one emoji tab's worth of played stickers, each caching its first frame
const PANEL_PREVIEWS = 100;
const PREVIEW_BYTES = 2 * 1024;
const PREVIEW_SIZE = 24;
const TONE_INDEX = 0;
const ACCOUNT_NUMBER = 1;
const EMOJI_GROUP_ICON = 'emoji-group-icon';

type RenderedPreview = {
  appearance: StickerAppearance,
  container: HTMLDivElement,
  image: HTMLImageElement,
  middlewareHelper: MiddlewareHelper,
  url: string
};

let nextUrl = 0;
let storage: ThumbsStorage;
let tabStickerThumbs: StickerCachedThumbs;

const tabSource = {} as MessageEventSource;

const previewBlob = () => new Blob([new Uint8Array(PREVIEW_BYTES)]);

const revokedUrls = () => new Set(mocks.revokeObjectURL.mock.calls.map(([url]) => url));

const makeStorage = () => {
  const created = new ThumbsStorage();
  (created as unknown as {accountNumber: number}).accountNumber = ACCOUNT_NUMBER;
  return created;
};

// * the worker side of a played lottie: saveLottiePreview caches its first frame
const savePreview = (docId: string) => {
  storage.saveStickerPreview(docId, previewBlob(), PREVIEW_SIZE, PREVIEW_SIZE, TONE_INDEX);
};

// * apiManagerProxy.ts:1176-1179 - what wrapSticker reads for the cached branch
const tabGetStickerCachedThumb = (docId: string) => {
  return tabStickerThumbs[getStickerThumbKey(docId, TONE_INDEX)] as StickerCachedThumb | undefined;
};

// * jsdom implements neither HTMLImageElement.decode nor a fetch of a blob: URL,
// * so the browser's answer is modelled here: an image repaints while the object
// * URL behind its src is live and fails once it has been revoked - the failure
// * that paints the broken-image placeholder #315 reports.
function installImageDecode() {
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {
    configurable: true,
    value: function(this: HTMLImageElement): Promise<void> {
      return isObjectURL(this.src) && revokedUrls().has(this.src) ?
        Promise.reject(new DOMException('The source image cannot be decoded.', 'EncodingError')) :
        Promise.resolve();
    }
  });
}

function uninstallImageDecode() {
  delete (HTMLImageElement.prototype as Partial<HTMLImageElement>).decode;
}

// * pin updates are batched into a microtask before they cross to the worker
// * (objectUrl.ts:14-25)
const flushPinUpdates = () => Promise.resolve();

// * exactly wrapSticker's cached-preview branch: read the mirrored {url}, draw it
// * into an <img> through renderImageFromUrl and let the appearance controller
// * attach it (sticker.ts:223, :257-275)
async function renderCachedPreview(docId: string): Promise<RenderedPreview> {
  savePreview(docId);

  const thumb = tabGetStickerCachedThumb(docId);
  expect(thumb, `the worker never mirrored a cached preview for "${docId}"`).toBeDefined();

  const container = document.createElement('div');
  document.body.append(container);

  const middlewareHelper = getMiddleware();
  const appearance = createStickerAppearance({
    container,
    thumbKey: getStickerThumbKey(docId, TONE_INDEX),
    middleware: middlewareHelper.get()
  });

  const image = new Image();
  await new Promise<void>((resolve) => {
    renderImageFromUrl(image, thumb.url, () => appearance.upgradeToImage(image, resolve));
  });
  await flushPinUpdates();

  expect(
    image.isConnected,
    `the preview for "${docId}" was never attached, so nothing below is about an attached <img>`
  ).toBe(true);

  return {appearance, container, image, middlewareHelper, url: thumb.url};
}

// * the rest of the emoji panel playing and caching its own previews behind the
// * search strip, walking the sticker-thumb LRU well past its 64-URL limit
function churnPanelPreviews() {
  for(let i = 0; i < PANEL_PREVIEWS; ++i) {
    savePreview(`panel-sticker-${i}`);
  }

  vi.runOnlyPendingTimers();

  expect(
    revokedUrls().size,
    `${PANEL_PREVIEWS} newer previews revoked nothing at all, so this test proved nothing: the ${STICKER_THUMB_OBJECT_URL_CACHE_LIMIT}-URL sticker-thumb eviction pipeline it exists to drive never fired`
  ).toBeGreaterThan(0);
}

const repaint = (image: HTMLImageElement) => {
  return image.decode().then(() => 'painted', () => 'broken-image placeholder');
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.createObjectURL.mockImplementation(() => `blob:test/sticker-preview-${++nextUrl}`);
  installImageDecode();

  tabStickerThumbs = {};
  storage = makeStorage();
  mocks.registry.registerSource(tabSource);

  // * apiManagerProxy.ts:1396-1409 + :253-255 - the tab forgets the retired URL,
  // * then reconciles the mirrored value; postMessage clones, so does this
  mocks.mirror.mockImplementation((method, payload) => {
    if(method !== 'mirror' || payload.name !== 'stickerThumbs' || !payload.key) {
      return;
    }

    if(payload.previousUrl) {
      forgetLoadedURL(payload.previousUrl);
    }

    reconcileObjectURLMirrorValue(
      tabStickerThumbs,
      payload.key,
      payload.value === undefined ? undefined : structuredClone(payload.value as StickerCachedThumb)
    );
  });

  // * index.worker.ts:216-218 - a tab's pin updates reach the worker registry
  mocks.proxyInvokeVoid.mockImplementation((method, payload) => {
    if(method === 'updateObjectURLPins') {
      mocks.registry.updateObjectURLPins(payload as ObjectURLPinUpdate[], tabSource);
    }
  });
});

afterEach(() => {
  resetSharedObjectURLCaches();
  mocks.registry.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
  uninstallImageDecode();
  document.body.replaceChildren();
});

describe('sticker preview object URL lifetime', () => {
  it('never revokes the URL under a still-attached preview image, however hard the panel churns the sticker-thumb budget', async() => {
    const icon = await renderCachedPreview(EMOJI_GROUP_ICON);

    churnPanelPreviews();

    expect(icon.image.isConnected).toBe(true);
    expect(icon.image.src).toBe(icon.url);
    expect(
      revokedUrls().has(icon.image.src),
      'the emoji panel\'s search-strip group icon shows the browser\'s broken-image placeholder: the blob: URL its still-attached <img> points at was revoked when the sticker-thumb LRU evicted it behind the panel\'s newer previews'
    ).toBe(false);
    expect(
      await repaint(icon.image),
      'the attached emoji-group icon can no longer repaint from its own src, which is what the user sees as the broken-image placeholder in the emoji panel\'s search strip'
    ).toBe('painted');
  });

  it('reclaims the URL of a preview whose container was destroyed', async() => {
    const closed = await renderCachedPreview('closed-panel-icon');

    closed.middlewareHelper.destroy();
    closed.container.remove();
    await flushPinUpdates();

    churnPanelPreviews();

    expect(
      revokedUrls().has(closed.url),
      'the sticker-thumb budget stopped meaning anything: a preview whose container is gone still holds its blob URL alive, so the 64-URL / 8 MB cap can no longer reclaim the bytes of anything a tab has ever rendered'
    ).toBe(true);
  });

  it('reclaims the URL of a preview the arriving media retired', async() => {
    const played = await renderCachedPreview('played-sticker');
    const canvas = document.createElement('canvas');
    played.container.append(canvas);

    await played.appearance.onMediaFirstFrame({
      animation: {ensurePresented: vi.fn().mockResolvedValue(undefined)} as unknown as LottiePlayer,
      canvas,
      needFadeIn: false
    });
    await flushPinUpdates();

    expect(
      played.image.isConnected,
      'the arriving canvas never retired the preview image, so this control says nothing about an unattached preview'
    ).toBe(false);

    churnPanelPreviews();

    expect(
      revokedUrls().has(played.url),
      'a preview image the arriving sticker canvas already removed from the DOM still holds its blob URL alive, so every played cell in the panel leaks its preview bytes past the 64-URL / 8 MB budget'
    ).toBe(true);
  });
});
