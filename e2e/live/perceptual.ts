import {PNG} from 'pngjs';

/*
 * Perceptual fidelity metric for the B2 lane (issue #108): grayscale SSIM between the bitmap
 * a media element actually painted and the KNOWN source frame the scenario uploaded, both
 * rasterized in page context to the exact device-pixel box the user is looking at
 * (cssWidth x devicePixelRatio). Implemented here from scratch — no runtime deps beyond pngjs,
 * which the lane's fixtures already use.
 *
 * Why texture-weighted: "шакальность" (an upscaled/blurred stand-in) is invisible on flat
 * color and lives entirely in detail — edges, texture, text. Plain mean SSIM over a frame
 * dominated by flat regions (the recorder test card is six solid color bars) rewards the blur:
 * flat windows compare near 1.0 no matter how destroyed the detail is. So the metric averages
 * per-window SSIM over the windows where the REFERENCE has real local variance
 * (var >= TEXTURE_VARIANCE_FLOOR), i.e. exactly the windows where a stand-in CAN be told from
 * the real render. When the reference is degenerate (fewer than MIN_TEXTURED_WINDOWS textured
 * windows) it falls back to all windows rather than judging on nothing.
 *
 * CALIBRATION (re-derivable: run the lane with IMPULSE_FIDELITY_CALIBRATE=1, which prints for
 * every element BOTH the good render's SSIM and the SSIM of the same message's server-stored
 * stripped thumb deliberately upscaled to the same box — the exact "present but poor" render
 * this invariant exists to fail). Measured on 2026-08-31 against the live dev stack
 * (chromium 1228, dpr=1, structured-photo + recorder-webm fixtures, album + single-bubble +
 * warm-cache scenarios, both personas, fresh / after tab reload / after browser restart):
 *
 *   known-good renders (real ladder rung or real video frame painted in the box):
 *     photos (640x480 rung in 418px box, 480x640 in 113px box)   ssim 1.000
 *     video posters (sender's 400x400 poster in a 151px box)     ssim 0.992
 *     playing <video> (400x400 frame in a 398px box)             ssim 1.000
 *   known-bad renders (the SAME messages' stripped ~40px thumb upscaled into the SAME box):
 *     photos                                                     ssim 0.142..0.253
 *     videos (test-card content is blur-friendlier)              ssim 0.302..0.500
 *
 * The floor sits between the two populations with ~0.2 headroom on each side: worst good
 * 0.992, best bad 0.500. A MILDLY upscaled rung (the live 100x100-into-151px defect) measures
 * ~0.726 — deliberately ABOVE this floor: mild upscales are the no-upscaling bar's catch
 * (mediaAsserts.ts assertion (a)), while this metric exists for the severe stand-in that
 * geometry alone cannot see. Chosen threshold:
 */
export const MIN_ACCEPTABLE_SSIM = 0.70;

const SSIM_WINDOW = 8;
const SSIM_STRIDE = 4;
const C1 = 6.5025; // (0.01 * 255)^2
const C2 = 58.5225; // (0.03 * 255)^2
const TEXTURE_VARIANCE_FLOOR = 36; // reference window stddev >= 6 luma levels
const MIN_TEXTURED_WINDOWS = 16;

export type GrayBitmap = {
  width: number,
  height: number,
  luma: Float64Array
};

export type SsimResult = {
  /** Mean per-window SSIM over the reference's textured windows (all windows as fallback). */
  ssim: number,
  ssimAllWindows: number,
  texturedWindows: number,
  totalWindows: number
};


export function decodePngBase64ToGray(base64: string): GrayBitmap {
  const png = PNG.sync.read(Buffer.from(base64, 'base64'));
  const luma = new Float64Array(png.width * png.height);
  for(let i = 0; i < luma.length; ++i) {
    const offset = i * 4;
    luma[i] = 0.299 * png.data[offset] + 0.587 * png.data[offset + 1] + 0.114 * png.data[offset + 2];
  }

  return {width: png.width, height: png.height, luma};
}


export function ssimAgainstReference(rendered: GrayBitmap, reference: GrayBitmap): SsimResult {
  if(rendered.width !== reference.width || rendered.height !== reference.height) {
    throw new Error(
      `ssim called on mismatched bitmaps (${rendered.width}x${rendered.height} vs ` +
      `${reference.width}x${reference.height}) — the page capture must rasterize both sides to the same box`
    );
  }

  const {width, height} = rendered;
  const windowSums: {ssim: number, referenceVariance: number}[] = [];

  for(let y = 0; y + SSIM_WINDOW <= height; y += SSIM_STRIDE) {
    for(let x = 0; x + SSIM_WINDOW <= width; x += SSIM_STRIDE) {
      let sumA = 0;
      let sumB = 0;
      let sumAA = 0;
      let sumBB = 0;
      let sumAB = 0;

      for(let wy = 0; wy < SSIM_WINDOW; ++wy) {
        const row = (y + wy) * width + x;
        for(let wx = 0; wx < SSIM_WINDOW; ++wx) {
          const a = rendered.luma[row + wx];
          const b = reference.luma[row + wx];
          sumA += a;
          sumB += b;
          sumAA += a * a;
          sumBB += b * b;
          sumAB += a * b;
        }
      }

      const n = SSIM_WINDOW * SSIM_WINDOW;
      const meanA = sumA / n;
      const meanB = sumB / n;
      const varianceA = Math.max(0, sumAA / n - meanA * meanA);
      const varianceB = Math.max(0, sumBB / n - meanB * meanB);
      const covariance = sumAB / n - meanA * meanB;

      const ssim =
        ((2 * meanA * meanB + C1) * (2 * covariance + C2)) /
        ((meanA * meanA + meanB * meanB + C1) * (varianceA + varianceB + C2));

      windowSums.push({ssim, referenceVariance: varianceB});
    }
  }

  if(windowSums.length === 0) {
    throw new Error('ssim called on a bitmap smaller than one 8x8 window — the captured box is degenerate');
  }

  const textured = windowSums.filter((entry) => entry.referenceVariance >= TEXTURE_VARIANCE_FLOOR);
  const chosen = textured.length >= MIN_TEXTURED_WINDOWS ? textured : windowSums;

  const mean = (entries: typeof windowSums) => entries.reduce((sum, entry) => sum + entry.ssim, 0) / entries.length;

  return {
    ssim: mean(chosen),
    ssimAllWindows: mean(windowSums),
    texturedWindows: textured.length,
    totalWindows: windowSums.length
  };
}


/**
 * Best SSIM of the rendered bitmap against any of the reference frames. A video preview is a
 * faithful render if it matches SOME real frame of the uploaded source (poster pipelines are
 * free to pick their frame); a blurred stand-in matches none of them.
 */
export function bestSsimAgainstReferences(
  rendered: GrayBitmap,
  references: GrayBitmap[]
): {result: SsimResult, referenceIndex: number} {
  if(references.length === 0) {
    throw new Error('bestSsimAgainstReferences called with zero reference frames');
  }

  let best: SsimResult;
  let bestIndex = 0;
  for(let i = 0; i < references.length; ++i) {
    const result = ssimAgainstReference(rendered, references[i]);
    if(!best || result.ssim > best.ssim) {
      best = result;
      bestIndex = i;
    }
  }

  return {result: best, referenceIndex: bestIndex};
}
