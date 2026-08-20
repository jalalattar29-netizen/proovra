/**
 * PHASE 12 — POINT 5: stranded search/projection reconciler.
 *
 * Projection rebuilds are produced by the api and by the worker, always AFTER
 * the source mutation commits. That ordering is deliberate — a projection job
 * enqueued inside a transaction that then rolls back would rebuild from data
 * that never existed — but it opens a window: the source row is committed, the
 * process dies or Redis is unreachable, and no job is ever scheduled. The
 * projection is silently stale, and nothing notices, because the only evidence
 * of the intent was the enqueue that failed.
 *
 * This reconciler closes that window for the projection family
 * (`RebuildSearchDocument`, `IndexMediaIntelligence`, and the graph/org-health
 * projections, which share the same failure shape). It compares the source row
 * against its projection and re-enqueues where they disagree.
 *
 * Design properties:
 *
 *   * BOUNDED. One tick reads at most `reconcileBatchSize` candidates per kind,
 *     ordered oldest-drift-first. An unbounded reconciler is a load generator
 *     with a good name.
 *
 *   * IDEMPOTENT. It only re-enqueues, and the enqueue is the shared
 *     collapse-or-replace helper, so a tick that overlaps the previous one
 *     schedules nothing new.
 *
 *   * NON-DESTRUCTIVE. It never deletes a projection to make the drift number
 *     go down, and it never writes a projection itself. Convergence is the
 *     processor's job; this only ensures the processor is asked.
 *
 *   * TENANT-DERIVED. Candidates are read from source rows, so every workspace
 *     it acts on came from the database. Nothing here accepts a scope from a
 *     caller.
 */

import { JOB_NAMES, getWorkEntryOrThrow } from "@proovra/shared";
import { searchIndexableLifecycleSql } from "@proovra/shared";

import { prisma } from "./db.js";
import { logger } from "./logger.js";

/**
 * The one eligibility clause, shared with the diagnostics counter.
 *
 * Bound once so the scan and the drift count cannot be given different rules —
 * which is exactly what happened when one of them carried a hand-written
 * `deleted_at IS NULL` and the other did not.
 */
const ELIGIBLE_SQL = searchIndexableLifecycleSql('e."lifecycle_state"');

const ENTRY = getWorkEntryOrThrow(JOB_NAMES.REBUILD_SEARCH_DOCUMENT);

export type SearchIndexReconcileOptions = {
  trigger?: string;
  /** Defaults to the registry's recovery policy. */
  batchSize?: number;
  /**
   * A source row is only considered drifted once it has been settled for this
   * long. Without the grace period the reconciler races the normal path and
   * re-enqueues work that is already in flight.
   */
  gracePeriodMs?: number;
};

export type SearchIndexReconcileResult = {
  ok: boolean;
  scanned: number;
  missing: number;
  stale: number;
  reEnqueued: number;
  collapsed: number;
  failed: number;
  durationMs: number;
  error?: string;
};

