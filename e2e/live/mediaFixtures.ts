import {randomBytes} from 'crypto';
import {readFileSync} from 'fs';
import {join} from 'path';

import {PNG} from 'pngjs';

/*
 * Hostile media fixtures for the B2 lane, handed to the real file chooser as in-memory
 * payloads (exactly what the OS picker would deliver).
 *
 * Photos are random-noise PNGs generated fresh EVERY run: unique bytes defeat any server-side
 * hash dedup (a scenario must never inherit a previous run's processed document), and noise is
 * the worst case for the preview ladder — a degenerate "preview" cannot fake it.
 *
 * The video clip reuses the liveharness recorder capture (a real VP8+Opus WebM — the exact
 * shape the client's own recorder produces) as a plain video/webm attachment.
 */
export type MediaPayload = {
  name: string,
  mimeType: string,
  buffer: Buffer
};

const liveharnessFixturesDir = join(__dirname, '..', '..', 'src', 'tests', 'liveharness', 'fixtures');


export function noisePhoto(name: string, width: number, height: number): MediaPayload {
  const png = new PNG({width, height});
  const noise = randomBytes(width * height * 4);
  noise.copy(png.data);
  // Full opacity — a transparent-noise PNG would be a different (and unintended) edge case.
  for(let i = 3; i < png.data.length; i += 4) {
    png.data[i] = 255;
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
