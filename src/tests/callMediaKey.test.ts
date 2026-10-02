import {describe, expect, it} from 'vitest';
import {CALL_AUTH_KEY_BYTES, CALL_MEDIA_KEY_BYTES, deriveCallMediaKey} from '@lib/calls/livekit/callMediaKey';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte: number) => byte.toString(16).padStart(2, '0')).join('');
}

// Expected digests were produced independently (Python hashlib.sha256) so the recipe is pinned
// outside this codebase: Android and iOS must reproduce exactly these values.
describe('callMediaKey', () => {
  it('is SHA-256 of the 256-byte auth key, raw, with no salt or label', async() => {
    const counting: Uint8Array = new Uint8Array(CALL_AUTH_KEY_BYTES).map((_, index) => index % 256);
    expect(hex(await deriveCallMediaKey(counting))).toBe('40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880');

    expect(hex(await deriveCallMediaKey(new Uint8Array(CALL_AUTH_KEY_BYTES)))).toBe(
      '5341e6b2646979a70e57653007a1f310169421ec9bdd9f1a5648f75ade005af1'
    );
    expect(hex(await deriveCallMediaKey(new Uint8Array(CALL_AUTH_KEY_BYTES).fill(255)))).toBe(
      '3d6876a0146de8576eb2395a858de1213d1b92c65b779df3a331cfd5a4584546'
    );
  });

  it('keeps the leading zero byte of a left-padded auth key significant', async() => {
    const padded: Uint8Array = new Uint8Array(CALL_AUTH_KEY_BYTES);
    for(let i = 1; i < CALL_AUTH_KEY_BYTES; ++i) {
      padded[i] = ((i - 1) * 7 + 3) % 256;
    }

    expect(hex(await deriveCallMediaKey(padded))).toBe('421946eb127fb1cce1cd283a09efeafa4e631b2793df1a40dd651bf3ae1fe32b');
    const stripped: Uint8Array = new Uint8Array(CALL_AUTH_KEY_BYTES - 1);
    stripped.set(padded.subarray(1));
    await expect(deriveCallMediaKey(stripped)).rejects.toThrow(/256 bytes/);
  });

  it('returns exactly 32 bytes', async() => {
    expect((await deriveCallMediaKey(new Uint8Array(CALL_AUTH_KEY_BYTES))).byteLength).toBe(CALL_MEDIA_KEY_BYTES);
  });

  it('refuses an auth key of the wrong length', async() => {
    await expect(deriveCallMediaKey(new Uint8Array(255))).rejects.toThrow(/256 bytes, got 255/);
    await expect(deriveCallMediaKey(new Uint8Array(257))).rejects.toThrow(/256 bytes, got 257/);
    await expect(deriveCallMediaKey(new Uint8Array(0))).rejects.toThrow(/256 bytes/);
  });

  it('does not depend on the view offset of the input', async() => {
    const backing: Uint8Array = new Uint8Array(CALL_AUTH_KEY_BYTES + 10).fill(7);
    const view: Uint8Array = backing.subarray(5, 5 + CALL_AUTH_KEY_BYTES);
    const copy: Uint8Array = new Uint8Array(CALL_AUTH_KEY_BYTES).fill(7);
    expect(hex(await deriveCallMediaKey(view))).toBe(hex(await deriveCallMediaKey(copy)));
  });
});
