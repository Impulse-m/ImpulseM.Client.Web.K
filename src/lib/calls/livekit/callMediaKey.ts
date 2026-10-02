/** Length of the call's Diffie-Hellman auth key: the shared secret, left-padded with zeros to 256 bytes. */
export const CALL_AUTH_KEY_BYTES = 256;

/** Length of the derived media key: one SHA-256 digest. */
export const CALL_MEDIA_KEY_BYTES = 32;


/**
 * Derives the 1:1 call media-encryption key. This is a cross-client contract: every client that joins a
 * 1:1 LiveKit call must reproduce it bit for bit, or the two sides cannot decrypt each other's media.
 *
 * RECIPE
 *   1. `authKey` is the call's shared secret g_ab = g_b^a mod p (or g_a^b mod p), big-endian, left-padded
 *      with zero bytes to exactly 256 bytes. It is the same value the call's emoji fingerprint and the
 *      `key_fingerprint` check are built from (the `key` returned by the DH computation).
 *   2. `mediaKey = SHA-256(authKey)`: 32 bytes, no salt, no label, no prefix.
 *   3. `mediaKey` is handed to LiveKit's `ExternalE2EEKeyProvider.setKey(...)` as RAW BYTES (an ArrayBuffer),
 *      which makes LiveKit import it as HKDF input key material. It is NOT a passphrase: do not encode it as
 *      hex/base64 and do not pass a string (a string selects LiveKit's PBKDF2 path, which derives a different
 *      frame key). The provider is the shared-key kind, key index 0, with LiveKit's default ratchet salt
 *      "LKFrameEncryptionKey", 128-bit AES-GCM frame keys and no ratcheting.
 *   4. Encryption is enabled for the whole connection before any track is published.
 *
 * Because the emoji fingerprint is derived from the same `authKey`, matching emoji on both screens mean
 * both sides hold the same media key.
 */
export async function deriveCallMediaKey(authKey: Uint8Array): Promise<Uint8Array> {
  if(authKey.byteLength !== CALL_AUTH_KEY_BYTES) {
    throw new Error(`The call auth key must be ${CALL_AUTH_KEY_BYTES} bytes, got ${authKey.byteLength}`);
  }

  const digest: ArrayBuffer = await crypto.subtle.digest('SHA-256', authKey as BufferSource);
  return new Uint8Array(digest);
}
