/*
 * Originally from:
 * https://github.com/evgeny-nadymov/telegram-react
 * Copyright (C) 2018 Evgeny Nadymov
 * https://github.com/evgeny-nadymov/telegram-react/blob/master/LICENSE
 */

// NOTE: impulsem returns sign source, while webrtc uses unsign source internally
// unsign => sign
export function toImpulseMSource(source: number) {
  return source << 0;
}

// NOTE: impulsem returns sign source, while webrtc uses unsign source internally
// sign => unsign
export function fromImpulseMSource(source: number) {
  return source >>> 0;
}

// Same bit-op, named for the other intent: canonicalizing an already-unsigned
// (or unknown-provenance) SSRC into the unsigned form every SSRC map is keyed
// by. Use `fromImpulseMSource` when the value is known to come from a ImpulseM
// row, `normalizeSsrc` when keying/looking up a map.
export const normalizeSsrc = fromImpulseMSource;

export function getAmplitude(array: Uint8Array, scale = 3) {
  if(!array) return 0;

  const {length} = array;
  let total = 0;
  for(let i = 0; i < length; ++i) {
    total += array[i] * array[i];
  }
  const rms = Math.sqrt(total / length) / 255;

  return Math.min(1, rms * scale);
}
