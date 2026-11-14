/**
 * THE capture upload's time bounds and retry rule (AUD-004 / AUD-005).
 *
 * Every request of the canonical direct-capture upload (declare, presign, PUT,
 * manifest) used to wait forever: `apiFetch` and `FileSystem.uploadAsync` had
 * no timeout, so one stalled request hung the continuous drain loop and a
 * screen staging indefinitely. And every failure was treated alike: a single
 * dropped connection discarded the server session and deleted the only local
 * copy of what the user captured.
 *
 *   withTimeout        — a request that has not settled in time REJECTS with
 *                        code TIMEOUT (its work is aborted where the transport
 *                        allows), so callers can decide instead of hanging.
 *   classifyCaptureError — RETRYABLE (no response, timeout, 408/429/5xx, the
 *                        server's SESSION_BUSY) vs TERMINAL (any other 4xx: a
 *                        validation or state refusal that a retry cannot fix).
 *   retryCapture       — bounded attempts with exponential backoff, only for
 *                        retryable failures; a terminal one is thrown at once.
 *
 * Retrying is safe because the server is idempotent where it matters: a part
 * declaration with the same index and digest returns the existing one (no new
 * custody event), and a part presign for an existing index returns it.
 */

export const CAPTURE_REQUEST_TIMEOUT_MS = 30_000;
export const CAPTURE_PUT_TIMEOUT_MS = 120_000;

/** The slowest uplink a whole-file PUT deadline still allows for (~250 KB/s). */
export const CAPTURE_PUT_FLOOR_BYTES_PER_SECOND = 250 * 1024;

/**
 * PURE — a whole-file PUT deadline that scales with the file (Free audit F-11).
 *
 * A fixed two minutes cannot carry a large camera video or picked file over a
 * phone connection: every ordinary capture used it, so a file that needed more
 * than 120 s of uplink could never be finalized from the phone. The floor stays
 * the default PUT deadline; above it the deadline allows ~250 KB/s. The single
 * file screen recording has always been bounded this way
 * (`singleFilePutTimeoutMs`, which now delegates here).
 */
export function putTimeoutMsForSize(sizeBytes: number | null | undefined, floorMs = CAPTURE_PUT_TIMEOUT_MS): number {
  const bytes = typeof sizeBytes === "number" && Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : 0;
  return Math.max(floorMs, Math.ceil(bytes / CAPTURE_PUT_FLOOR_BYTES_PER_SECOND) * 1000);
}

export type CaptureErrorClass = "RETRYABLE" | "TERMINAL";

type ErrorShape = { statusCode?: unknown; status?: unknown; code?: unknown; name?: unknown };

/** A request that did not settle in time. */
export class CaptureTimeoutError extends Error {
  readonly code = "TIMEOUT";
  constructor(label: string, ms: number) {
    super(`${label} did not respond within ${Math.round(ms / 1000)} s.`);
    this.name = "CaptureTimeoutError";
  }
}

/**
 * Server refusals a later attempt can succeed past (the session lock is held
 * by a seal). STORAGE_URL_REJECTED is storage refusing the presigned URL
 * itself (403: expired or no longer valid) — the next attempt presigns afresh.
 */
const RETRYABLE_CODES = new Set(["TIMEOUT", "SESSION_BUSY", "NETWORK_ERROR", "STORAGE_URL_REJECTED"]);

/**
 * Local conditions no retry can change (the file to upload is gone), and a
 * storage refusal of the bytes themselves (digest or length mismatch).
 */
const TERMINAL_CODES = new Set(["LOCAL_FILE_MISSING", "STORAGE_UPLOAD_REFUSED"]);

/** The local file to upload no longer exists — terminal for that item. */
export function localFileMissingError(what: string): Error & { code: string } {
  return Object.assign(new Error(`${what} is no longer on this device.`), { code: "LOCAL_FILE_MISSING" });
}

/** PURE — retryable vs terminal. Unknown shapes (a dropped connection) are retryable. */
export function classifyCaptureError(err: unknown): CaptureErrorClass {
  const e = (err ?? {}) as ErrorShape;
  const code = typeof e.code === "string" ? e.code : null;
  if (code && TERMINAL_CODES.has(code)) return "TERMINAL";
  if (code && RETRYABLE_CODES.has(code)) return "RETRYABLE";
  if (e.name === "AbortError") return "RETRYABLE";
  const raw = typeof e.statusCode === "number" ? e.statusCode : typeof e.status === "number" ? e.status : null;
  if (raw === null) return "RETRYABLE"; // no HTTP answer at all: transport failure
  if (raw === 408 || raw === 429 || raw >= 500) return "RETRYABLE";
  if (raw >= 400) return "TERMINAL";
  return "RETRYABLE";
}

