import {expect, Page} from '@playwright/test';

import {MediaPayload} from './mediaFixtures';
import {bestSsimAgainstReferences, decodePngBase64ToGray, MIN_ACCEPTABLE_SSIM} from './perceptual';

/*
 * Media fidelity invariant of the B2 lane (issue #108). The old bar here was
 * `naturalWidth >= 100` — a "not the stripped blur" check that a 180px rung upscaled into a
 * 340px bubble passed, and that any poster "present but visually poor" passed. It is replaced
 * by two assertions per PAINTED media element (the element the user actually sees, resolved
 * through elementsFromPoint — a blurred <canvas> placeholder on top is itself a failure):
 *
 *   a. NO UPSCALING — naturalWidth >= cssWidth * devicePixelRatio. A ladder rung too small
 *      for its box is exactly what "шакально" looks like.
 *   b. PERCEPTUAL MATCH — the painted bitmap, rasterized in page context to the device-pixel
 *      box the user sees, must reach MIN_ACCEPTABLE_SSIM against the KNOWN source the
 *      scenario uploaded (rasterized to the same box with the same cover-crop). For videos
 *      the reference is the best-matching real frame of the uploaded source, decoded by the
 *      page itself. Metric and calibration: perceptual.ts.
 *
 * Both raster passes use the same canvas resampler in the same browser, so a faithful render
 * compares high while an upscaled stand-in loses exactly the detail SSIM's variance and
 * covariance terms punish.
 *
 * Calibration seam (IMPULSE_FIDELITY_CALIBRATE=1): every capture additionally renders the
 * message's OWN server-stored stripped thumb deliberately upscaled into the same box and
 * reports its SSIM — the known-bad measurement the threshold in perceptual.ts is derived
 * from. It is reported, never asserted.
 */
export type FidelityExpectation = {
  label: string,
  kind: 'photo' | 'video',
  sourceBase64: string,
  sourceMime: string
};

export type FidelityMeasurement = {
  label: string,
  mid: string,
  paintedTag: string,
  naturalWidth: number,
  naturalHeight: number,
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  ssim: number,
  texturedWindows: number,
  totalWindows: number,
  referenceIndex: number,
  availableThumbs: string,
  strippedUpscaleSsim: number | undefined
};

type PageItemCapture = {
  index: number,
  mid: string,
  failure: string | undefined,
  paintedTag: string | undefined,
  naturalWidth: number,
  naturalHeight: number,
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  renderedPngBase64: string | undefined,
  referencePngsBase64: string[],
  availableThumbs: string,
  strippedUpscalePngBase64: string | undefined
};

const VIDEO_REFERENCE_SAMPLES = 8;
const FIDELITY_TIMEOUT_MS = 90_000;
const FIDELITY_POLL_DELAY_MS = 2_000;


export function fidelityExpectationsFor(payloads: MediaPayload[]): FidelityExpectation[] {
  return payloads.map((payload) => ({
    label: payload.name,
    kind: payload.mimeType.startsWith('video/') ? 'video' : 'photo',
    sourceBase64: payload.buffer.toString('base64'),
    sourceMime: payload.mimeType
  }));
}


export async function waitForAlbum(page: Page, side: string, expectedCount: number): Promise<void> {
  await expect
    .poll(async() => {
      return page.evaluate(() => {
        const container: HTMLElement | undefined = (window as any).appImManager?.chat?.bubbles?.container;
        return container ? container.querySelectorAll('.grouped-item').length : 0;
      });
    }, {
      timeout: 120_000,
      message: `the ${side} side never rendered the ${expectedCount}-item album as grouped media — ` +
        'either the messages did not arrive on this side at all, or they arrived ungrouped ' +
        '(each count below the expectation is an album member the user does not see)'
    })
    .toBe(expectedCount);
}


export async function assertAlbumFidelity(
  page: Page,
  side: string,
  expectations: FidelityExpectation[],
  context: string
): Promise<FidelityMeasurement[]> {
  await waitForAlbum(page, side, expectations.length);
  return assertMediaFidelity(page, side, '.grouped-item', expectations, context);
}


