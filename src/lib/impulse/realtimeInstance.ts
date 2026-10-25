import bytesToBase64 from '@helpers/bytes/bytesToBase64';
import fixBase64String from '@helpers/fixBase64String';
import {randomBytes} from '@helpers/random';

// 128 random bits, the least an SDK instance may carry (SDK README.md:372).
const INSTANCE_BYTES: number = 16;

/** A fresh client instance of one update socket: 22 base64url characters, never stored and never logged. */
export function newRealtimeInstance(): string {
  const bytes: Uint8Array = randomBytes(INSTANCE_BYTES);
  return fixBase64String(bytesToBase64(bytes), true);
}
