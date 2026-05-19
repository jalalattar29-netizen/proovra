/**
 * Phase 30.9 — Retry classifier + chunk splitter.
 *
 * Pure helpers, no browser API dependencies. Importable from tests
 * directly. Bounded vocabulary, bounded backoff, bounded chunk size.
 */

import {
  DEFAULT_CHUNK_SIZE_BYTES,
  MAX_CHUNK_SIZE_BYTES,
  MAX_PART_RETRIES,
  MAX_RETRY_BACKOFF_MS,
  MIN_CHUNK_SIZE_BYTES,
  MIN_RETRY_BACKOFF_MS,
  type ClientFailureReason,
} from "./types";

// =============================================================================
// Chunk plan — deterministic, bounded, no full-file buffering
// =============================================================================

/** A single chunk descriptor — offsets only. The orchestrator slices
 *  the File lazily via `file.slice(start, end)` so the browser never
 *  holds more than one chunk per concurrent slot in memory. */
export type ChunkPlan = {
  partIndex: number; // 0-indexed (matches server schema)
  byteStart: number;
  byteEnd: number;   // exclusive
  byteLength: number;
};

/**
 * Build a deterministic chunk plan for a file of `totalBytes`.
 *
 * Hard rules:
 *   * chunkSize is clamped to [MIN_CHUNK_SIZE_BYTES, MAX_CHUNK_SIZE_BYTES].
 *   * S3 requires every part except the LAST to be ≥ 5 MB. We respect
 *     that by enforcing the minimum on chunkSize itself; the last
 *     chunk is allowed to be smaller (it's the remainder).
 *   * The number of parts is capped at 10_000 (S3 hard limit).
 *   * Empty file (totalBytes === 0) yields a single zero-byte part —
 *     the caller decides whether to refuse that case.
 */
export function planChunks(
  totalBytes: number,
  chunkSize: number = DEFAULT_CHUNK_SIZE_BYTES,
): ReadonlyArray<ChunkPlan> {
  if (!Number.isFinite(totalBytes) || totalBytes < 0) {
    throw new Error("planChunks: totalBytes must be a non-negative number");
  }
  const clampedChunk = Math.max(
    MIN_CHUNK_SIZE_BYTES,
    Math.min(MAX_CHUNK_SIZE_BYTES, Math.floor(chunkSize)),
  );
  if (totalBytes === 0) {
    return [{ partIndex: 0, byteStart: 0, byteEnd: 0, byteLength: 0 }];
  }
  const partCount = Math.min(
    10_000,
    Math.max(1, Math.ceil(totalBytes / clampedChunk)),
  );
  // Effective chunk: if we were forced to cap at 10_000 parts, the
  // per-chunk size scales up. Otherwise it stays at clampedChunk.
  const effectiveChunk = Math.max(
    clampedChunk,
    Math.ceil(totalBytes / partCount),
  );
  const plan: ChunkPlan[] = [];
  let cursor = 0;
  for (let i = 0; i < partCount; i++) {
    const byteStart = cursor;
    const byteEnd = i === partCount - 1
      ? totalBytes
      : Math.min(totalBytes, cursor + effectiveChunk);
    plan.push({
      partIndex: i,
      byteStart,
      byteEnd,
      byteLength: byteEnd - byteStart,
    });
    cursor = byteEnd;
  }
  return plan;
}

// =============================================================================
// Retry classifier — pure
// =============================================================================

export type RetryDecision =
  | {
      kind: "retry";
      /** Bounded wait. Caller schedules `setTimeout(waitMs)`. */
      waitMs: number;
      reason: ClientFailureReason;
    }
  | {
      kind: "terminal";
      reason: ClientFailureReason;
    };

