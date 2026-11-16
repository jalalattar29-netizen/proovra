/**
 * B8-F-005 (free-audit 0ea0) — the dead-letter sinks are BOUNDED.
 *
 * `reportDlqQueue` and `mediaIntelligenceDlqQueue` have no consumer by design
 * (a processor would turn triage into a retry loop), so every entry stayed in
 * `wait` for ever, on a Redis that runs `noeviction`. An entry is only a
 * reference: the durable truth is the FAILED request row and the
 * OperationalIncident the failure opened, which `readDeadLetterSummary`
 * already reads. Entries older than the retention window are therefore
 * trimmed from the waiting / delayed / paused / failed sets by the queue
 * health sampler that already visits both sinks (JOB-0061).
 *
 *   DEAD_LETTER_RETENTION_DAYS  30 (whole number 1..3650; anything else
 *                                    falls back to the default)
 */
export const DEFAULT_DEAD_LETTER_RETENTION_DAYS = 30;
export const DEAD_LETTER_TRIM_LIMIT_PER_STATE = 1_000;

export function deadLetterRetentionMs(raw: string | undefined): number {
  const day = 24 * 60 * 60 * 1000;
  if (raw === undefined || raw.trim() === "") return DEFAULT_DEAD_LETTER_RETENTION_DAYS * day;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 1 && n <= 3650
    ? n * day
    : DEFAULT_DEAD_LETTER_RETENTION_DAYS * day;
}

/** The slice of BullMQ's `Queue` the trim needs (structural, testable without Redis). */
export interface DeadLetterTrimQueue {
  clean(grace: number, limit: number, type?: "wait" | "delayed" | "paused" | "failed" | "completed"): Promise<string[]>;
}

const TRIM_STATES = ["wait", "delayed", "paused", "failed"] as const;

/** Remove DLQ entries older than the retention window; returns how many went. */
export async function trimDeadLetterQueue(
  queue: DeadLetterTrimQueue,
  retentionMs: number = deadLetterRetentionMs(process.env.DEAD_LETTER_RETENTION_DAYS),
): Promise<number> {
  let removed = 0;
  for (const state of TRIM_STATES) {
    const ids = await queue.clean(retentionMs, DEAD_LETTER_TRIM_LIMIT_PER_STATE, state);
    removed += ids.length;
  }
  return removed;
}
