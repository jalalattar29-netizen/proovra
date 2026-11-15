/**
 * F-P1-08 (Free-user audit of 4d9b78963) — THE storage-PUT retry rule.
 *
 * A capture's bytes go straight to object storage on a presigned URL. Each
 * client used to decide on its own what a failed PUT meant: web legacy retried
 * only 5xx and network errors (and read an XHR `status === 0` as success), web
 * multipart treated 403 as terminal and never honoured Retry-After, the
 * extension retried 408/425/429/5xx without jitter and could not re-presign an
 * expired URL. Native (apps/mobile src/upload-utils.ts `storageRefusal` +
 * src/capture/capture-retry.ts) already had the rule below; this module is that
 * rule, shared by web legacy, web multipart and the extension. The native
 * module stays import-free (its tests load it standalone) and is held to this
 * rule by a parity test.
 *
 *   no HTTP answer   (network error, aborted, timed out, XHR status 0)
 *                    → RETRYABLE. Never success: status 0 is not a 2xx.
 *   2xx              → SUCCESS.
 *   408 425 429 5xx  → RETRYABLE (storage busy or failing), honouring a
 *                      bounded Retry-After.
 *   403              → REPRESIGN: storage refused the URL itself (expired or no
 *                      longer valid); the next attempt asks the API for a fresh
 *                      URL for the same part (the parts route is idempotent).
 *   any other status → TERMINAL: the bytes were refused (digest, length…);
 *                      sending the same bytes again cannot succeed.
 */

export type StoragePutClass = "SUCCESS" | "RETRYABLE" | "REPRESIGN" | "TERMINAL";

/** PURE — what a storage PUT's HTTP status means. null / 0 = no HTTP answer. */
export function classifyStoragePutStatus(status: number | null | undefined): StoragePutClass {
  if (typeof status !== "number" || !Number.isFinite(status) || status <= 0) return "RETRYABLE";
  if (status >= 200 && status < 300) return "SUCCESS";
  if (status === 403) return "REPRESIGN";
  if (status === 408 || status === 425 || status === 429 || status >= 500) return "RETRYABLE";
  return "TERMINAL";
}

export type StoragePutRetryPolicy = {
  /** Total attempts (>= 1), the first included. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** The longest server-requested wait honoured; a longer ask is not retried. */
  maxRetryAfterMs: number;
};

/** The native capture policy (apps/mobile DEFAULT_CAPTURE_RETRY), shared. */
export const STORAGE_PUT_RETRY: StoragePutRetryPolicy = Object.freeze({
  attempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 15_000,
  maxRetryAfterMs: 60_000,
});

/**
 * PURE — a Retry-After header value in ms (delta-seconds or an HTTP date), or
 * null when absent or unreadable.
 */
export function parseRetryAfterMs(value: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - nowMs);
}

/**
 * PURE — the wait before retry `retry` (1-based), or null when the server asked
 * for longer than the policy honours (never retry earlier than asked).
 * Exponential backoff with equal jitter (half fixed, half random), never
 * shorter than a Retry-After the server sent.
 */
export function storagePutRetryDelayMs(
  retry: number,
  retryAfterMs: number | null | undefined,
  random: () => number = Math.random,
  policy: StoragePutRetryPolicy = STORAGE_PUT_RETRY,
): number | null {
  const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, retry - 1));
  const rnd = Math.min(1, Math.max(0, random()));
  const jittered = Math.round(backoff / 2 + (backoff / 2) * rnd);
  if (typeof retryAfterMs !== "number" || !Number.isFinite(retryAfterMs) || retryAfterMs < 0) return jittered;
  if (retryAfterMs > policy.maxRetryAfterMs) return null;
  return Math.max(jittered, retryAfterMs);
}

/** The slowest uplink a whole-file PUT deadline still allows for (~250 KB/s), as native. */
export const STORAGE_PUT_FLOOR_BYTES_PER_SECOND = 250 * 1024;

/** PURE — a whole-file PUT deadline that scales with the file (native putTimeoutMsForSize). */
export function storagePutDeadlineMs(sizeBytes: number | null | undefined, floorMs = 120_000): number {
  const bytes = typeof sizeBytes === "number" && Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : 0;
  return Math.max(floorMs, Math.ceil(bytes / STORAGE_PUT_FLOOR_BYTES_PER_SECOND) * 1000);
}