/**
 * The fidelity invariant over every element `scopeSelector` matches inside the open chat, in
 * DOM order, one expectation per element. Returns the per-element measurements so the
 * scenario can put the numbers into the run log.
 */
export async function assertMediaFidelity(
  page: Page,
  side: string,
  scopeSelector: string,
  expectations: FidelityExpectation[],
  context: string
): Promise<FidelityMeasurement[]> {
  const calibrate = process.env.IMPULSE_FIDELITY_CALIBRATE === '1';
  const deadline = Date.now() + FIDELITY_TIMEOUT_MS;

  for(;;) {
    const captures = await captureFidelity(page, scopeSelector, expectations, calibrate);
    const {failures, measurements} = judgeCaptures(captures, expectations);

    if(failures.length === 0) {
      for(const measurement of measurements) {
        const stripped = measurement.strippedUpscaleSsim === undefined ?
          '' :
          ` bad(stripped-upscale) ssim=${measurement.strippedUpscaleSsim.toFixed(3)}`;
        console.log(
          `[fidelity] ${side} / ${context} / ${measurement.label} (mid=${measurement.mid}, ` +
          `${measurement.paintedTag} natural=${measurement.naturalWidth}x${measurement.naturalHeight} ` +
          `css=${measurement.cssWidth.toFixed(1)}x${measurement.cssHeight.toFixed(1)} ` +
          `dpr=${measurement.devicePixelRatio}): ssim=${measurement.ssim.toFixed(3)} ` +
          `(textured ${measurement.texturedWindows}/${measurement.totalWindows} windows, ` +
          `reference frame #${measurement.referenceIndex}, threshold ${MIN_ACCEPTABLE_SSIM})${stripped}`
        );
      }
      return measurements;
    }

    if(Date.now() > deadline) {
      expect(
        failures,
        `MEDIA FIDELITY violated on the ${side} side during "${context}": the preview the user ` +
        'looks at is a blurred/upscaled stand-in, not the poster the server stored. Every entry ' +
        'in the received array names one media element that either paints an upscaled rung ' +
        '(naturalWidth below cssWidth x devicePixelRatio) or fails the perceptual match against ' +
        `the uploaded source (SSIM below ${MIN_ACCEPTABLE_SSIM} — metric and calibration in ` +
        'e2e/live/perceptual.ts)'
      ).toEqual([]);
    }

    await page.waitForTimeout(FIDELITY_POLL_DELAY_MS);
  }
}


