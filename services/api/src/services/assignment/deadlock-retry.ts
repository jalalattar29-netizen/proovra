/**
 * Review remediation IR-06 (2026-11-28) — bounded retry of a WHOLE transaction
 * that PostgreSQL aborted to break a lock cycle.
 *
 * The primary fix for the verdict / placement-loss cycle is ONE lock order
 * (review rows before Collaboration Team membership rows; see
 * `lockReviewWorkflowsHeldByTx`). This is the backstop for the one interleaving
 * an order cannot exclude: a review assigned to the member in the instant
 * between the placement-loss transaction's review locks and its membership
 * write. PostgreSQL then aborts one transaction (40P01); it rolled back
 * completely, so running the same callback again is safe and its outcome is
 * the ordinary, explained one (the decision is recorded, or refused as
 * `reviewer_not_eligible`; the review is released). Only lock-cycle and
 * serialization aborts are retried, a bounded number of times; every other
 * error propagates unchanged.
 */

const RETRYABLE_SQLSTATES = new Set(["40P01", "40001"]);

/** True for a transaction PostgreSQL aborted to break a deadlock / serialization conflict. */
export function isRetryableTransactionAbort(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; meta?: { code?: unknown }; message?: unknown; cause?: unknown };
  if (e.code === "P2034") return true;
  if (typeof e.code === "string" && RETRYABLE_SQLSTATES.has(e.code)) return true;
  if (typeof e.meta?.code === "string" && RETRYABLE_SQLSTATES.has(e.meta.code)) return true;
  if (typeof e.message === "string" && /\b40P01\b|deadlock detected/i.test(e.message)) return true;
  return e.cause !== undefined && e.cause !== err ? isRetryableTransactionAbort(e.cause) : false;
}

/** Run `run` (one complete transaction) and repeat it after a lock-cycle abort, at most `attempts` times. */
export async function withDeadlockRetry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await run();
    } catch (err) {
      if (!isRetryableTransactionAbort(err)) throw err;
      last = err;
      // A short, growing pause lets the surviving transaction commit first.
      await new Promise((r) => setTimeout(r, 15 * (i + 1)));
    }
  }
  throw last;
}
