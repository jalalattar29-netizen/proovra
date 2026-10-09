/**
 * THE SCHEDULED OPERATIONS SWEEP.
 *
 * WHY IT EXISTS
 * -------------
 * Operations discovery ran ONLY as a lazy side effect of building the Home
 * dashboard. A workspace nobody opened was never scanned, so its Operations
 * page rendered "clear" — not because it was, but because nothing had ever
 * looked. Home was, in effect, the production scheduler, and it only ran for
 * workspaces that happened to have an operator with a browser open.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is not a new job framework, a new lock, or a new state model. Every
 * workspace's run is claimed through `reconcileWorkspaceOperationalConditions`,
 * which is the Operations-shaped face of the ONE reconciliation-run authority.
 * This file only decides WHICH workspaces to offer to that authority and in
 * what order — the properties below are all consequences of the authority, not
 * of anything invented here.
 *
 * THE PROPERTIES THE BRIEF REQUIRES, AND WHERE EACH COMES FROM
 * ------------------------------------------------------------
 *   * bounded workspaces per sweep      — `WORKSPACE_BATCH` here.
 *   * per-workspace isolation           — one try/catch per workspace here;
 *                                         one run row per workspace there.
 *   * per-source isolation              — the discovery body, which records
 *                                         each source's outcome separately.
 *   * one broken workspace cannot abort the rest — the per-workspace catch
 *                                         wraps the CLAIM too, not just the
 *                                         body. That distinction is not
 *                                         theoretical: a database whose enum
 *                                         predates the deploy makes the claim
 *                                         itself throw, and Search's sweep
 *                                         died at its first workspace, every
 *                                         tick, for exactly that reason.
 *   * one broken source cannot fabricate a clear result — its id is absent
 *                                         from `successful`, so readiness is
 *                                         PARTIAL and clear is refused.
 *   * restart-safe continuation         — the cursor is the workspace's own
 *                                         last-run time, read from the durable
 *                                         table, so a restarted process
 *                                         resumes where the DATA says it
 *                                         should rather than from an in-memory
 *                                         offset that died with it.
 *   * deterministic / idempotent identity — the lock key is
 *                                         `WORKSPACE_OPERATIONS:<workspaceId>`,
 *                                         computed by the authority.
 *   * no duplicate incident occurrences — `recordIncident` upserts on
 *                                         (teamId, fingerprint).
 *   * no unlimited fan-out              — batch bound plus sequential
 *                                         execution.
 *   * queue unavailable reported truthfully — this sweep touches no queue; if
 *                                         a future source does, its failure
 *                                         lands in `failedSources` and makes
 *                                         the run PARTIAL.
 */

import { prisma } from "../db.js";
import {
  OPERATIONS_FRESHNESS_WINDOW_MS,
  WORKSPACE_OPERATIONS_RUN_KIND,
  safeOperationsFailureCategory,
} from "@proovra/shared-runtime";

import { reconcileWorkspaceOperations } from "../services/operations/operations-reconciliation.service.js";
import { sweepUnscopedSourceTruthRecoveries } from "../services/operations/source-truth-recovery.service.js";
import { reconcilePlatformConditions } from "../services/operations/platform-conditions.service.js";

/**
 * How many workspaces one tick will touch.
 *
 * Deliberately modest. A sweep that tries to cover every workspace in one tick
 * is a sweep that takes longer than its own interval on a large deployment,
 * and the failure mode there is overlapping ticks rather than a slow one.
 * Workspaces not reached this tick are reached on the next, oldest first.
 */
const WORKSPACE_BATCH = 25;

export type OperationsSweepResult = {
  ok: boolean;
  /** Workspaces this tick claimed and ran. */
  reconciled: number;
  /** Workspaces another caller already held. Contention, not failure. */
  locked: number;
  /** Workspaces whose own run failed. One failure never abandons the rest. */
  failed: number;
  /** Bounded category when the sweep itself could not proceed. */
  error: string | null;
  durationMs: number;
  /**
   * OPS-008 — how many workspaces were due when this tick ranked them (the
   * coverage backlog). A number that does not fall tick over tick says the
   * batch is too small for the deployment.
   */
  due: number;
};

/**
 * Which workspaces most need a look.
 *
 * ORDER IS THE CURSOR. Workspaces are ranked by how long it has been since
 * their last run STARTED, oldest first, with never-run workspaces first of
 * all. That makes the sweep restart-safe without storing an offset anywhere:
 * whatever a crashed process had already done is recorded on the run rows, so
 * the next process naturally picks up what it did not reach.
 *
 * It also makes the sweep self-levelling. A workspace that just ran sorts to
 * the back; a workspace that has never run sorts to the front and is picked up
 * on the very next tick after it is created.
 */
/** Exported for the fairness proof; the sweep below is its only caller. */
export async function workspacesNeedingReconciliation(
  limit: number,
  now: Date,
): Promise<{ ids: string[]; due: number }> {
  const cutoff = new Date(now.getTime() - OPERATIONS_FRESHNESS_WINDOW_MS);

  // OPS-008 — RANKED IN SQL, OVER EVERY WORKSPACE.
  //
  // This used to read `take: limit * 20` teams ordered by creation and rank
  // only those: with more than five hundred workspaces, every workspace
  // created after the five-hundredth was never selected by the scheduler at
  // all — a never-run workspace among them included. The ranking is now one
  // statement over the whole table: never-run first, then oldest run first,
  // id as the stable tiebreak, bounded only by the batch. The last-run lookup
  // is the (team_id, kind, started_at_utc DESC) index, once per workspace.
  //
  // It still reads only ids: this sweep never reads tenant data itself.
  const rows = await prisma.$queryRaw<Array<{ id: string; due: bigint }>>`
    WITH last_run AS (
      SELECT t.id,
             (SELECT max(r.started_at_utc)
                FROM governance_reconciliation_runs r
               WHERE r.team_id = t.id
                 AND r.kind::text = ${WORKSPACE_OPERATIONS_RUN_KIND}) AS last
        FROM teams t
    ),
    due AS (
      SELECT id, last FROM last_run WHERE last IS NULL OR last <= ${cutoff}
    )
    SELECT id::text AS id, (SELECT count(*) FROM due) AS due
      FROM due
     ORDER BY last ASC NULLS FIRST, id ASC
     LIMIT ${limit}
  `;
  return { ids: rows.map((r) => r.id), due: rows.length > 0 ? Number(rows[0]!.due) : 0 };
}

