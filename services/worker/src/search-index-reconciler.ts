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
 * This reconciler closes that window for THREE projections, each by comparing
 * a durable source with the projection derived from it and re-enqueueing where
 * they disagree:
 *
 *   * the evidence search document (`RebuildSearchDocument`) — `evidence` vs
 *     `evidence_search_documents`;
 *   * the workspace graph (`ReconcileTeamGraph`) — `evidence` vs
 *     `investigation_graph_nodes`;
 *   * signal-derived search fields (`RefreshGraphSearchProjection`) —
 *     `media_intelligence_signals` vs `evidence_search_documents`.
 *
 * ET-Q-07 (2026-09-30) — this paragraph used to claim the window was closed
 * for "`IndexMediaIntelligence`, and the graph/org-health projections, which
 * share the same failure shape" while the module looked at none of them. The
 * queues with no producer were retired; the two graph projections that remain
 * got the scans that make the claim true. See the note on RECOVERED_WORK_TYPES.
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
import { reconcileSearchIndex, safeFailureCategory } from "@proovra/shared-runtime";

import { prisma } from "./db.js";
import { logger } from "./logger.js";

/**
 * THE WORK THIS MODULE RECOVERS.
 *
 * Declared here so the canonical work registry's `reconciler` field can be
 * checked against the module it names rather than merely against the
 * filesystem. The topology gate proves the two agree in both directions: a
 * registry entry pointing at a module that does not claim its work fails, and
 * a module claiming work no entry assigns it fails.
 *
 * That check exists because the weaker one — "the declared file exists" —
 * passed three false declarations in a row: UPGRADE_OTS and
 * PURGE_DELETED_EVIDENCE both named a module containing no such code, and
 * EMBED_SEMANTIC_CHUNKS named one whose every scan keyed on a table the embed
 * chain never writes. All three resolved to a real file. None of them was true.
 *
 * Keys, not values: the registry addresses work through `JOB_NAMES` /
 * `SWEEP_NAMES`, and a literal string here would be a second spelling of a
 * name the shared authority already owns.
 *
 * ET-Q-07 (2026-09-30) — THIS LIST OVERCLAIMED, AND THE GATE COULD NOT SEE IT.
 *
 * It declared eight work types. This module recovers TWO: it compares an
 * Evidence row with its search document and re-enqueues
 * `enqueueSearchIndexingJob({ kind: "evidence" })`, and it is its own sweep.
 * The other six — `INDEX_MEDIA_INTELLIGENCE`, `RECONCILE_TEAM_GRAPH`,
 * `SYNC_TEAM_GRAPH_DOMAIN`, `SYNC_TEAM_GRAPH_TIMELINE`,
 * `REFRESH_GRAPH_SEARCH_PROJECTION` and `REFRESH_ORG_HEALTH_PROJECTION` — were
 * listed because the registry assigned them here, and the registry assigned
 * them here because this list said so: a declaration check that both sides
 * satisfy by agreeing with each other proves agreement, not recovery. Nothing
 * in this file reads a graph table, an org-health row or a media-intelligence
 * index job.
 *
 * Four of the six were retired as producerless queues. The two that remain
 * are listed again below, and this time the claim is backed by code in this
 * file rather than by the list itself:
 *
 *   * `RECONCILE_TEAM_GRAPH` — `reconcileStrandedGraphProjections` compares
 *     `evidence` with `investigation_graph_nodes` and re-enqueues a rebuild
 *     for each active `Team` (joined through `teams` / `organizations`) whose
 *     graph is missing a finalized record.
 *   * `REFRESH_GRAPH_SEARCH_PROJECTION` — `reconcileStaleSignalProjections`
 *     compares `media_intelligence_signals` with `evidence_search_documents`
 *     and re-enqueues the rebuild that job exists to trigger.
 *
 * The registry gate now checks that a named reconciler's source REFERENCES the
 * authority model of the work it is given, so a name in this list with no code
 * behind it fails the build instead of agreeing with itself.
 */
export const RECOVERED_WORK_TYPES = [
  "REBUILD_SEARCH_DOCUMENT",
  "RECONCILE_TEAM_GRAPH",
  "REFRESH_GRAPH_SEARCH_PROJECTION",
  "SEARCH_INDEX_RECONCILER",
] as const;


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
  /**
   * ET-Q-07 (2026-09-30) — the two projection recoveries that make this module
   * the reconciler for `ReconcileTeamGraph` and `RefreshGraphSearchProjection`
   * in fact rather than by declaration. See {@link reconcileStrandedGraphProjections}
   * and {@link reconcileStaleSignalProjections}.
   */
  graph: ProjectionRecoveryCounts;
  signalProjection: ProjectionRecoveryCounts;
  durationMs: number;
  error?: string;
};

