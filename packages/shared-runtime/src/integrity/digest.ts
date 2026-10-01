/**
 * UC-ARCH-006 — THE integrity digest rules, in ONE module.
 *
 * The API seals a record with these rules (evidence completion) and the worker
 * re-derives them (integrity recheck, report gate). They used to be three
 * private copies; a change to one would have made the recheck or the report
 * gate declare correctly sealed evidence FAILED_HASH_MISMATCH. Every caller
 * imports them from here, and a golden-vector test pins them.
 *
 *   - single file:   fileSha256 = sha256(bytes)
 *   - multipart:     fileSha256 = sha256(partSha256[0] + "|" + … ) in partIndex order
 *   - manifest:      multipartManifestSha256 = sha256(partSha256 joined by "\n")
 */
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

/** SHA-256 (lowercase hex) of a stream, read once in bounded chunks. */
export async function sha256HexFromStream(stream: Readable | AsyncIterable<unknown>): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of stream as AsyncIterable<unknown>) {
    hash.update(Buffer.isBuffer(chunk) ? chunk : typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  }
  return hash.digest("hex");
}

/** The multipart composite digest: per-part SHA-256s, in partIndex order, joined by "|". */
export function compositeSha256(partHashesInPartIndexOrder: readonly string[]): string {
  return createHash("sha256").update(partHashesInPartIndexOrder.join("|")).digest("hex");
}

/** The independently reproducible multipart manifest digest (joined by "\n"). */
export function multipartManifestSha256(partHashesInPartIndexOrder: readonly string[]): string {
  return createHash("sha256").update(partHashesInPartIndexOrder.join("\n")).digest("hex");
}

/**
 * The record digest from its parts: one part → that part's digest; more → the
 * composite. Parts are sorted by partIndex here so no caller can pass them in
 * query order by mistake.
 */
export function recordDigestFromParts(parts: ReadonlyArray<{ partIndex: number; sha256: string }>): string {
  const ordered = [...parts].sort((a, b) => a.partIndex - b.partIndex).map((p) => p.sha256);
  if (ordered.length === 0) throw new Error("recordDigestFromParts: no parts");
  return ordered.length === 1 ? ordered[0]! : compositeSha256(ordered);
}
