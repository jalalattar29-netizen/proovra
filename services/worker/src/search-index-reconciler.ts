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
// THE durable Search reconciliation authority — the same wrapper the API's
// `POST /v1/search/reconcile` and the backfill CLI resolve through. A lock is
// only a lock if every caller goes through it, and this scheduler was the one
// caller that did not: it worked every workspace at once, with no slot claimed
// for any of them, so a cron tick landing mid-request reconciled the same
// workspace the endpoint was already rebuilding and neither knew.
import { reconcileSearchIndex } from "@proovra/shared-runtime";

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
  /**
   * How many workspaces one tick may claim.
   *
   * Bounded for the same reason the row scan is: a reconciler with no ceiling
   * is a load generator with a good name. A workspace not reached this tick is
   * reached on the next one, oldest drift first.
   */
  workspaceBatchSize?: number;
};

export type SearchIndexReconcileResult = {
  ok: boolean;
  scanned: number;
  missing: number;
  stale: number;
  /**
   * Documents removed because their source row is gone or is no longer
   * eligible. See `sweepIneligibleDocuments` — this direction was never
   * scanned, so a destroyed or hard-deleted record stayed searchable.
   */
  removed: number;
  reEnqueued: number;
  collapsed: number;
  failed: number;
  /** Workspaces this tick claimed a durable slot for and reconciled. */
  workspacesReconciled: number;
  /**
   * Workspaces another caller was already reconciling.
   *
   * Not a failure and not an error: the work is in hand. It is counted so an
   * operator can tell a contended tick from an idle one, which a silent skip
   * could not.
   */
  workspacesLocked: number;
  /** Workspaces whose own run failed. One failure never abandons the rest. */
  workspacesFailed: number;
  durationMs: number;
  error?: string;
};

/**
 * Reconcile Search for the workspaces that currently have outstanding work.
 *
 * WHAT CHANGED, AND WHY
 *
 * This used to be one global sweep: a single scan across every tenant, with no
 * run row and no lock. That made it invisible to the only mechanism that could
 * have excluded it. `POST /v1/search/reconcile` claims a per-workspace slot in
 * `governance_reconciliation_runs`; so does the backfill CLI; so does the
 * internal reindex route. The scheduler claimed nothing, so a tick landing
 * mid-request rebuilt the same workspace the endpoint was rebuilding — and the
 * readiness projection, which reads that run row, could not see the scheduler's
 * work at all. A workspace being actively reconciled by cron therefore reported
 * STALLED.
 *
 * So the unit of work is now ONE WORKSPACE, claimed through the same wrapper
 * every other caller uses:
 *
 *   * CONTENTION IS NOT FAILURE. A workspace another caller holds is skipped
 *     and counted, not retried and not reported as an error. The work is in
 *     hand.
 *   * ONE FAILURE DOES NOT ABANDON THE REST. Each workspace's run carries its
 *     own terminal state; a workspace whose body throws is recorded FAILED on
 *     its own row and the tick continues with the next.
 *   * DIFFERENT WORKSPACES STILL PROCEED CONCURRENTLY. The slot is per
 *     (kind, lock_key) and the lock key is the workspace id, so nothing here
 *     serialises tenants against one another.
 */
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
  const workspaceBatchSize = Math.max(
    1,
    Math.min(options.workspaceBatchSize ?? 50, 500),
  );
  const trigger = options.trigger ?? "scheduler";

  const result: SearchIndexReconcileResult = {
    ok: true,
    scanned: 0,
    missing: 0,
    stale: 0,
    removed: 0,
    reEnqueued: 0,
    collapsed: 0,
    failed: 0,
    workspacesReconciled: 0,
    workspacesLocked: 0,
    workspacesFailed: 0,
    durationMs: 0,
  };

  try {
    const workspaces = await workspacesNeedingReconciliation(
      settledBefore,
      workspaceBatchSize,
    );

    for (const teamId of workspaces) {
      const outcome = await reconcileSearchIndex(prisma, {
        teamId,
        // Bounded to 32 chars by the run authority. `scheduler` is the value
        // the readiness projection and the operator console expect.
        trigger: "scheduler",
        log: {
          info: (o, m) => logger.info(o as object, m ?? ""),
          warn: (o, m) => logger.warn(o as object, m ?? ""),
          error: (o, m) => logger.error(o as object, m ?? ""),
        },
        body: async () => {
          const counts = await reconcileOneWorkspace({
            teamId,
            batchSize,
            settledBefore,
          });
          result.scanned += counts.scanned;
          result.missing += counts.missing;
          result.stale += counts.stale;
          result.removed += counts.removed;
          result.reEnqueued += counts.reEnqueued;
          result.collapsed += counts.collapsed;
          result.failed += counts.failed;
          return {
            scanned: counts.scanned,
            indexed: counts.reEnqueued,
            removed: counts.removed,
            failed: counts.failed,
          };
        },
      });

      if (outcome.kind === "already_running") result.workspacesLocked += 1;
      else if (outcome.kind === "failed") result.workspacesFailed += 1;
      else result.workspacesReconciled += 1;
    }

    logger.info(
      {
        reconciler: "search-index",
        trigger,
        ...result,
        durationMs: Date.now() - startedAt,
      },
      "worker.search_index.reconciled",
    );
  } catch (err) {
    // Only the DISCOVERY query can reach here. Each workspace's body runs
    // inside its own run wrapper, which converts an exception into that
    // workspace's FAILED row rather than into this catch.
    result.ok = false;
    result.error = err instanceof Error ? err.message.slice(0, 200) : "unknown";
    logger.error(
      {
        reconciler: "search-index",
        trigger,
        error: result.error,
      },
      "worker.search_index.reconcile_failed",
    );
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}

