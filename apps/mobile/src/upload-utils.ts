/**
 * NATIVE FILE INTEGRITY + UPLOAD.
 *
 * This module computes the digests the capture pipeline declares to the server
 * and then PUTs the bytes to storage. It is on the critical path of EVERY
 * native capture — photo, video, audio, document, ReplayKit segments,
 * MediaProjection segments and continuity manifests.
 *
 * WHY THIS WAS REWRITTEN
 *
 * It previously called `globalThis.crypto.subtle.digest`. React Native has no
 * Web Crypto SubtleCrypto and no polyfill was installed, so `ensureWebCrypto()`
 * threw on every device run and NO native capture of any kind could ever be
 * sealed. `expo-crypto` was already a dependency but was never imported, and its
 * `subtle` usage exists only in its `.web` build. Node has `crypto.subtle`, so
 * the test suite could not see it.
 *
 * It also hand-rolled MD5 (a second implementation of a canonical digest) and
 * read the whole file into a base64 STRING, decoded that into a Uint8Array, then
 * COPIED it into a fresh ArrayBuffer — roughly 3.3x the file size resident in JS
 * at once, which is a latent OOM on a long video.
 *
 * WHAT IT DOES NOW
 *
 *   SHA-256  expo-crypto `digest()` — the platform's own native implementation
 *            (CommonCrypto on iOS, MessageDigest on Android). Same bytes, same
 *            digest; the server re-hashes what storage holds and refuses the
 *            record on mismatch, so this is a claim the server independently
 *            checks — that contract is unchanged.
 *   MD5      expo-file-system `getInfoAsync(uri, { md5: true })` — computed
 *            NATIVELY over the file, never in JS. The hand-rolled MD5 is gone.
 *   READ     chunked `readAsStringAsync({ position, length })` decoded straight
 *            into one pre-allocated buffer of the exact file size, so peak JS
 *            memory is ~1x the file plus one chunk instead of ~3.3x.
 *
 * REMAINING LIMIT (honest): expo-crypto exposes no INCREMENTAL digest, so the
 * whole file must still be resident once to hash it. Chunked hashing needs a
 * native streaming digest and is tracked as such — it is not claimed here.
 */
import * as FileSystem from "expo-file-system";
import * as Crypto from "expo-crypto";

/** Bytes read per chunk when assembling the file for hashing (3 MiB, base64-aligned). */
const READ_CHUNK_BYTES = 3 * 1024 * 1024;

