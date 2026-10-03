/** Length of the call's Diffie-Hellman auth key: the shared secret, left-padded with zeros to 256 bytes. */
export const CALL_AUTH_KEY_BYTES = 256;


/**
 * The 1:1 call media-encryption key material. This is a cross-client contract: every client that joins a
 * 1:1 LiveKit call must reproduce it bit for bit, or the two sides cannot decrypt each other's media.
 *
 * RECIPE
 *   1. `authKey` is the call's shared secret g_ab = g_b^a mod p (or g_a^b mod p), big-endian, left-padded
 *      with zero bytes to exactly 256 bytes: exactly what the DH computation (`computeKey`) returns. It is
 *      the same value the `key_fingerprint` check and the emoji fingerprint are built from.
 *   2. The key material IS the auth key: all 256 bytes, unchanged. There is NO hash, no salt, no label, no
 *      prefix, and no truncation. A leading zero byte of the padded key is significant.
 *   3. The material is handed to LiveKit's `ExternalE2EEKeyProvider.setKey(...)` as RAW BYTES (an
 *      ArrayBuffer), which makes LiveKit import it as HKDF input key material and derive the frame key from
 *      it. It is NOT a passphrase: do not encode it as hex/base64 and do not pass a string (a string selects
 *      LiveKit's PBKDF2 path, which derives a different frame key). The provider is the shared-key kind, key
 *      index 0, with LiveKit's default ratchet salt "LKFrameEncryptionKey", 128-bit AES-GCM frame keys and
 *      no ratcheting.
 *   4. Encryption is enabled for the whole connection before any track is published.
 *
 * Any other length is a bug upstream and is refused, never padded or cut. The result is a copy, so neither
 * the caller's later writes nor a view offset of the input can change what LiveKit imports.
 *
 * The key material is a secret: it is never logged, put in a diagnostic, an error message or a telemetry
 * tag. Errors here carry lengths only.
 */
export function callMediaKeyMaterial(authKey: Uint8Array): Uint8Array {
  if(authKey.byteLength !== CALL_AUTH_KEY_BYTES) {
    throw new Error(`The call auth key must be ${CALL_AUTH_KEY_BYTES} bytes, got ${authKey.byteLength}`);
  }

  return new Uint8Array(authKey);
}