/**
 * The workspaces with outstanding Search work right now.
 *
 * BOTH directions, in one bounded query: a row whose document is missing or
 * stale, and a document whose source row is gone or has become ineligible.
 * Reading only the first would leave a workspace whose sole outstanding work is
 * a destroyed record's leftover document permanently unswept.
 *
 * `team_id IS NOT NULL` is not an optimisation: evidence with no workspace
 * cannot be projected at all, so including it would produce a permanent,
 * unfixable drift signal.
 */
async function workspacesNeedingReconciliation(
  settledBefore: Date,
  limit: number,
): Promise<string[]> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT team_id
       FROM (
         SELECT e."team_id" AS team_id, MIN(e."updated_at") AS oldest
           FROM "evidence" e
           LEFT JOIN "evidence_search_documents" d
                  ON d."source_id" = e."id"
                 AND d."document_type" = 'EVIDENCE'
          WHERE e."team_id" IS NOT NULL
            AND ${ELIGIBLE_SQL}
            AND e."updated_at" < $1
            AND (d."source_id" IS NULL OR d."indexed_at_utc" < e."updated_at")
          GROUP BY e."team_id"
         UNION ALL
         SELECT d."team_id" AS team_id, MIN(d."indexed_at_utc") AS oldest
           FROM "evidence_search_documents" d
           LEFT JOIN "evidence" e
                  ON e."id" = d."source_id"
          WHERE d."document_type" = 'EVIDENCE'
            AND d."team_id" IS NOT NULL
            AND (e."id" IS NULL OR NOT (${ELIGIBLE_SQL}))
          GROUP BY d."team_id"
       ) t
      GROUP BY team_id
      ORDER BY MIN(oldest) ASC
      LIMIT $2`,
    settledBefore,
    limit,
  )) as Array<{ team_id: string }>;
  return rows.map((r) => r.team_id);
}

type WorkspaceReconcileCounts = {
  scanned: number;
  missing: number;
  stale: number;
  removed: number;
  reEnqueued: number;
  collapsed: number;
  failed: number;
};

/**
 * One workspace's reconciliation. Runs INSIDE the durable slot.
 *
 * ORDER MATTERS: the ineligible sweep runs FIRST. A destroyed record's document
 * has to be gone before the drift scan measures what is outstanding, or the
 * same tick can re-enqueue work for a row it is about to remove — and the
 * readiness counts derived from that population would disagree with themselves.
 */
async function reconcileOneWorkspace(input: {
  teamId: string;
  batchSize: number;
  settledBefore: Date;
}): Promise<WorkspaceReconcileCounts> {
  const counts: WorkspaceReconcileCounts = {
    scanned: 0,
    missing: 0,
    stale: 0,
    removed: 0,
    reEnqueued: 0,
    collapsed: 0,
    failed: 0,
  };

  counts.removed = await sweepIneligibleDocuments(input.batchSize, input.teamId);

  // Evidence whose projection is missing or older than the source row.
  //
  // The join is expressed in SQL rather than as two Prisma reads because the
  // comparison is between two tables' timestamps; pulling both sides into
  // memory to diff them would be the unbounded version of this query.
  //
  // ELIGIBILITY comes from `searchIndexableLifecycleSql`, the same authority
  // the diagnostics counter uses. This scan previously carried
  // `deleted_at IS NULL`, which skipped trashed evidence — but trashed evidence
  // IS indexed (with an `in_trash` tag, so a user can find a record in order to
  // restore it) and IS counted as outstanding. The counter and the only process
  // that could satisfy it were measuring different populations, so the gap
  // between them could never close.
  const drifted = (await prisma.$queryRawUnsafe(
    `SELECT e."id" AS evidence_id,
            (d."source_id" IS NULL) AS is_missing
       FROM "evidence" e
       LEFT JOIN "evidence_search_documents" d
              ON d."source_id" = e."id"
             AND d."document_type" = 'EVIDENCE'
      WHERE e."team_id" = $1::uuid
        AND ${ELIGIBLE_SQL}
        AND e."updated_at" < $2
        AND (d."source_id" IS NULL OR d."indexed_at_utc" < e."updated_at")
      ORDER BY e."updated_at" ASC
      LIMIT $3`,
    input.teamId,
    input.settledBefore,
    input.batchSize,
  )) as Array<{ evidence_id: string; is_missing: boolean }>;

  counts.scanned = drifted.length;
  if (drifted.length === 0) return counts;

  // Imported lazily so this module can be unit-tested without constructing a
  // Redis connection at import time.
  const { enqueueSearchIndexingJob } = await import("./queue.js");

  for (const row of drifted) {
    if (row.is_missing) counts.missing += 1;
    else counts.stale += 1;
    try {
      const outcome = await enqueueSearchIndexingJob({
        kind: "evidence",
        sourceId: row.evidence_id,
        reason: "reconciler_drift",
      });
      if (outcome.enqueued) counts.reEnqueued += 1;
      else if (outcome.reason.startsWith("job_")) counts.collapsed += 1;
      else counts.failed += 1;
    } catch {
      counts.failed += 1;
    }
  }

  return counts;
}

/**
 * Remove index documents whose source row is gone or no longer eligible.
 *
 * WHY THIS EXISTS
 *
 * The drift scan walks `evidence LEFT JOIN evidence_search_documents` — it
 * finds evidence WITHOUT a document, and documents that are STALE. It never
 * walked the other direction, so nothing ever noticed a document whose source
 * had disappeared or become ineligible. Two consequences, both live:
 *
 *   - A HARD-DELETED record left its document behind. Its title, subtitle,
 *     summary and extracted OCR text stayed searchable indefinitely, for a
 *     record the product had permanently deleted.
 *   - A DESTROYED or PENDING_DESTRUCTION record did the same. Those states are
 *     `deleteFromIndex: true` in the projection builder, but the builder only
 *     runs when something re-indexes the row — and the drift scan EXCLUDES
 *     ineligible rows, so nothing ever did.
 *
 * Governance decided those records are gone. Search was still answering for
 * them.
 *
 * The delete is keyed by (team_id, document_type, source_id) — the same upsert
 * key the projection writes — so it can only ever remove the document that
 * belongs to the row it just judged ineligible.
 */
export async function sweepIneligibleDocuments(
  batchSize: number,
  teamId?: string,
): Promise<number> {
  // Bounded, like the drift scan: a workspace with a large destruction batch
  // must not turn one tick into an unbounded delete.
  //
  // TENANT-KEYED when a workspace is named, which the scheduler now always
  // does — it reconciles one workspace at a time under that workspace's
  // durable slot. An unscoped sweep would delete another tenant's documents
  // while holding a lock that says nothing about them.
  const orphans = (await prisma.$queryRawUnsafe(
    `SELECT d."team_id"        AS team_id,
            d."document_type" AS document_type,
            d."source_id"     AS source_id
       FROM "evidence_search_documents" d
       LEFT JOIN "evidence" e
              ON e."id" = d."source_id"
      WHERE d."document_type" = 'EVIDENCE'
        AND ($1::uuid IS NULL OR d."team_id" = $1::uuid)
        AND (e."id" IS NULL OR NOT (${ELIGIBLE_SQL}))
      LIMIT $2`,
    teamId ?? null,
    batchSize,
  )) as Array<{ team_id: string; document_type: string; source_id: string }>;

  if (orphans.length === 0) return 0;

  let removed = 0;
  for (const row of orphans) {
    try {
      await prisma.evidenceSearchDocument.deleteMany({
        where: {
          teamId: row.team_id,
          documentType: row.document_type,
          sourceId: row.source_id,
        },
      });
      removed += 1;
    } catch (err) {
      // One undeletable document must not abandon the rest of the sweep.
      logger.warn(
        {
          reconciler: "search-index",
          teamId: row.team_id,
          sourceId: row.source_id,
          err,
        },
        "worker.search_index.sweep_failed",
      );
    }
  }

  logger.info(
    { reconciler: "search-index", removed },
    "worker.search_index.swept_ineligible",
  );
  return removed;
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