function judgeCaptures(
  captures: PageItemCapture[],
  expectations: FidelityExpectation[]
): {failures: string[], measurements: FidelityMeasurement[]} {
  const failures: string[] = [];
  const measurements: FidelityMeasurement[] = [];

  for(const capture of captures) {
    const expectation = expectations[capture.index];
    const label = expectation ? expectation.label : `(unexpected element #${capture.index})`;

    if(capture.failure) {
      failures.push(`${label}: ${capture.failure}`);
      continue;
    }

    const rendered = decodePngBase64ToGray(capture.renderedPngBase64);
    const references = capture.referencePngsBase64.map(decodePngBase64ToGray);
    const {result, referenceIndex} = bestSsimAgainstReferences(rendered, references);

    let strippedUpscaleSsim: number | undefined;
    if(capture.strippedUpscalePngBase64) {
      const strippedRendered = decodePngBase64ToGray(capture.strippedUpscalePngBase64);
      strippedUpscaleSsim = bestSsimAgainstReferences(strippedRendered, references).result.ssim;
    }

    // Both bars are evaluated on every element even when the first already failed: a red must
    // quote the metric value alongside the geometry, and an element can violate both at once.
    const problems: string[] = [];

    const requiredNaturalWidth = capture.cssWidth * capture.devicePixelRatio;
    if(capture.naturalWidth < Math.floor(requiredNaturalWidth)) {
      problems.push(
        `UPSCALED — a ${capture.naturalWidth}x${capture.naturalHeight} bitmap stretched into the box ` +
        `(needs naturalWidth >= ${requiredNaturalWidth.toFixed(0)}): the rung shipped to the user is ` +
        'too small for the box he sees it in'
      );
    }

    if(result.ssim < MIN_ACCEPTABLE_SSIM) {
      problems.push(
        `PERCEPTUAL MISMATCH — reaches only ssim=${result.ssim.toFixed(3)} against the uploaded ` +
        `source (threshold ${MIN_ACCEPTABLE_SSIM}, best reference frame #${referenceIndex}, textured ` +
        `${result.texturedWindows}/${result.totalWindows} windows): the user is looking at a ` +
        'blurred/degraded stand-in, not the picture the server stored'
      );
    }

    if(problems.length > 0) {
      failures.push(
        `${label} (mid=${capture.mid}, painted ${capture.paintedTag} ` +
        `natural=${capture.naturalWidth}x${capture.naturalHeight} ` +
        `css=${capture.cssWidth.toFixed(1)}x${capture.cssHeight.toFixed(1)} ` +
        `dpr=${capture.devicePixelRatio}, ssim=${result.ssim.toFixed(3)}, ` +
        `thumbs the document offers: [${capture.availableThumbs}]): ${problems.join('; AND ')}`
      );
      continue;
    }

    measurements.push({
      label,
      mid: capture.mid,
      paintedTag: capture.paintedTag,
      naturalWidth: capture.naturalWidth,
      naturalHeight: capture.naturalHeight,
      cssWidth: capture.cssWidth,
      cssHeight: capture.cssHeight,
      devicePixelRatio: capture.devicePixelRatio,
      ssim: result.ssim,
      texturedWindows: result.texturedWindows,
      totalWindows: result.totalWindows,
      referenceIndex,
      availableThumbs: capture.availableThumbs,
      strippedUpscaleSsim
    });
  }

  return {failures, measurements};
}