export async function runSearchIndexReconciler(
  options: SearchIndexReconcileOptions = {},
): Promise<SearchIndexReconcileResult> {
  const startedAt = Date.now();
  const batchSize = Math.max(
    1,
    Math.min(options.batchSize ?? ENTRY.recovery.reconcileBatchSize, 1000),
  );
  const graceMs = Math.max(
    60_000,
    options.gracePeriodMs ?? ENTRY.recovery.strandedQueuedThresholdMs,
  );
  const settledBefore = new Date(Date.now() - graceMs);

  const result: SearchIndexReconcileResult = {
    ok: true,
    scanned: 0,
    missing: 0,
    stale: 0,
    reEnqueued: 0,
    collapsed: 0,
    failed: 0,
    durationMs: 0,
  };

  try {
    // Evidence whose projection is missing or older than the source row.
    //
    // The join is expressed in SQL rather than as two Prisma reads because the
    // comparison is between two tables' timestamps; pulling both sides into
    // memory to diff them would be the unbounded version of this query.
    //
    // `team_id IS NOT NULL` is not an optimisation: evidence with no workspace
    // cannot be projected (the processor fails closed on exactly that), so
    // including it would produce a permanent, unfixable drift signal.
    //
    // ELIGIBILITY comes from `searchIndexableLifecycleSql`, the same authority
    // the diagnostics counter uses. This scan previously carried
    // `deleted_at IS NULL`, which skipped trashed evidence — but trashed
    // evidence IS indexed (with an `in_trash` tag, so a user can find a record
    // in order to restore it) and IS counted as outstanding. The counter and
    // the only process that could satisfy it were measuring different
    // populations, so the gap between them could never close.
    const drifted = (await prisma.$queryRawUnsafe(
      `SELECT e."id" AS evidence_id,
              (d."source_id" IS NULL) AS is_missing
         FROM "evidence" e
         LEFT JOIN "evidence_search_documents" d
                ON d."source_id" = e."id"
               AND d."document_type" = 'EVIDENCE'
        WHERE e."team_id" IS NOT NULL
          AND ${ELIGIBLE_SQL}
          AND e."updated_at" < $1
          AND (d."source_id" IS NULL OR d."indexed_at_utc" < e."updated_at")
        ORDER BY e."updated_at" ASC
        LIMIT $2`,
      settledBefore,
      batchSize,
    )) as Array<{ evidence_id: string; is_missing: boolean }>;

    result.scanned = drifted.length;

    if (drifted.length === 0) {
      result.durationMs = Date.now() - startedAt;
      return result;
    }

    // Imported lazily so this module can be unit-tested without constructing a
    // Redis connection at import time.
    const { enqueueSearchIndexingJob } = await import("./queue.js");

    for (const row of drifted) {
      if (row.is_missing) result.missing += 1;
      else result.stale += 1;
      try {
        const outcome = await enqueueSearchIndexingJob({
          kind: "evidence",
          sourceId: row.evidence_id,
          reason: "reconciler_drift",
        });
        if (outcome.enqueued) result.reEnqueued += 1;
        else if (outcome.reason.startsWith("job_")) result.collapsed += 1;
        else result.failed += 1;
      } catch {
        result.failed += 1;
      }
    }

    logger.info(
      {
        reconciler: "search-index",
        trigger: options.trigger ?? "scheduler",
        ...result,
        durationMs: Date.now() - startedAt,
      },
      "worker.search_index.reconciled",
    );
  } catch (err) {
    result.ok = false;
    result.error = err instanceof Error ? err.message.slice(0, 200) : "unknown";
    logger.error(
      {
        reconciler: "search-index",
        trigger: options.trigger ?? "scheduler",
        error: result.error,
      },
      "worker.search_index.reconcile_failed",
    );
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}

/**
 * Build a bounded operator projection of current projection drift.
 *
 * Read-only and carries no source content — only counts and the oldest drift
 * age, which is what an operator needs to answer "is indexing keeping up?"
 * without exposing what is being indexed.
 */
export async function getSearchIndexDriftSnapshot(): Promise<{
  driftedCount: number;
  oldestDriftAgeMs: number | null;
}> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS drifted,
            MIN(e."updated_at") AS oldest
       FROM "evidence" e
       LEFT JOIN "evidence_search_documents" d
              ON d."source_id" = e."id"
             AND d."document_type" = 'EVIDENCE'
      WHERE e."team_id" IS NOT NULL
        AND ${ELIGIBLE_SQL}
        AND (d."source_id" IS NULL OR d."indexed_at_utc" < e."updated_at")`,
  )) as Array<{ drifted: number; oldest: Date | null }>;

  const row = rows[0];
  return {
    driftedCount: row?.drifted ?? 0,
    oldestDriftAgeMs: row?.oldest ? Date.now() - row.oldest.getTime() : null,
  };
}