/**
 * Run `work` with a deadline. On expiry `onTimeout` runs (abort/cancel the
 * transport) and the call rejects with CaptureTimeoutError — even when the
 * underlying transport ignores the abort.
 */
export function withTimeout<T>(
  work: (signal: AbortSignal | undefined) => Promise<T>,
  ms: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        controller?.abort();
        onTimeout?.();
      } catch {
        // Cancelling is best-effort; the timeout still stands.
      }
      reject(new CaptureTimeoutError(label, ms));
    }, ms);
    let pending: Promise<T>;
    try {
      pending = work(controller?.signal);
    } catch (err) {
      pending = Promise.reject(err);
    }
    pending.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export type RetryPolicy = {
  /** Total attempts (>= 1). */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /**
   * The longest server-requested wait (Retry-After) a retry honours. A server
   * asking for longer is not retried early: the failure is thrown, so the
   * person can try again later instead of the app waiting for minutes.
   */
  maxRetryAfterMs?: number;
  /** Injected for tests; real time by default. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests; Math.random by default (jitter). */
  random?: () => number;
  /**
   * Checked before and after every wait: true stops retrying and throws the
   * last failure (the screen was left, the capture was cancelled).
   */
  shouldStop?: () => boolean;
};

export const DEFAULT_CAPTURE_RETRY: RetryPolicy = {
  attempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 15_000,
  maxRetryAfterMs: 60_000,
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** PURE — the backoff before attempt `n` (1-based retry index): base * 2^(n-1), capped. */
export function backoffDelayMs(retry: number, policy: Pick<RetryPolicy, "baseDelayMs" | "maxDelayMs">): number {
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, retry - 1));
}

/**
 * PURE — the wait the server asked for, in ms, or null. Read from the error a
 * refusal produced: `retryAfterMs` (the Retry-After header, set by api.ts) or
 * the `retryAfterSec` the API's 429 bodies carry.
 */
export function retryAfterMsOf(err: unknown): number | null {
  const e = (err ?? {}) as { retryAfterMs?: unknown; body?: { retryAfterSec?: unknown } | null };
  if (typeof e.retryAfterMs === "number" && Number.isFinite(e.retryAfterMs) && e.retryAfterMs >= 0) {
    return e.retryAfterMs;
  }
  const sec = e.body?.retryAfterSec;
  if (typeof sec === "number" && Number.isFinite(sec) && sec >= 0) return sec * 1000;
  return null;
}

/**
 * PURE — the wait before retry `n` after `err`, or null when the server asked
 * for longer than the policy honours (never retry earlier than asked).
 *
 * Exponential backoff with EQUAL JITTER (half fixed, half random), so phones
 * that failed together do not retry in lockstep; never shorter than a
 * Retry-After the server sent.
 */
export function retryDelayMs(
  retry: number,
  policy: Pick<RetryPolicy, "baseDelayMs" | "maxDelayMs" | "maxRetryAfterMs" | "random">,
  err?: unknown,
): number | null {
  const backoff = backoffDelayMs(retry, policy);
  const rnd = Math.min(1, Math.max(0, (policy.random ?? Math.random)()));
  const jittered = Math.round(backoff / 2 + (backoff / 2) * rnd);
  const asked = retryAfterMsOf(err);
  if (asked === null) return jittered;
  const ceiling = policy.maxRetryAfterMs ?? 60_000;
  if (asked > ceiling) return null;
  return Math.max(jittered, asked);
}

/**
 * Bounded retry with jittered exponential backoff that honours Retry-After; a
 * TERMINAL failure is thrown immediately.
 */
export async function retryCapture<T>(work: (attempt: number) => Promise<T>, policy: RetryPolicy = DEFAULT_CAPTURE_RETRY): Promise<T> {
  const attempts = Math.max(1, Math.floor(policy.attempts));
  const sleep = policy.sleep ?? realSleep;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await work(attempt);
    } catch (err) {
      lastErr = err;
      if (classifyCaptureError(err) === "TERMINAL" || attempt === attempts) throw err;
      const wait = retryDelayMs(attempt, policy, err);
      if (wait === null || policy.shouldStop?.()) throw err;
      await sleep(wait);
      if (policy.shouldStop?.()) throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("capture upload failed");
}

/** Server refusals that mean the SESSION is gone (expired, reaped, discarded). */
const SESSION_GONE_CODES = new Set([
  // AUD-0065 — the capture session's window closed (its own code; an older
  // server sent SESSION_EXPIRED, kept for it).
  "CAPTURE_WINDOW_EXPIRED",
  "SESSION_EXPIRED",
  "SESSION_NOT_ACTIVE",
  "SESSION_NOT_FOUND",
  "SESSION_NOT_RESERVED",
  "EVIDENCE_NOT_OPEN",
]);

/** PURE — the server closed the session the upload belongs to. */
export function isSessionGone(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && SESSION_GONE_CODES.has(code);
}
