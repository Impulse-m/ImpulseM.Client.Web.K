/**
 * Per-container thumb controller for wrapSticker's lottie path: shows an instant
 * silhouette, upgrades it to a preview image, then retires it (and any adopted
 * prior-generation media) once the player's canvas is provably on screen. Disposal
 * only makes it inert - the next generation adopts whatever DOM is left.
 */
import type LottiePlayer from '@lib/lottie/lottiePlayer';
import liteMode from '@helpers/liteMode';
import {MOUNT_CLASS_TO} from '@config/debug';
import {Middleware} from '@helpers/middleware';
import {pinObjectURL} from '@helpers/objectUrl';

export const onAnimationEnd = (element: HTMLElement, onAnimationEnd: () => void, timeout: number) => {
  const onEnd = () => {
    element.removeEventListener('animationend', onEnd);
    onAnimationEnd();
    clearTimeout(_timeout);
  };
  element.addEventListener('animationend', onEnd);
  const _timeout = setTimeout(onEnd, timeout);
};

const whenAnimationEnd = (element: HTMLElement, timeout: number) =>
  new Promise<void>((resolve) => onAnimationEnd(element, resolve, timeout));

const MEDIA_TAGS = new Set(['CANVAS', 'VIDEO', 'IMG', 'svg']);

export type StickerAppearance = ReturnType<typeof createStickerAppearance>;

export default function createStickerAppearance({container, thumbKey, middleware, replacePreviousMedia}: {
  container: HTMLElement,
  thumbKey: string,
  middleware?: Middleware,
  replacePreviousMedia?: boolean
}) {
  let disposed = false;
  let mediaArrived = false;
  let underlay: HTMLElement; // current silhouette / preview image
  const previous: HTMLElement[] = []; // adopted prior-generation media, retired under the new layer

  // A cached sticker preview is an <img> whose only source is a worker-owned blob: URL,
  // and the worker's sticker-thumb LRU (64 URLs / 8 MB, thumbs.ts:33-34) evicts and then
  // revokes it purely by age - it cannot see which previews are on screen. Once revoked,
  // an attached <img> that has to repaint from its src shows the browser's broken-image
  // placeholder (#315: the emoji panel's 38 search-strip group icons are the first
  // previews rendered and the first evicted). So the pin follows the ATTACHED element,
  // taken by whichever controller owns the container's layering and released the moment
  // the element is retired or this controller is disposed. Pinning per attached element
  // rather than for the wrapper's lifetime is what keeps the budget meaningful: a panel
  // cell releases its preview as soon as the sticker canvas presents, and a preview no
  // one ever rendered is never pinned, so the LRU still reclaims everything unattached.
  // A dispose/adopt handover is covered by the registry's grace TTL, which outlives the
  // gap between the outgoing controller releasing and the incoming one re-pinning.
  const pins = new Map<HTMLElement, VoidFunction>();

  const pinAttached = (element: HTMLElement) => {
    if(element.tagName !== 'IMG' || pins.has(element)) return;
    pins.set(element, pinObjectURL((element as HTMLImageElement).src));
  };

  const releasePin = (element: HTMLElement) => {
    const unpin = pins.get(element);
    if(!unpin) return;
    pins.delete(element);
    unpin();
  };

  const retire = (element: HTMLElement) => {
    releasePin(element);
    element.remove();
  };

  middleware?.onClean(() => {
    disposed = true;
    pins.forEach((unpin) => unpin());
    pins.clear();
  });

  // adopt a reused container's leftovers: reuse a same-key thumb as the underlay, keep
  // other media beneath until the new frame presents (the premium lock and DIVs stay)
  for(const child of Array.from(container.children) as HTMLElement[]) {
    if(child.classList.contains('premium-sticker-lock') || child.tagName === 'DIV') continue;
    else if(!underlay && child.dataset.stickerThumb === thumbKey) underlay = child;
    else if(MEDIA_TAGS.has(child.tagName)) previous.push(child);
  }

  // an adopted preview stays on screen under this controller, so its URL becomes ours to
  // keep alive - the generation that pinned it is releasing its own pin right about now
  if(underlay) {
    pinAttached(underlay);
  }

  previous.forEach(pinAttached);

  const canBuildSilhouette = () => !disposed && !mediaArrived && !underlay && !previous.length;
  // previous media blocks a plain image insert (a re-wrapped reaction keeps its full-res
  // img); only onlyThumb re-wraps (replacePreviousMedia) replace it
  const canBuildImage = () => !disposed && !mediaArrived && underlay?.tagName !== 'IMG' && (replacePreviousMedia || !previous.length);

  const setSilhouette = (svg: SVGSVGElement) => {
    if(!canBuildSilhouette()) return;

    svg.classList.add('lottie-vector', 'media-sticker', 'thumbnail');
    svg.dataset.stickerThumb = thumbKey;
    container.append(svg);
    underlay = svg as Element as HTMLElement;
  };

  const upgradeToImage = (image: HTMLImageElement, onApplied?: VoidFunction) => {
    if(!canBuildImage()) return onApplied?.();

    image.alt = '';

    // gate the swap on decode so a not-yet-decoded img can't paint blank over the
    // silhouette for a frame (instant when cached; on failure keep what we have)
    (image.decode ? image.decode() : Promise.resolve()).then(() => {
      if(!canBuildImage()) return onApplied?.();

      image.classList.add('media-sticker', 'thumbnail');
      image.dataset.stickerThumb = thumbKey;
      if(underlay) {
        releasePin(underlay);
        underlay.replaceWith(image);
      } else {
        container.append(image);
      }

      underlay = image;
      pinAttached(image);
      previous.splice(0).forEach(retire);
      onApplied?.();
    }, () => onApplied?.());
  };

  const onMediaFirstFrame = async({animation, canvas, needFadeIn}: {
    animation: LottiePlayer,
    canvas: HTMLCanvasElement | undefined,
    needFadeIn?: boolean
  }) => {
    if(disposed || mediaArrived) return;

    mediaArrived = true;
    const lower = [...previous, underlay].filter(Boolean);
    const top = lower[lower.length - 1];
    underlay = undefined;
    previous.length = 0;

    // Cross-fade the canvas over the lightweight vector silhouette. A raster underlay stays
    // fully opaque until the removal below, so fading over one would keep showing the loading
    // state after the media became available. Callers that render an already-settled frame
    // (such as a read dice) explicitly opt out with needFadeIn=false.
    const fade = needFadeIn !== false &&
      (needFadeIn || !top || top.tagName === 'svg') &&
      liteMode.isAvailable('animations');

    // the canvas is attached and on top of the thumb by now (the player mounts it before
    // firstFrame); fade it in over an empty cell or the vector silhouette on cold start
    if(fade && canvas) {
      canvas.classList.add('fade-in');
      await whenAnimationEnd(canvas, 400);
      canvas.classList.remove('fade-in');
    }

    // ensurePresented re-presents the staged frame onto the attached canvas and waits until it has
    // reached the screen; only then drop the thumb - instantly, no fade. By the time it resolves the
    // canvas already covers the cell, so the removal is invisible and never flashes blank.
    await animation.ensurePresented();
    if(disposed) return;

    lower.forEach(retire);
  };

  return {
    canBuildSilhouette,
    canBuildImage,
    setSilhouette,
    upgradeToImage,
    onMediaFirstFrame
  };
}

// debug-mounted (like lottieLoader/liteMode) so the browser no-blink test can drive the real
// controller against a local .tgs without bootstrapping the whole wrapSticker/doc pipeline
MOUNT_CLASS_TO && (MOUNT_CLASS_TO.createStickerAppearance = createStickerAppearance);