/**
 * OPS-008 — THE SWEEP'S COVERAGE, MEASURED, for the platform plane.
 *
 * How many workspaces exist, how many are due (never run, or older than the
 * freshness window) and the oldest last run among them. Read from the same run
 * rows the ranking uses, so it cannot disagree with what the next tick will
 * select. A due count that does not fall tick over tick says the batch is too
 * small for the deployment.
 */
export async function operationsSweepCoverage(now: Date = new Date()): Promise<{
  workspaces: number;
  due: number;
  neverRun: number;
  oldestLastRunAtUtc: string | null;
  newestRunAtUtc: string | null;
}> {
  const cutoff = new Date(now.getTime() - OPERATIONS_FRESHNESS_WINDOW_MS);
  const [row] = await prisma.$queryRaw<
    Array<{ workspaces: bigint; due: bigint; never_run: bigint; oldest: Date | null; newest: Date | null }>
  >`
    WITH last_run AS (
      SELECT t.id,
             (SELECT max(r.started_at_utc)
                FROM governance_reconciliation_runs r
               WHERE r.team_id = t.id
                 AND r.kind::text = ${WORKSPACE_OPERATIONS_RUN_KIND}) AS last
        FROM teams t
    )
    SELECT count(*) AS workspaces,
           count(*) FILTER (WHERE last IS NULL OR last <= ${cutoff}) AS due,
           count(*) FILTER (WHERE last IS NULL) AS never_run,
           min(last) AS oldest,
           max(last) AS newest
      FROM last_run
  `;
  return {
    workspaces: Number(row?.workspaces ?? 0),
    due: Number(row?.due ?? 0),
    neverRun: Number(row?.never_run ?? 0),
    oldestLastRunAtUtc: row?.oldest ? row.oldest.toISOString() : null,
    newestRunAtUtc: row?.newest ? row.newest.toISOString() : null,
  };
}

/**
 * One sweep tick. NEVER throws — a scheduler that can be killed by a tick is a
 * scheduler that stops running after the first bad day.
 */
export async function runWorkspaceOperationsSweep(
  options: { trigger?: "scheduler" | "startup" | "cli"; batchSize?: number } = {},
): Promise<OperationsSweepResult> {
  const startedAt = Date.now();
  const trigger = options.trigger ?? "scheduler";
  const batchSize = Math.max(1, Math.min(options.batchSize ?? WORKSPACE_BATCH, 200));
  const result: OperationsSweepResult = {
    ok: true,
    reconciled: 0,
    locked: 0,
    failed: 0,
    error: null,
    durationMs: 0,
    due: 0,
  };

  let workspaces: string[];
  try {
    const ranked = await workspacesNeedingReconciliation(batchSize, new Date());
    workspaces = ranked.ids;
    result.due = ranked.due;
  } catch (err) {
    result.ok = false;
    result.error = safeOperationsFailureCategory(err);
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  for (const workspaceId of workspaces) {
    // ONE WORKSPACE CANNOT ABORT THE SWEEP.
    //
    // The catch wraps the CLAIM, not only the body. The run authority reads
    // for a stale lock and then INSERTs the claim row, and neither of those is
    // inside the body's own try — so a dead connection, or an enum the
    // deployed database does not carry yet, propagates out of the wrapper
    // entirely. Search's sweep died at its first workspace on every tick for
    // exactly that reason, and "no run has ever been recorded" looked
    // identical to a workspace nobody had visited.
    try {
      const outcome = await reconcileWorkspaceOperations({
        workspaceId,
        trigger,
      });
      if (outcome.kind === "already_running") result.locked += 1;
      else if (outcome.kind === "failed") result.failed += 1;
      else result.reconciled += 1;
    } catch {
      result.failed += 1;
    }
  }

  // RECORD CONDITIONS WITH NO WORKSPACE ROW (2026-09-29). A report/package
  // failure for a Personal record stored with team_id NULL is LEGACY_UNSCOPED,
  // so no workspace pass above can select it. Swept once per tick, each read in
  // its record's workspace; a failure here never costs the workspace sweep.
  for (const sourceId of ["pipeline.report_generation_failed", "pipeline.package_generation_failed"]) {
    try {
      await sweepUnscopedSourceTruthRecoveries({ sourceId });
    } catch {
      result.failed += 1;
    }
  }

  // PLATFORM CONDITIONS (OPS-001 / OPS-009 / OPS-022). Worker liveness and
  // real queue failures are recorded ONCE per tick as PLATFORM rows, read from
  // the worker-fleet and queue-inventory authorities — never once per
  // workspace and never from a page visit. It never throws.
  try {
    await reconcilePlatformConditions();
  } catch {
    result.failed += 1;
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}

/** Swallowing wrapper for the interval timer. */
export async function runWorkspaceOperationsSweepSafe(
  options: { trigger?: "scheduler" | "startup" | "cli" } = {},
): Promise<OperationsSweepResult | null> {
  try {
    return await runWorkspaceOperationsSweep(options);
  } catch {
    return null;
  }
}
