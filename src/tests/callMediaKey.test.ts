import {describe, expect, it} from 'vitest';
import {CALL_AUTH_KEY_BYTES, callMediaKeyMaterial} from '@lib/calls/livekit/callMediaKey';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte: number) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(text: string): Uint8Array {
  const bytes: Uint8Array = new Uint8Array(text.length / 2);
  for(let i = 0; i < bytes.length; ++i) {
    bytes[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  }

  return bytes;
}

// Every vector below was produced independently in Python (bytes(i % 256 for i in range(256)),
// bytes([0]) + bytes(((i - 1) * 7 + 3) % 256 for i in range(1, 256)), random.Random(20261003).randbytes(256)),
// so the contract is pinned outside this codebase: Android and iOS must hand LiveKit exactly these bytes.
const COUNTING_HEX: string =
    '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f' +
    '404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f' +
    '808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf' +
    'c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff';
const LEFT_PADDED_HEX: string =
    '00030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b9299a0a7aeb5' +
    'bcc3cad1d8dfe6edf4fb020910171e252c333a41484f565d646b727980878e959ca3aab1b8bfc6cdd4dbe2e9f0f7fe050c131a21282f363d444b525960676e75' +
    '7c838a91989fa6adb4bbc2c9d0d7dee5ecf3fa01080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3dae1e8eff6fd040b121920272e35' +
    '3c434a51585f666d747b828990979ea5acb3bac1c8cfd6dde4ebf2f900070e151c232a31383f464d545b626970777e858c939aa1a8afb6bdc4cbd2d9e0e7eef5';
const RANDOM_HEX: string =
    'c9c935079cbf1b9cd67ef8ebe34b4301971dbe5642f00cea3739b624b40c7ad7520e6f7fab73d7494d214b868b875a1b277fc99ef7032063cf301f846ca7554c' +
    'f931060d15e3af04179714aaa811e0791a287260f3f66ef8409ee6ca1b3dc91fd37748a247bc4ce07ac3b3c145048920192de6d360a6a99ee889fa825c1b840e' +
    '2b8fc1acd27ba63966f9a88f43990fd5ff1ab27dce3fd0248339283b8c2ccd4daf7f34575ace04a593c33555a8cc2a099b3e84401f830f2f283d4a82573242e3' +
    '23bbdcb080de1dbf4ac2ee09475fec51cda6ae73b8de265c9f1e1808d8103bdd8da9a830ee3edd15573c37ae0abb6dd34f4bd7526d8b0497d3bc51b303c532c2';
// SHA-256 of COUNTING_HEX's bytes (Python hashlib): the pre-hash recipe this contract replaced
const COUNTING_SHA256_HEX: string = '40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880';

describe('callMediaKey', () => {
  it('is the 256-byte auth key itself, unchanged', () => {
    expect(hex(callMediaKeyMaterial(fromHex(COUNTING_HEX)))).toBe(COUNTING_HEX);
    expect(hex(callMediaKeyMaterial(fromHex(RANDOM_HEX)))).toBe(RANDOM_HEX);
    expect(hex(callMediaKeyMaterial(new Uint8Array(CALL_AUTH_KEY_BYTES)))).toBe('00'.repeat(CALL_AUTH_KEY_BYTES));
    expect(hex(callMediaKeyMaterial(new Uint8Array(CALL_AUTH_KEY_BYTES).fill(255)))).toBe('ff'.repeat(CALL_AUTH_KEY_BYTES));
  });

  it('is not hashed: the 32-byte SHA-256 of the auth key is not what comes out', () => {
    const material: Uint8Array = callMediaKeyMaterial(fromHex(COUNTING_HEX));
    expect(material.byteLength).toBe(CALL_AUTH_KEY_BYTES);
    expect(hex(material)).not.toContain(COUNTING_SHA256_HEX);
  });

  it('keeps the leading zero byte of a left-padded auth key significant', () => {
    const padded: Uint8Array = fromHex(LEFT_PADDED_HEX);
    expect(padded[0]).toBe(0);
    expect(hex(callMediaKeyMaterial(padded))).toBe(LEFT_PADDED_HEX);
    expect(() => callMediaKeyMaterial(padded.subarray(1))).toThrow(/256 bytes, got 255/);
  });

  it('refuses an auth key of any other length, never padding or cutting it', () => {
    expect(() => callMediaKeyMaterial(new Uint8Array(255))).toThrow(/256 bytes, got 255/);
    expect(() => callMediaKeyMaterial(new Uint8Array(257))).toThrow(/256 bytes, got 257/);
    expect(() => callMediaKeyMaterial(new Uint8Array(32))).toThrow(/256 bytes, got 32/);
    expect(() => callMediaKeyMaterial(new Uint8Array(0))).toThrow(/256 bytes, got 0/);
  });

  it('never puts the key bytes in an error message', () => {
    const wrong: Uint8Array = new Uint8Array(100).fill(0xab);
    let message: string = '';
    try {
      callMediaKeyMaterial(wrong);
    } catch(err) {
      message = (err as Error).message;
    }

    expect(message).toContain('100');
    expect(message).not.toContain('abab');
    expect(message).not.toContain('171');
  });

  it('does not depend on the view offset of the input, and is a copy of it', () => {
    const backing: Uint8Array = new Uint8Array(CALL_AUTH_KEY_BYTES + 10).fill(7);
    const view: Uint8Array = backing.subarray(5, 5 + CALL_AUTH_KEY_BYTES);
    const material: Uint8Array = callMediaKeyMaterial(view);
    expect(hex(material)).toBe('07'.repeat(CALL_AUTH_KEY_BYTES));

    view.fill(9);
    expect(hex(material)).toBe('07'.repeat(CALL_AUTH_KEY_BYTES));
    expect(material.buffer.byteLength).toBe(CALL_AUTH_KEY_BYTES);
  });
});
