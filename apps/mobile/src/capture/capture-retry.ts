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
 *                        server's SESSION_BUSY) vs HELD (401, a plan or
 *                        storage refusal, the terms gate (428) or an access
 *                        refusal (403): not retried now, but the captured
 *                        material is still good — nothing is discarded) vs
 *                        TERMINAL (any other 4xx: a validation or state
 *                        refusal that a retry cannot fix).
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

export type CaptureErrorClass = "RETRYABLE" | "HELD" | "TERMINAL";

type ErrorShape = { statusCode?: unknown; status?: unknown; code?: unknown; name?: unknown; sessionEnded?: unknown };

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
 * Local conditions no retry can change (the file to upload is gone), a
 * storage refusal of the bytes themselves (digest or length mismatch), and an
 * accepted presign that carried no upload URL (F-P1-01: asking again returns
 * the same answer).
 */
const TERMINAL_CODES = new Set(["LOCAL_FILE_MISSING", "STORAGE_UPLOAD_REFUSED", "UPLOAD_URL_MISSING"]);

/**
 * C-03 — commercial refusals of the capture (the record-cap family, credits,
 * a lapsed plan, storage). The account cannot take this capture NOW; the
 * frames are still the only copy of what was captured, so they are kept and
 * the refusal is shown — the person can add storage, buy a credit or upgrade
 * and retry. Any 402 is one too (payment or credit required).
 */
const HELD_REFUSAL_CODES = new Set([
  "FREE_LIMIT_REACHED",
  "EVIDENCE_RECORD_LIMIT_REACHED",
  "EVIDENCE_RECORD_MONTHLY_LIMIT_REACHED",
  "PLAN_LAPSED_ALLOWANCE_EXHAUSTED",
  "INSUFFICIENT_EVIDENCE_CREDITS",
  "CREDIT_REQUIRED_NONE_AVAILABLE",
  "SUBSCRIPTION_INACTIVE",
  "STORAGE_LIMIT_REACHED",
]);

export type CaptureHoldReason = "SIGNED_OUT" | "REFUSED" | "LEGAL" | "ACCESS";

/**
 * PURE — why a failure holds the capture (C-03), or null when it does not.
 *
 *   SIGNED_OUT — a 401 that ended the sign-in (api.ts marks it
 *                `sessionEnded` from sessionEndReason, and the app routes the
 *                person to sign in again). The frames are valid:
 *                the person signs in and retries. It used to be TERMINAL, so a
 *                token that expired mid-staging deleted every frame.
 *   REFUSED    — a plan or storage refusal (HELD_REFUSAL_CODES, or 402), or
 *                any other 401 (a fresher sign-in is needed): shown as is.
 *   LEGAL      — B4-F-202: the A1-06 terms gate (428 / LEGAL_REACCEPT_REQUIRED).
 *                api.ts has already opened the acceptance screen; once the
 *                person accepts, Retry upload stages the same frames. It used
 *                to be TERMINAL and deleted every frame.
 *   ACCESS     — B4-F-202: an authorization refusal (403) — the person's role
 *                or access changed between Stop and staging. The frames are
 *                still the only copy; they are kept while access is restored
 *                (or the person discards them). Storage's own 403 on a
 *                presigned URL (STORAGE_URL_REJECTED) stays retryable.
 */
export function captureHoldReason(err: unknown): CaptureHoldReason | null {
  const e = (err ?? {}) as ErrorShape;
  const code = typeof e.code === "string" ? e.code : undefined;
  const raw = typeof e.statusCode === "number" ? e.statusCode : typeof e.status === "number" ? e.status : null;
  // No import here (this module is loaded on its own by tests): the session-end
  // decision is api.ts's, carried on the error.
  if (raw === 401) return typeof e.sessionEnded === "string" ? "SIGNED_OUT" : "REFUSED";
  if (raw === 402) return "REFUSED";
  if (code && HELD_REFUSAL_CODES.has(code)) return "REFUSED";
  if (raw === 428 || code === "LEGAL_REACCEPT_REQUIRED") return "LEGAL";
  if (raw === 403 && !(code && (RETRYABLE_CODES.has(code) || TERMINAL_CODES.has(code)))) return "ACCESS";
  return null;
}

