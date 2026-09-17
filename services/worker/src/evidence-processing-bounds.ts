/**
 * Worker defence-in-depth size backstop for Report / Verification-Package
 * processing.
 *
 * Canonical Evidence completion (`completeEvidence`) is the PRIMARY size authority:
 * it refuses to seal an Evidence whose summed part bytes exceed
 * `MAX_EVIDENCE_SIZE_MB` (default 1 GiB). This module derives its ceiling from that
 * SAME authority (`readMaxEvidenceSizeBytes`, `@proovra/shared`) — it is not an
 * independent or commercial limit.
 *
 * Its job: if malformed, historical or corrupt state ever presents the worker with
 * an Evidence larger than the supported processing bound, FAIL CLOSED with a bounded
 * operational error BEFORE any large buffering / decode / hashing work — never OOM,
 * never crash the worker, never silently truncate, never mutate Evidence truth.
 */
import { readMaxEvidenceSizeBytes } from "@proovra/shared";

export const EVIDENCE_TOO_LARGE_FOR_PROCESSING = "EVIDENCE_TOO_LARGE_FOR_PROCESSING";

/** The total-bytes ceiling the worker will buffer/process for one Evidence. */
export function evidenceProcessingCeilingBytes(): number {
  return readMaxEvidenceSizeBytes();
}

/**
 * PURE: does this Evidence's total byte size exceed the processing ceiling?
 * A non-finite or negative total is treated as NOT exceeding (the caller's other
 * guards handle missing/absent storage); only a real overage trips it.
 */
export function exceedsProcessingCeiling(
  totalBytes: number,
  ceiling: number = evidenceProcessingCeilingBytes(),
): boolean {
  return Number.isFinite(totalBytes) && totalBytes > ceiling;
}

/** PURE: sum the byte sizes of an Evidence's parts (bigint/number/undefined-safe). */
export function sumPartBytes(parts: ReadonlyArray<{ sizeBytes?: bigint | number | null }>): number {
  let total = 0;
  for (const p of parts) total += Number(p.sizeBytes ?? 0);
  return total;
}
