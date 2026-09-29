import {randomBytes} from 'crypto';
import {readFileSync} from 'fs';
import {join} from 'path';

import {PNG} from 'pngjs';

/*
 * Hostile media fixtures for the B2 lane, handed to the real file chooser as in-memory
 * payloads (exactly what the OS picker would deliver).
 *
 * Photos are STRUCTURED-RANDOM PNGs generated fresh EVERY run. Two requirements meet here:
 *
 *   1. Unique bytes per run defeat any server-side hash dedup — a scenario must never inherit
 *      a previous run's processed document.
 *   2. The fidelity invariant (issue #108, mediaAsserts.ts) compares the painted bitmap
 *      against this very source. Per-pixel noise — the previous fixture — is USELESS for
 *      that: two different resamplers (the server's ladder scaler vs the page's canvas)
 *      produce decorrelated pixels from the same noise, so even a perfect render compares
 *      like garbage. The structured field keeps the randomness at scales that survive an
 *      honest downscale: a smooth random color gradient (unique per run) overlaid with a
 *      luma checkerboard whose cells survive the ladder but are destroyed by the ~40px
 *      stripped thumb — exactly the discriminative detail the perceptual metric needs.
 *
 * The video clip reuses the liveharness recorder capture (a real VP8+Opus WebM test card —
 * color bars, timestamp, moving gradient — the exact shape the client's own recorder
 * produces) as a plain video/webm attachment.
 */
export type MediaPayload = {
  name: string,
  mimeType: string,
  buffer: Buffer
};

const gradientGridWidth = 8;
const gradientGridHeight = 6;
const checkerAmplitude = 24;

const liveharnessFixturesDir = join(__dirname, '..', '..', 'src', 'tests', 'liveharness', 'fixtures');


export function structuredPhoto(name: string, width: number, height: number): MediaPayload {
  const grid = randomBytes(gradientGridWidth * gradientGridHeight * 3);
  const checkerCell = Math.max(8, Math.round(Math.min(width, height) / 30));
  const png = new PNG({width, height});

  const gridAt = (gridX: number, gridY: number, channel: number): number => {
    return grid[(gridY * gradientGridWidth + gridX) * 3 + channel];
  };

  for(let y = 0; y < height; ++y) {
    const gridYF = y / (height - 1) * (gradientGridHeight - 1);
    const gridY = Math.min(gradientGridHeight - 2, Math.floor(gridYF));
    const fy = gridYF - gridY;

    for(let x = 0; x < width; ++x) {
      const gridXF = x / (width - 1) * (gradientGridWidth - 1);
      const gridX = Math.min(gradientGridWidth - 2, Math.floor(gridXF));
      const fx = gridXF - gridX;

      const checker = (Math.floor(x / checkerCell) + Math.floor(y / checkerCell)) % 2 === 0 ?
        checkerAmplitude :
        -checkerAmplitude;

      const offset = (y * width + x) * 4;
      for(let channel = 0; channel < 3; ++channel) {
        const top = gridAt(gridX, gridY, channel) * (1 - fx) + gridAt(gridX + 1, gridY, channel) * fx;
        const bottom = gridAt(gridX, gridY + 1, channel) * (1 - fx) + gridAt(gridX + 1, gridY + 1, channel) * fx;
        const smooth = 32 + (top * (1 - fy) + bottom * fy) * (224 - 32) / 255;
        png.data[offset + channel] = Math.max(0, Math.min(255, Math.round(smooth + checker)));
      }
      png.data[offset + 3] = 255;
    }
  }

  return {
    name,
    mimeType: 'image/png',
    buffer: PNG.sync.write(png)
  };
}


export function recorderWebmVideo(name: string): MediaPayload {
  return {
    name,
    mimeType: 'video/webm',
    buffer: readFileSync(join(liveharnessFixturesDir, 'round-note-vp8-opus.webm'))
  };
}


const archiveSeedBlockBytes = 1024 * 1024;


/**
 * A large, deterministic-within-this-call binary payload for the big-file upload lane (#675
 * follow-up, archive120). Not a real ZIP: nothing on either side of this pipeline parses archive
 * contents for a plain document attachment (traced in the archive120 read-only pass — the
 * finalizer's document branch is byte-agnostic), so a synthesized central directory would add
 * complexity with no test-value. What the scenario actually exercises is the byte pipeline itself
 * — upload.saveBigFilePart chunking, staging, finalization, S3, download — and that only needs
 * bytes whose exact identity this call can name.
 *
 * Same reasoning as structuredPhoto's own randomBytes seed above: UNIQUE per call, so a rerun
 * cannot land on a previously-stored object through server-side hash dedup and quietly skip the
 * real transfer this scenario means to prove. The seed block is expanded by raw Buffer.copy
 * (memcpy), not a byte-by-byte fill, so generating ~120 MiB costs a handful of copies rather than
 * 120 million loop iterations.
 */
export function deterministicArchive(name: string, sizeBytes: number): MediaPayload {
  const seed = randomBytes(Math.min(archiveSeedBlockBytes, sizeBytes));
  const buffer = Buffer.allocUnsafe(sizeBytes);

  let written = 0;
  while(written < sizeBytes) {
    const chunk = Math.min(seed.length, sizeBytes - written);
    seed.copy(buffer, written, 0, chunk);
    written += chunk;
  }

  return {
    name,
    mimeType: 'application/zip',
    buffer
  };
}