/** The local file to upload no longer exists — terminal for that item. */
export function localFileMissingError(what: string): Error & { code: string } {
  return Object.assign(new Error(`${what} is no longer on this device.`), { code: "LOCAL_FILE_MISSING" });
}

/** PURE — retryable vs held vs terminal. Unknown shapes (a dropped connection) are retryable. */
export function classifyCaptureError(err: unknown): CaptureErrorClass {
  const e = (err ?? {}) as ErrorShape;
  const code = typeof e.code === "string" ? e.code : null;
  if (code && TERMINAL_CODES.has(code)) return "TERMINAL";
  if (captureHoldReason(err)) return "HELD";
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

/**
 * PURE — F-P1-17: what the deadline of a BACKGROUND-session upload does when
 * its timer fires.
 *
 * An iOS background URL session keeps sending while PROOVRA is suspended, but a
 * JS timer does not run then: it fires late, on resume, before the progress the
 * session made meanwhile has been delivered. An absolute deadline therefore
 * cancelled uploads that were still moving. The background deadline is a STALL
 * rule instead:
 *   - never cancel while the app is not in the foreground (the OS owns the
 *     transfer; JS cannot observe it);
 *   - in the foreground, cancel only after `windowMs` with no evidence of life
 *     (upload progress, or the app becoming active — which restarts the window,
 *     so progress queued during suspension can arrive first).
 * Foreground uploads keep the absolute `withTimeout` deadline.
 */
export function backgroundDeadlineVerdict(input: {
  nowMs: number;
  lastEvidenceMs: number;
  windowMs: number;
  appActive: boolean;
}): { cancel: true } | { cancel: false; recheckInMs: number } {
  if (!input.appActive) return { cancel: false, recheckInMs: input.windowMs };
  const quiet = input.nowMs - input.lastEvidenceMs;
  if (quiet < input.windowMs) return { cancel: false, recheckInMs: Math.max(1, input.windowMs - quiet) };
  return { cancel: true };
}

/** The app-lifecycle facts the background deadline reads (AppState in the app; injected in tests). */
export type BackgroundDeadlineEnv = {
  now?: () => number;
  appActive: () => boolean;
  /** Calls `fn` whenever the app becomes active; returns the unsubscribe. */
  onAppActive: (fn: () => void) => () => void;
};

/**
 * F-P1-17 — run a BACKGROUND-session upload under the stall rule above.
 * `work` receives `noteProgress`, to be called on every progress event of the
 * transfer. On a stall `onTimeout` runs (cancel the task) and the call rejects
 * with CaptureTimeoutError, exactly like `withTimeout`.
 */
export function withBackgroundStallDeadline<T>(
  work: (noteProgress: () => void) => Promise<T>,
  windowMs: number,
  label: string,
  env: BackgroundDeadlineEnv,
  onTimeout?: () => void,
): Promise<T> {
  const now = env.now ?? (() => Date.now());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let lastEvidenceMs = now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = env.onAppActive(() => {
      lastEvidenceMs = now();
    });
    const finish = () => {
      settled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
    const arm = (ms: number) => {
      timer = setTimeout(() => {
        if (settled) return;
        const verdict = backgroundDeadlineVerdict({
          nowMs: now(),
          lastEvidenceMs,
          windowMs,
          appActive: env.appActive(),
        });
        if (!verdict.cancel) {
          arm(verdict.recheckInMs);
          return;
        }
        finish();
        try {
          onTimeout?.();
        } catch {
          // Cancelling is best-effort; the timeout still stands.
        }
        reject(new CaptureTimeoutError(label, windowMs));
      }, ms);
    };
    arm(windowMs);
    let pending: Promise<T>;
    try {
      pending = work(() => {
        lastEvidenceMs = now();
      });
    } catch (err) {
      pending = Promise.reject(err);
    }
    pending.then(
      (v) => {
        if (settled) return;
        finish();
        resolve(v);
      },
      (err) => {
        if (settled) return;
        finish();
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
 * TERMINAL or HELD failure is thrown immediately (a retry now cannot pass it).
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
      if (classifyCaptureError(err) !== "RETRYABLE" || attempt === attempts) throw err;
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
