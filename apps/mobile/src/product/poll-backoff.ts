/**
 * F-P1-15 — how a status poll recovers after failed reads.
 *
 * The server's `pollIntervalMs` is the pace while reads succeed. A failed read
 * (offline, a 5xx, a timeout) used to be retried at that same pace forever
 * (evidence detail) or — when the failed quiet reload left the list unchanged —
 * never again until a manual refresh (reports list). Now each consecutive
 * failure doubles the wait, capped, and the first successful read returns the
 * poll to the server's pace.
 */

/** The longest wait between status reads after repeated failures. */
export const POLL_FAILURE_MAX_DELAY_MS = 60_000;

/** PURE — the wait before the next read, given consecutive failed reads so far. */
export function pollDelayMs(
  serverIntervalMs: number,
  consecutiveFailures: number,
  maxDelayMs: number = POLL_FAILURE_MAX_DELAY_MS,
): number {
  const base = Math.max(1, serverIntervalMs);
  if (!(consecutiveFailures > 0)) return base;
  return Math.min(Math.max(base, maxDelayMs), base * 2 ** Math.min(consecutiveFailures, 16));
}