async function captureFidelity(
  page: Page,
  scopeSelector: string,
  expectations: FidelityExpectation[],
  calibrate: boolean
): Promise<PageItemCapture[]> {
  const sources = expectations.map((expectation) => ({
    kind: expectation.kind,
    base64: expectation.sourceBase64,
    mime: expectation.sourceMime
  }));

  return page.evaluate(async({scopeSelector, sources, videoReferenceSamples, calibrate}) => {
    const dynamicImport = new Function('p', 'return import(p)') as (p: string) => Promise<any>;

    const w = window as any;
    const chat = w.appImManager?.chat;
    const container: HTMLElement | undefined = chat?.bubbles?.container;

    const toBytes = (base64: string): Uint8Array<ArrayBuffer> => {
      const raw = atob(base64);
      const bytes = new Uint8Array(new ArrayBuffer(raw.length));
      for(let i = 0; i < raw.length; ++i) {
        bytes[i] = raw.charCodeAt(i);
      }
      return bytes;
    };

    const rasterizeCover = (
      source: CanvasImageSource,
      sourceWidth: number,
      sourceHeight: number,
      boxWidth: number,
      boxHeight: number
    ): string => {
      const canvas = document.createElement('canvas');
      canvas.width = boxWidth;
      canvas.height = boxHeight;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      let cropWidth = sourceWidth;
      let cropHeight = sourceHeight;
      if(sourceWidth * boxHeight > sourceHeight * boxWidth) {
        cropWidth = Math.round(sourceHeight * boxWidth / boxHeight);
      } else {
        cropHeight = Math.round(sourceWidth * boxHeight / boxWidth);
      }
      const cropX = Math.floor((sourceWidth - cropWidth) / 2);
      const cropY = Math.floor((sourceHeight - cropHeight) / 2);

      ctx.drawImage(source, cropX, cropY, cropWidth, cropHeight, 0, 0, boxWidth, boxHeight);
      return canvas.toDataURL('image/png').split(',')[1];
    };

    const decodeImage = async(bytes: Uint8Array<ArrayBuffer>, mime: string): Promise<HTMLImageElement> => {
      const url = URL.createObjectURL(new Blob([bytes], {type: mime}));
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
        return image;
      } finally {
        // The bitmap stays decoded on the element after revoke.
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    };

    const decodeVideoFrames = async(
      bytes: Uint8Array<ArrayBuffer>,
      mime: string,
      boxWidth: number,
      boxHeight: number,
      extraTime: number | undefined
    ): Promise<string[]> => {
      const url = URL.createObjectURL(new Blob([bytes], {type: mime}));
      const video = document.createElement('video');
      video.muted = true;
      video.preload = 'auto';
      video.src = url;

      await new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error('the reference video failed to decode in the page'));
      });

      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const times: number[] = [];
      for(let i = 0; i < videoReferenceSamples; ++i) {
        times.push(duration * i / videoReferenceSamples);
      }
      if(extraTime !== undefined && Number.isFinite(extraTime)) {
        // A PLAYING preview advances between painting its frame and this capture, and a seek
        // may land on the neighbouring decoded frame — bracket the reported currentTime by
        // ±2 frames (30fps recorder cadence) so a faithful moving render meets its own frame.
        for(let frameOffset = -2; frameOffset <= 2; ++frameOffset) {
          const time = extraTime + frameOffset / 30;
          times.push(Math.min(Math.max(0, time), Math.max(0, duration - 0.001)));
        }
      }

      const frames: string[] = [];
      for(const time of times) {
        await new Promise<void>((resolve) => {
          video.onseeked = () => resolve();
          video.currentTime = time;
        });
        frames.push(rasterizeCover(video, video.videoWidth, video.videoHeight, boxWidth, boxHeight));
      }

      URL.revokeObjectURL(url);
      return frames;
    };

    const paintedMediaOf = (item: HTMLElement): HTMLImageElement | HTMLVideoElement | HTMLCanvasElement | null => {
      item.scrollIntoView({block: 'center', behavior: 'instant' as ScrollBehavior});
      const rect = item.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      for(const element of document.elementsFromPoint(centerX, centerY)) {
        if(!item.contains(element)) {
          continue;
        }
        if(element instanceof HTMLImageElement || element instanceof HTMLVideoElement || element instanceof HTMLCanvasElement) {
          return element;
        }
      }

      return null;
    };

    const mediaObjectOf = async(mid: string): Promise<any> => {
      const message = await w.rootScope.managers.appMessagesManager.getMessageByPeer(chat.peerId, +mid);
      const media = message?.media;
      return media?.photo ?? media?.document;
    };

    // What the DOCUMENT offers the client to paint — quoted in every failure so a red names
    // the guilty layer itself: a ladder with no adequate rung indicts the payload, an adequate
    // rung left unpainted indicts the client's choice/download.
    const thumbsSummaryOf = async(mid: string): Promise<string> => {
      try {
        const object = await mediaObjectOf(mid);
        const thumbs: any[] = [...(object?.sizes ?? object?.thumbs ?? []), ...(object?.video_thumbs ?? [])];
        return thumbs
          .map((thumb) => `${thumb._}${thumb.type ? `:${thumb.type}` : ''} ${thumb.w ?? '?'}x${thumb.h ?? '?'}`)
          .join(', ');
      } catch(error: any) {
        return `(unavailable: ${error?.message ?? String(error)})`;
      }
    };

    const strippedUpscaleOf = async(mid: string, boxWidth: number, boxHeight: number): Promise<string | undefined> => {
      const object = await mediaObjectOf(mid);
      const thumbs: any[] = object?.sizes ?? object?.thumbs ?? [];
      const stripped = thumbs.find((thumb) => thumb._ === 'photoStrippedSize');
      if(!stripped?.bytes) {
        return undefined;
      }

      const {default: getPreviewURLFromBytes} = await dynamicImport('/src/helpers/bytes/getPreviewURLFromBytes.ts');
      const url: string = getPreviewURLFromBytes(stripped.bytes, false);
      const image = new Image();
      image.src = url;
      await image.decode();
      return rasterizeCover(image, image.naturalWidth, image.naturalHeight, boxWidth, boxHeight);
    };

    const items = container ? Array.from(container.querySelectorAll<HTMLElement>(scopeSelector)) : [];
    const results: PageItemCapture[] = [];

    if(items.length !== sources.length) {
      return [{
        index: 0,
        mid: '(none)',
        failure: `the open chat renders ${items.length} media element(s) matching "${scopeSelector}" ` +
          `while the scenario uploaded ${sources.length} — a media message the user cannot see at all`,
        paintedTag: undefined,
        naturalWidth: 0,
        naturalHeight: 0,
        cssWidth: 0,
        cssHeight: 0,
        devicePixelRatio: window.devicePixelRatio,
        renderedPngBase64: undefined,
        referencePngsBase64: [],
        availableThumbs: '',
        strippedUpscalePngBase64: undefined
      }];
    }

    for(let index = 0; index < items.length; ++index) {
      const item = items[index];
      const source = sources[index];
      const mid = item.dataset.mid ?? item.closest<HTMLElement>('[data-mid]')?.dataset.mid ?? '(no mid)';

      const base: PageItemCapture = {
        index,
        mid,
        failure: undefined,
        paintedTag: undefined,
        naturalWidth: 0,
        naturalHeight: 0,
        cssWidth: 0,
        cssHeight: 0,
        devicePixelRatio: window.devicePixelRatio,
        renderedPngBase64: undefined,
        referencePngsBase64: [],
        availableThumbs: await thumbsSummaryOf(mid),
        strippedUpscalePngBase64: undefined
      };

      const painted = paintedMediaOf(item);
      if(!painted) {
        results.push({...base, failure: 'no painted media element at the box center — the user sees an empty box'});
        continue;
      }
      if(painted instanceof HTMLCanvasElement) {
        results.push({
          ...base,
          paintedTag: 'CANVAS',
          failure: 'the topmost painted surface is a <canvas> blur placeholder — the user sees ' +
            'the blurred stand-in, the real preview never took its place'
        });
        continue;
      }

      const isVideo = painted instanceof HTMLVideoElement;
      const naturalWidth = isVideo ? (painted as HTMLVideoElement).videoWidth : (painted as HTMLImageElement).naturalWidth;
      const naturalHeight = isVideo ? (painted as HTMLVideoElement).videoHeight : (painted as HTMLImageElement).naturalHeight;
      const paintedRect = painted.getBoundingClientRect();
      const boxWidth = Math.max(1, Math.round(paintedRect.width * window.devicePixelRatio));
      const boxHeight = Math.max(1, Math.round(paintedRect.height * window.devicePixelRatio));

      const capture: PageItemCapture = {
        ...base,
        paintedTag: painted.tagName,
        naturalWidth,
        naturalHeight,
        cssWidth: paintedRect.width,
        cssHeight: paintedRect.height,
        devicePixelRatio: window.devicePixelRatio
      };

      if(naturalWidth === 0 || naturalHeight === 0) {
        results.push({...capture, failure: `the painted ${painted.tagName} has no decoded bitmap yet (natural size 0)`});
        continue;
      }

      try {
        capture.renderedPngBase64 = rasterizeCover(painted, naturalWidth, naturalHeight, boxWidth, boxHeight);

        const sourceBytes = toBytes(source.base64);
        if(source.kind === 'video') {
          const paintedTime = isVideo ? (painted as HTMLVideoElement).currentTime : undefined;
          capture.referencePngsBase64 = await decodeVideoFrames(sourceBytes, source.mime, boxWidth, boxHeight, paintedTime);
        } else {
          const image = await decodeImage(sourceBytes, source.mime);
          capture.referencePngsBase64 = [rasterizeCover(image, image.naturalWidth, image.naturalHeight, boxWidth, boxHeight)];
        }

        if(calibrate) {
          capture.strippedUpscalePngBase64 = await strippedUpscaleOf(mid, boxWidth, boxHeight);
        }
      } catch(error: any) {
        results.push({...capture, failure: `capture failed in page context: ${error?.message ?? String(error)}`});
        continue;
      }

      results.push(capture);
    }

    return results;
  }, {scopeSelector, sources, videoReferenceSamples: VIDEO_REFERENCE_SAMPLES, calibrate});
}
