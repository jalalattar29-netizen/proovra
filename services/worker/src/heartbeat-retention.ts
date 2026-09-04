/**
 * BOUNDED RETENTION FOR THE HEARTBEAT HISTORY.
 *
 * =============================================================================
 * WHY THE HISTORY STILL EXISTS
 * =============================================================================
 * Every LIVENESS consumer now reads `worker_leases`. The history table is kept
 * because other things read it — the operations dashboard, the trust status
 * probes, the reconcile and telemetry health probes — and dropping a table
 * those surfaces query would be a silent capability change wearing the costume
 * of a cleanup. So it stays, and it is bounded instead.
 *
 * =============================================================================
 * WHY ONE WORKER, NOT EVERY WORKER
 * =============================================================================
 * If every instance swept on its own schedule, a fleet of ten would run ten
 * overlapping DELETEs over the same rows: the same work ten times, ten sets of
 * locks on the same pages, and a thundering herd immediately after any
 * synchronised deploy. A PostgreSQL ADVISORY lock makes exactly one instance
 * the sweeper per tick — `pg_try_advisory_lock` returns false to the others
 * instantly rather than queueing them, so the losers do nothing at all rather
 * than waiting their turn to do redundant work.
 *
 * The lock is session-scoped and explicitly released in `finally`. A worker
 * that dies mid-sweep releases it when its connection closes, so a crash
 * cannot wedge retention permanently — the next tick simply acquires it.
 *
 * =============================================================================
 * WHY BOUNDED BATCHES
 * =============================================================================
 * The first sweep after this ships may face a very large backlog. One
 * unbounded `DELETE WHERE heartbeat_at_utc < cutoff` would take a long
 * transaction and a lot of locks against a table the health probes read on
 * every request. Instead: delete in capped batches, stop after a capped number
 * of batches, and let the next tick continue. The backlog drains over several
 * runs and no single statement is ever large.
 *
 * That also makes the sweep IDEMPOTENT in the way that matters: it is a
 * predicate over age, so running it twice, or interrupting it anywhere, leaves
 * the same end state. There is no cursor to lose.
 */

import { prisma } from "./db.js";
import { logger } from "./logger.js";

/** Default history window. Explicit, and the only place it is decided. */
export const HEARTBEAT_RETENTION_DAYS_DEFAULT = 30;

/** Rows removed per statement. Small enough to stay a short transaction. */
export const RETENTION_BATCH_SIZE = 5_000;

/** Statements per run. Caps the work one tick can do, whatever the backlog. */
export const RETENTION_MAX_BATCHES = 10;

/**
 * A fixed 64-bit key for `pg_try_advisory_lock`. Arbitrary but STABLE — the
 * coordination only works while every instance asks for the same number.
 */
const RETENTION_ADVISORY_LOCK_KEY = 8_140_251_930_014n;

/**
 * The effective retention window, honouring a bounded override.
 *
 * Floor 1 day so a misconfiguration cannot turn the sweep into "delete
 * everything, continuously"; ceiling 365 so it cannot silently become the
 * unbounded growth this replaced.
 */
export function resolveRetentionDays(explicit?: number): number {
  const raw =
    explicit ?? Number(process.env.WORKER_HEARTBEAT_RETENTION_DAYS ?? "");
  if (!Number.isFinite(raw) || raw <= 0) return HEARTBEAT_RETENTION_DAYS_DEFAULT;
  return Math.min(Math.max(Math.round(raw), 1), 365);
}

export type RetentionOutcome = {
  /** False when another instance held the lock. Not a failure. */
  ran: boolean;
  deleted: number;
  batches: number;
  retentionDays: number;
  cutoffUtc: string;
  /** True when the cap stopped us before the backlog was exhausted. */
  moreRemaining: boolean;
};

/**
 * Sweep once, if this instance wins the lock.
 *
 * Never throws: retention failing must not take a worker down, and must not
 * be reported as success either — the outcome says what happened.
 */
export async function sweepHeartbeatHistory(options?: {
  retentionDays?: number;
  batchSize?: number;
  maxBatches?: number;
}): Promise<RetentionOutcome> {
  const retentionDays = resolveRetentionDays(options?.retentionDays);
  const batchSize = Math.min(Math.max(options?.batchSize ?? RETENTION_BATCH_SIZE, 1), 50_000);
  const maxBatches = Math.min(Math.max(options?.maxBatches ?? RETENTION_MAX_BATCHES, 1), 100);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const base: RetentionOutcome = {
    ran: false,
    deleted: 0,
    batches: 0,
    retentionDays,
    cutoffUtc: cutoff.toISOString(),
    moreRemaining: false,
  };

  let holdsLock = false;
  try {
    const got = await prisma.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_lock(${RETENTION_ADVISORY_LOCK_KEY}::bigint) AS locked
    `;
    holdsLock = got[0]?.locked === true;
    if (!holdsLock) {
      // Another instance is sweeping. Doing nothing is the correct outcome,
      // not an error and not a retry.
      logger.debug({ retentionDays }, "worker.heartbeat_retention.skipped_not_lock_holder");
      return base;
    }

    let deleted = 0;
    let batches = 0;
    let lastBatch = 0;
    for (; batches < maxBatches; batches++) {
      // ctid-based batching: pick a bounded set of rows by the retention
      // predicate, then delete exactly those. Keeps every statement small
      // regardless of how far behind the sweep has fallen.
      const removed = await prisma.$executeRaw`
        DELETE FROM worker_telemetry_snapshots
         WHERE ctid IN (
           SELECT ctid FROM worker_telemetry_snapshots
            WHERE heartbeat_at_utc < ${cutoff}
            LIMIT ${batchSize}
         )
      `;
      lastBatch = removed;
      deleted += removed;
      if (removed < batchSize) {
        batches += 1;
        break;
      }
    }

    const moreRemaining = batches >= maxBatches && lastBatch === batchSize;
    if (deleted > 0 || moreRemaining) {
      logger.info(
        {
          deleted,
          batches,
          retentionDays,
          cutoffUtc: cutoff.toISOString(),
          moreRemaining,
        },
        "worker.heartbeat_retention.swept",
      );
    }
    return { ...base, ran: true, deleted, batches, moreRemaining };
  } catch (err) {
    logger.warn({ err }, "worker.heartbeat_retention.failed");
    return base;
  } finally {
    if (holdsLock) {
      await prisma
        .$queryRaw`SELECT pg_advisory_unlock(${RETENTION_ADVISORY_LOCK_KEY}::bigint)`
        .catch(() => {
          // Session-scoped: the lock goes when the connection does, so a
          // failure here cannot wedge retention.
        });
    }
  }
}