function cachePath(prefix: string) {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${FileSystem.cacheDirectory ?? ""}${prefix}-${stamp}`;
}

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const B64_LOOKUP = (() => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64_CHARS.length; i += 1) t[B64_CHARS.charCodeAt(i)] = i;
  return t;
})();

/** Base64-encode bytes without `globalThis.btoa` (not guaranteed on Hermes). */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + B64_CHARS[(n >> 6) & 63] + B64_CHARS[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + "==";
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + B64_CHARS[(n >> 6) & 63] + "=";
  }
  return out;
}

/**
 * Decode base64 DIRECTLY into `out` at `offset`, returning the bytes written.
 * Writing into a caller-owned buffer is what keeps peak memory at ~1x the file:
 * no intermediate array per chunk, no final copy.
 */
export function decodeBase64Into(base64: string, out: Uint8Array, offset: number): number {
  let written = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < base64.length; i += 1) {
    const code = base64.charCodeAt(i);
    if (code === 61 /* = */) break;
    const v = B64_LOOKUP[code];
    if (v < 0) continue; // skip whitespace/newlines the platform may insert
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[offset + written] = (acc >> bits) & 0xff;
      written += 1;
    }
  }
  return written;
}

/** Hex-encode a digest without depending on any web global. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

/** Hex → base64, for the MD5 the platform hands back as hex. */
export function hexToBase64(hex: string): string {
  const clean = hex.trim().toLowerCase();
  if (clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean)) {
    throw new Error("Invalid hex digest from the platform");
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  return bytesToBase64(bytes);
}

/** A content:// or ph:// reference must be materialised before it can be read. */
export async function ensureFileUri(uri: string) {
  if (uri.startsWith("content://") || uri.startsWith("ph://")) {
    const target = cachePath("proovra-upload");
    await FileSystem.copyAsync({ from: uri, to: target });
    return target;
  }
  return uri;
}

/**
 * Read the whole file into ONE exact-size buffer, a chunk at a time. `position`
 * and `length` are only honoured for base64 reads, which is why the encoding is
 * fixed here. Chunk boundaries are multiples of 3 bytes so each chunk encodes
 * without padding and decodes to a whole number of bytes.
 */
async function readFileBytes(fileUri: string, sizeBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  // Allocate the backing ArrayBuffer explicitly: `new Uint8Array(n)` widens to
  // ArrayBufferLike, which is not assignable to expo-crypto's BufferSource.
  const out = new Uint8Array(new ArrayBuffer(sizeBytes));
  if (sizeBytes === 0) return out;

  let offset = 0;
  while (offset < sizeBytes) {
    const length = Math.min(READ_CHUNK_BYTES, sizeBytes - offset);
    const chunk = await FileSystem.readAsStringAsync(fileUri, {
      encoding: FileSystem.EncodingType.Base64,
      position: offset,
      length,
    });
    const written = decodeBase64Into(chunk, out, offset);
    if (written === 0) {
      throw new Error("Could not read the capture file — the platform returned no bytes.");
    }
    offset += written;
  }
  if (offset !== sizeBytes) {
    // A short read means the declared digest would not describe the file the
    // server will hash. Refuse rather than declare something untrue.
    throw new Error("The capture file changed while it was being read.");
  }
  return out;
}

export type FileIntegrity = {
  fileUri: string;
  sizeBytes: number;
  sha256Hex: string;
  checksumSha256Base64: string;
  contentMd5Base64: string;
};

/**
 * Compute the canonical integrity claim for one file: SHA-256 (native digest)
 * and MD5 (native, over the file). Both are returned in the encodings the
 * canonical part-declaration and the storage PUT headers expect, plus the hex
 * form the direct-capture declaration sends — so no caller has to convert, and
 * the old `atob`-based hex conversion is gone.
 */
export async function computeFileIntegrity(uri: string): Promise<FileIntegrity> {
  const fileUri = await ensureFileUri(uri);

  const info = await FileSystem.getInfoAsync(fileUri, { md5: true, size: true });
  if (!info.exists || info.isDirectory) {
    throw new Error("The capture file is no longer available.");
  }
  const sizeBytes = typeof info.size === "number" ? info.size : 0;
  if (!info.md5) {
    throw new Error("The platform did not return a content digest for the capture file.");
  }

  const bytes = await readFileBytes(fileUri, sizeBytes);
  const sha256 = new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes));

  return {
    fileUri,
    sizeBytes,
    sha256Hex: bytesToHex(sha256),
    checksumSha256Base64: bytesToBase64(sha256),
    contentMd5Base64: hexToBase64(info.md5),
  };
}

/**
 * Back-compat name for the canonical sealing clients (screen-capture.ts,
 * continuous-capture.ts, direct-capture.ts) — those are protected engine files
 * and keep calling this. Same contract, plus the hex digest and size.
 */
export const computeFileIntegrityBase64 = computeFileIntegrity;

export async function uploadWithPut(params: {
  putUrl: string;
  uri: string;
  mimeType: string;
  checksumSha256Base64?: string;
  contentMd5Base64?: string;
}) {
  const prepared =
    params.checksumSha256Base64 && params.contentMd5Base64
      ? {
          fileUri: await ensureFileUri(params.uri),
          checksumSha256Base64: params.checksumSha256Base64,
          contentMd5Base64: params.contentMd5Base64,
        }
      : await computeFileIntegrity(params.uri);

  const result = await FileSystem.uploadAsync(params.putUrl, prepared.fileUri, {
    httpMethod: "PUT",
    headers: {
      "content-type": params.mimeType,
      "x-amz-checksum-sha256": prepared.checksumSha256Base64,
      "Content-MD5": prepared.contentMd5Base64,
    },
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
  });

  if (![200, 201, 204].includes(result.status)) {
    throw new Error(`Upload failed (${result.status})`);
  }

  return {
    status: result.status,
    fileUri: prepared.fileUri,
    checksumSha256Base64: prepared.checksumSha256Base64,
    contentMd5Base64: prepared.contentMd5Base64,
  };
}
