import { md5 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { bytesToBase64, updateHashesFromBlob } from "../../../../lib/uploads/streaming-sha256";

/**
 * The SHA-256 checksum and Content-MD5 a part's presigned PUT is signed with.
 *
 * F-P1-03 (Free-user audit of 4d9b78963) — this read the whole file into one
 * buffer (`blob.arrayBuffer()`) for Web Crypto and a hand-written MD5, for
 * files up to 500 MB: on a phone that failed as an unreadable file or killed
 * the tab. Both digests are now computed in ONE pass over bounded slices (the
 * same slicing as `sha256Base64OfBlob`), so memory stays at one slice whatever
 * the file's size. Same algorithms, same base64 output.
 */
export async function computeIntegrityFromBlob(blob: Blob): Promise<{
  checksumSha256Base64: string;
  contentMd5Base64: string;
}> {
  const sha = sha256.create();
  const md = md5.create();
  await updateHashesFromBlob(blob, [sha, md]);
  return {
    checksumSha256Base64: bytesToBase64(sha.digest()),
    contentMd5Base64: bytesToBase64(md.digest()),
  };
}