/**
 * Classify an error / response status into a bounded retry decision.
 * Pure — no side effects, no fetch, no DOM access.
 *
 * Inputs the caller can supply:
 *   * `status` — HTTP status code, or 0 for network errors.
 *   * `attempt` — 0-based retry attempt count (0 = first try).
 *   * `retryAfterSec` — value parsed from a `Retry-After` header,
 *     if any. Used as the floor on `waitMs`; still capped by
 *     MAX_RETRY_BACKOFF_MS.
 *   * `isOnline` — `navigator.onLine`. When false, every failure
 *     becomes `offline` (retryable but with a long wait so we don't
 *     thrash while the network is down).
 *
 * Bounded reason vocabulary — every return value carries one of
 * `ClientFailureReason`.
 */
export function classifyRetry(input: {
  status: number;
  attempt: number;
  retryAfterSec?: number | null;
  isOnline: boolean;
}): RetryDecision {
  if (input.attempt >= MAX_PART_RETRIES) {
    return { kind: "terminal", reason: "unknown" };
  }
  if (!input.isOnline) {
    return {
      kind: "retry",
      waitMs: MAX_RETRY_BACKOFF_MS,
      reason: "offline",
    };
  }
  // status === 0 → network error / fetch threw / DNS / CORS.
  if (input.status === 0) {
    return {
      kind: "retry",
      waitMs: clampedBackoff(input.attempt, input.retryAfterSec),
      reason: "network_error",
    };
  }
  // 4xx auth / validation — terminal. The orchestrator surfaces
  // this so the operator can fix the upstream issue (e.g. session
  // expired, token revoked).
  if (input.status === 401 || input.status === 403) {
    return { kind: "terminal", reason: "put_4xx" };
  }
  if (input.status === 404) {
    // Could be "session_not_found" or S3 NoSuchKey — either way
    // retrying won't help.
    return { kind: "terminal", reason: "put_4xx" };
  }
  if (input.status === 409) {
    return { kind: "terminal", reason: "conflict" };
  }
  if (input.status === 410) {
    return { kind: "terminal", reason: "session_expired" };
  }
  if (input.status === 422) {
    return { kind: "terminal", reason: "hash_mismatch" };
  }
  if (input.status === 429) {
    return {
      kind: "retry",
      waitMs: clampedBackoff(input.attempt, input.retryAfterSec),
      reason: "rate_limited",
    };
  }
  if (input.status === 503) {
    return {
      kind: "retry",
      waitMs: clampedBackoff(input.attempt, input.retryAfterSec),
      reason: "service_unavailable",
    };
  }
  if (input.status >= 500) {
    return {
      kind: "retry",
      waitMs: clampedBackoff(input.attempt, input.retryAfterSec),
      reason: "put_5xx",
    };
  }
  if (input.status >= 400) {
    return { kind: "terminal", reason: "put_4xx" };
  }
  // Anything else (e.g. 2xx + missing ETag) is treated as retryable
  // by the orchestrator; the caller distinguishes via reason.
  return {
    kind: "retry",
    waitMs: clampedBackoff(input.attempt, input.retryAfterSec),
    reason: "unknown",
  };
}

/**
 * Exponential backoff bounded by [MIN_RETRY_BACKOFF_MS,
 * MAX_RETRY_BACKOFF_MS]. Honors a server-supplied Retry-After (in
 * seconds) as the floor.
 *
 * Formula: 500ms · 2^attempt + random jitter (±20%). Capped at 30s.
 */
function clampedBackoff(
  attempt: number,
  retryAfterSec: number | null | undefined,
): number {
  const exp = MIN_RETRY_BACKOFF_MS * 2 ** Math.max(0, Math.min(attempt, 6));
  const jitter = exp * (0.8 + Math.random() * 0.4);
  const floor =
    retryAfterSec && retryAfterSec > 0
      ? Math.min(retryAfterSec * 1000, MAX_RETRY_BACKOFF_MS)
      : 0;
  return Math.max(
    floor,
    Math.min(MAX_RETRY_BACKOFF_MS, Math.round(jitter)),
  );
}
