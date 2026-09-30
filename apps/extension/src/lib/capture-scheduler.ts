/**
 * UC-EXT-003 — pacing for `chrome.tabs.captureVisibleTab`.
 *
 * Chrome allows at most `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` (2) calls per
 * second; a third call inside the window REJECTS with a quota error. The
 * full-page loop used to pace tiles only for lazy-load settling (250 ms plus
 * capture time), so the third tile of any page taller than two viewports hit
 * the quota and the whole capture was discarded.
 *
 * This module is PURE (clock and sleep are injected) so the pacing is unit
 * tested without a browser:
 *   - `createCaptureScheduler` guarantees a minimum interval between the START
 *     of consecutive calls (>= 550 ms keeps us under 2/s with margin);
 *   - `withQuotaRetry` retries ONLY the quota error, with bounded exponential
 *     backoff, and rethrows everything else at once.
 * A tile that still fails after the bounded retries is the caller's to record as
 * CAPTURE_INTERRUPTED — never a silent success.
 */

export type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Chrome's documented quota is 2 calls/second; 550 ms keeps a safety margin. */
export const MIN_CAPTURE_INTERVAL_MS = 550;

export type CaptureScheduler = {
  /** Run `fn` no sooner than `minIntervalMs` after the previous call started. */
  schedule<T>(fn: () => Promise<T>): Promise<T>;
};

export function createCaptureScheduler(opts: { minIntervalMs?: number; clock?: Clock } = {}): CaptureScheduler {
  const minIntervalMs = Math.max(MIN_CAPTURE_INTERVAL_MS, opts.minIntervalMs ?? MIN_CAPTURE_INTERVAL_MS);
  const clock = opts.clock ?? realClock;
  let lastStart: number | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  return {
    schedule<T>(fn: () => Promise<T>): Promise<T> {
      const run = async (): Promise<T> => {
        if (lastStart !== null) {
          const wait = lastStart + minIntervalMs - clock.now();
          if (wait > 0) await clock.sleep(wait);
        }
        lastStart = clock.now();
        return fn();
      };
      // Serialise: a second caller waits for the first call to START and finish,
      // so two loops can never interleave captures.
      const next = chain.then(run, run);
      chain = next.catch(() => undefined);
      return next;
    },
  };
}

/** True for Chrome's captureVisibleTab rate-quota rejection. */
export function isCaptureQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(msg);
}

export async function withQuotaRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseDelayMs?: number; clock?: Clock } = {},
): Promise<T> {
  const retries = Math.max(0, Math.min(6, opts.retries ?? 4));
  const base = Math.max(MIN_CAPTURE_INTERVAL_MS, opts.baseDelayMs ?? 600);
  const clock = opts.clock ?? realClock;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!isCaptureQuotaError(err) || attempt >= retries) throw err;
      // Bounded exponential backoff: 600, 1200, 2400, 4800 ms (capped at 5 s).
      await clock.sleep(Math.min(5000, base * 2 ** attempt));
      attempt += 1;
    }
  }
}