/** What one of the two projection recoveries did this tick. */
export type ProjectionRecoveryCounts = {
  /** Candidates the durable comparison found owing work. */
  owed: number;
  /** New jobs scheduled. */
  reEnqueued: number;
  /** The work was already live; the enqueue joined it. */
  collapsed: number;
  failed: number;
};

const NO_RECOVERY: ProjectionRecoveryCounts = {
  owed: 0,
  reEnqueued: 0,
  collapsed: 0,
  failed: 0,
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
    graph: { ...NO_RECOVERY },
    signalProjection: { ...NO_RECOVERY },
    durationMs: 0,
  };

  // ET-Q-07 (2026-09-30) — the graph and signal-projection recoveries run
  // FIRST and on their own. They are independent of the per-workspace search
  // claims below (they hold no run row and need none: each only re-enqueues
  // through an idempotent canonical producer), so a search discovery failure
  // must not stop them and they must not be able to fail the search sweep.
  // Each helper is fail-isolated and reports what it could not do in `failed`.
  result.graph = await reconcileStrandedGraphProjections({
    settledBefore,
    limit: Math.min(workspaceBatchSize, GRAPH_RECOVERY_MAX_WORKSPACES),
  });
  result.signalProjection = await reconcileStaleSignalProjections({
    settledBefore,
    limit: batchSize,
  });

  try {
    const workspaces = await workspacesNeedingReconciliation(
      settledBefore,
      workspaceBatchSize,
    );

    for (const teamId of workspaces) {
      // ONE WORKSPACE CANNOT ABORT THE SWEEP.
      //
      // The comment on the outer catch used to claim this was already true —
      // "each workspace's body runs inside its own run wrapper, which converts
      // an exception into that workspace's FAILED row rather than into this
      // catch". That is only true of the BODY. The wrapper's own work happens
      // first: it reads for a stale lock and then INSERTs the claim row, and
      // neither of those is inside the body's try. Anything that makes those
      // two statements throw — a dead connection, and specifically a
      // `governance_reconciliation_runs.kind` enum the deployed database does
      // not yet carry — propagates out of `reconcileSearchIndex`, out of this
      // loop, and into the outer catch, ending the entire tick at the FIRST
      // workspace it touched.
      //
      // That is what a code-before-migration deploy produced in production:
      // every tick died on `invalid input value for enum
      // GovernanceReconciliationKind: SEARCH_INDEX` before it could write a
      // single run row, for every workspace, for as long as the
      // incompatibility lasted. "No run has ever been recorded" was not a
      // workspace that had never been visited — it was a workspace whose visit
      // could not be recorded.
      //
      // A claim that cannot be recorded is that workspace's failure and
      // nothing else's. It is counted, logged with a BOUNDED category, and the
      // tick moves to the next workspace.
      let outcome: Awaited<ReturnType<typeof reconcileSearchIndex>>;
      try {
        outcome = await reconcileSearchIndex(prisma, {
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
            // Rebuilds handed to the queue by THIS run. Recorded on the run row
            // so a completed run can say that work is genuinely outstanding
            // rather than leaving readiness to infer it from silence.
            scheduled: counts.reEnqueued + counts.collapsed,
          };
        },
        });
      } catch (err) {
        // The CLAIM failed — the body never ran, so there is no run row that
        // could carry this. Bounded category only: this is logged and counted,
        // never rendered, and it must not carry SQL or a connection string.
        result.workspacesFailed += 1;
        logger.error(
          {
            reconciler: "search-index",
            teamId,
            category: safeFailureCategory(err),
          },
          "worker.search_index.workspace_claim_failed",
        );
        continue;
      }

      if (outcome.kind === "already_running") result.workspacesLocked += 1;
      else if (outcome.kind === "failed") result.workspacesFailed += 1;
      else result.workspacesReconciled += 1;
    }

    // A tick in which no workspace could be claimed AT ALL is an
    // infrastructure fact, not a quiet zero. Reported as not-ok so the caller
    // escalates it rather than logging another cheerful line.
    if (result.workspacesFailed > 0 && result.workspacesReconciled === 0) {
      result.ok = false;
      result.error = "workspace_claims_failed";
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

// ===========================================================================
// ET-Q-07 (2026-09-30) — GRAPH AND SIGNAL-PROJECTION RECOVERY
// ===========================================================================

/** Workspaces one tick may hand a full graph rebuild to. A rebuild is heavy. */
const GRAPH_RECOVERY_MAX_WORKSPACES = 25;

/**
 * Drift older than this is not this sweep's to chase.
 *
 * Both recoveries below are self-draining — a successful rebuild removes the
 * row from the population — so a row that is STILL owed after this long is not
 * a lost enqueue, it is a rebuild that keeps failing. Re-enqueueing it every
 * ten minutes indefinitely would make this sweep the amplifier the retry
 * policy exists to prevent. The next real evidence event for that workspace
 * triggers a full rebuild through the live producers regardless.
 */
const PROJECTION_RECOVERY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Re-enqueue a graph rebuild for every workspace whose graph is missing a
 * record it should hold.
 *
 * THE AUTHORITY, AND WHY THERE IS NO "RECONCILE REQUESTED" ROW
 * ---------------------------------------------------------------------------
 * `ReconcileTeamGraph` is addressed to a `Team` and its producers (evidence
 * completion, the finalization fan-out, `POST /v1/graph/reconcile`) enqueue
 * AFTER the evidence mutation commits, best-effort. No table records that a
 * rebuild was asked for, so a lost enqueue leaves no request to find.
 *
 * What it does leave is a measurable disagreement between two durable tables.
 * `reconcileTeamGraph` materialises one `investigation_graph_nodes` row of
 * kind EVIDENCE for every non-deleted `evidence` row of the workspace. So a
 * finalized record (status SIGNED or REPORTED — the point at which the live
 * path enqueues) with no live EVIDENCE node IS "this workspace's graph is
 * owed a rebuild". That comparison is the authority, in the same way
 * `evidence` vs `evidence_search_documents` is the authority for search.
 *
 * ONLY ACTIVE WORKSPACES. The processor resolves its command through
 * `resolveActiveWorkspace` — the Team must exist and its Organization must be
 * ACTIVE — and completes as a no-op otherwise. A suspended organization's
 * records would therefore stay owed forever and be re-enqueued every tick for
 * nothing, so the same condition is applied here, in the query, by joining
 * `teams` and `organizations`.
 *
 * `team_id IS NOT NULL` for the reason the search scan gives: a record with no
 * workspace cannot be attributed to a graph at all.
 *
 * IDEMPOTENT. The re-enqueue is `enqueueGraphReconcileJob(teamId)`, which
 * names the same registry entry and the same command id (the Team id) as the
 * API producer, so both build `graph-reconcile-<teamId>`: a workspace whose
 * rebuild is already queued or running collapses onto it. The rebuild itself
 * is a natural-key upsert. SELF-DRAINING: a successful rebuild creates the
 * missing node, and the workspace leaves this population.
 *
 * It writes nothing. Convergence is the processor's job.
 */
export async function reconcileStrandedGraphProjections(input: {
  settledBefore: Date;
  limit: number;
}): Promise<ProjectionRecoveryCounts> {
  const counts: ProjectionRecoveryCounts = { ...NO_RECOVERY };
  const limit = Math.max(1, Math.min(input.limit, GRAPH_RECOVERY_MAX_WORKSPACES));
  const notBefore = new Date(Date.now() - PROJECTION_RECOVERY_MAX_AGE_MS);

  let owed: string[];
  try {
    owed = await workspacesOwingGraphReconcile(input.settledBefore, notBefore, limit);
  } catch (err) {
    counts.failed += 1;
    logger.error(
      { reconciler: "search-index", category: safeFailureCategory(err) },
      "worker.search_index.graph_recovery_scan_failed",
    );
    return counts;
  }
  counts.owed = owed.length;
  if (owed.length === 0) return counts;

  const { enqueueGraphReconcileJob } = await import("./queue.js");
  for (const teamId of owed) {
    try {
      const outcome = await enqueueGraphReconcileJob(teamId, {
        reason: "reconciler_drift",
      });
      if (!outcome.enqueued) counts.failed += 1;
      else if (outcome.collapsed) counts.collapsed += 1;
      else counts.reEnqueued += 1;
    } catch {
      counts.failed += 1;
    }
  }
  logger.info(
    { reconciler: "search-index", ...counts },
    "worker.search_index.graph_recovery",
  );
  return counts;
}

/** Active workspaces holding a finalized record with no live EVIDENCE node. */
export async function workspacesOwingGraphReconcile(
  settledBefore: Date,
  notBefore: Date,
  limit: number,
): Promise<string[]> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT e."team_id"::text AS team_id
       FROM "evidence" e
       JOIN "teams" t ON t."id" = e."team_id"
       JOIN "organizations" o ON o."id" = t."organization_id"
      WHERE e."team_id" IS NOT NULL
        AND e."deleted_at" IS NULL
        AND e."status"::text IN ('SIGNED', 'REPORTED')
        AND e."updated_at" < $1
        AND e."updated_at" > $2
        AND o."status"::text = 'ACTIVE'
        AND NOT EXISTS (
              SELECT 1
                FROM "investigation_graph_nodes" n
               WHERE n."team_id" = e."team_id"
                 AND n."node_kind" = 'EVIDENCE'
                 AND n."external_id" = e."id"
                 AND n."stale_at_utc" IS NULL
            )
      GROUP BY e."team_id"
      ORDER BY MIN(e."updated_at") ASC
      LIMIT $3`,
    settledBefore,
    notBefore,
    limit,
  )) as Array<{ team_id: string }>;
  return rows.map((r) => r.team_id);
}

/**
 * Re-enqueue the search rebuild for every record whose signals changed after
 * its search document was last written.
 *
 * WHAT `RefreshGraphSearchProjection` IS, AND WHAT RECOVERING IT MEANS
 * ---------------------------------------------------------------------------
 * That job is a FAN-OUT TRIGGER, not a writer. For one workspace it finds the
 * records whose `media_intelligence_signals` changed in the last hour and
 * enqueues a `RebuildSearchDocument` for each, because the search document
 * caches signal-derived fields. Its only producer is the graph-reconcile
 * processor's `onReconciled` hook, best-effort.
 *
 * Re-enqueueing the trigger would not recover a lost one: the trigger only
 * looks back sixty minutes, and by the time a stranded threshold has passed
 * and a sweep has run, the window it would have covered has closed. So the
 * EFFECT is recovered instead, from the durable fact the trigger itself reads:
 * a signal row whose `updated_at_utc` is later than the record's
 * `evidence_search_documents.indexed_at_utc` is a document that was not
 * rebuilt after its signals changed. No window, no dependence on the trigger
 * having run.
 *
 * Records with NO document are left to the search drift scan, which already
 * owns "missing". Eligibility is `searchIndexableLifecycleSql`, the one
 * authority for which records the index holds.
 *
 * IDEMPOTENT. The rebuild goes through `enqueueSearchIndexingJob` — the same
 * producer the trigger calls — so a record whose rebuild is already queued
 * collapses onto it. SELF-DRAINING: a rebuild advances `indexed_at_utc` past
 * the signal, and the record leaves this population.
 */
export async function reconcileStaleSignalProjections(input: {
  settledBefore: Date;
  limit: number;
}): Promise<ProjectionRecoveryCounts> {
  const counts: ProjectionRecoveryCounts = { ...NO_RECOVERY };
  const limit = Math.max(1, Math.min(input.limit, 1000));
  const notBefore = new Date(Date.now() - PROJECTION_RECOVERY_MAX_AGE_MS);

  let owed: string[];
  try {
    owed = await evidenceWithSignalsNewerThanDocument(
      input.settledBefore,
      notBefore,
      limit,
    );
  } catch (err) {
    counts.failed += 1;
    logger.error(
      { reconciler: "search-index", category: safeFailureCategory(err) },
      "worker.search_index.signal_projection_scan_failed",
    );
    return counts;
  }
  counts.owed = owed.length;
  if (owed.length === 0) return counts;

  const { enqueueSearchIndexingJob } = await import("./queue.js");
  for (const evidenceId of owed) {
    try {
      const outcome = await enqueueSearchIndexingJob({
        kind: "evidence",
        sourceId: evidenceId,
        reason: "reconciler_signal_drift",
      });
      if (!outcome.enqueued) {
        if (outcome.reason.startsWith("job_")) counts.collapsed += 1;
        else counts.failed += 1;
      } else if (outcome.collapsed) counts.collapsed += 1;
      else counts.reEnqueued += 1;
    } catch {
      counts.failed += 1;
    }
  }
  logger.info(
    { reconciler: "search-index", ...counts },
    "worker.search_index.signal_projection_recovery",
  );
  return counts;
}

/** Records whose newest settled signal postdates their search document. */
export async function evidenceWithSignalsNewerThanDocument(
  settledBefore: Date,
  notBefore: Date,
  limit: number,
): Promise<string[]> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT s."evidence_id"::text AS evidence_id
       FROM "media_intelligence_signals" s
       JOIN "evidence" e ON e."id" = s."evidence_id"
       JOIN "evidence_search_documents" d
         ON d."source_id" = e."id"
        AND d."document_type" = 'EVIDENCE'
      WHERE e."team_id" IS NOT NULL
        AND ${ELIGIBLE_SQL}
        AND s."updated_at_utc" < $1
        AND s."updated_at_utc" > $2
        AND d."indexed_at_utc" < s."updated_at_utc"
      GROUP BY s."evidence_id"
      ORDER BY MIN(s."updated_at_utc") ASC
      LIMIT $3`,
    settledBefore,
    notBefore,
    limit,
  )) as Array<{ evidence_id: string }>;
  return rows.map((r) => r.evidence_id);
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
