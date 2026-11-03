import { sha256 } from "@noble/hashes/sha2.js";

/** Bytes read at a time. Small enough to hold on a phone, large enough to be quick. */
const SLICE_BYTES = 8 * 1024 * 1024;

/**
 * SHA-256 of a file without holding the file in memory (INGEST-002, INGEST-006).
 *
 * Web Crypto digests one buffer, so a large file had to fit in memory whole, and on
 * a phone it failed as an unreadable file or killed the tab. Where that failure
 * was caught, the upload went on with no digest, and the server had nothing to
 * compare the stored object with.
 */
export async function sha256Base64OfBlob(blob: Blob): Promise<string> {
  const hash = sha256.create();
  for (let offset = 0; offset < blob.size; offset += SLICE_BYTES) {
    const slice = await blob.slice(offset, offset + SLICE_BYTES).arrayBuffer();
    hash.update(new Uint8Array(slice));
  }
  let binary = "";
  for (const byte of hash.digest()) binary += String.fromCharCode(byte);
  return btoa(binary);
}
