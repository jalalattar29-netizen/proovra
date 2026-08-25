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
async function workspacesNeedingReconciliation(
  limit: number,
  now: Date,
): Promise<string[]> {
  const cutoff = new Date(now.getTime() - OPERATIONS_FRESHNESS_WINDOW_MS);

  // Candidate workspaces. Bounded, and deliberately a plain list of ids: this
  // sweep never reads tenant data itself, so it needs nothing else.
  const teams = await prisma.team.findMany({
    select: { id: true },
    // A generous bound. Larger than the batch so the ranking below has
    // something to rank, and finite so a very large deployment cannot turn one
    // tick into a full table scan.
    take: limit * 20,
    orderBy: { createdAt: "asc" },
  });
  if (teams.length === 0) return [];

  const latestRuns = await prisma.governanceReconciliationRun.groupBy({
    by: ["teamId"],
    where: {
      kind: WORKSPACE_OPERATIONS_RUN_KIND,
      teamId: { in: teams.map((t) => t.id) },
    },
    _max: { startedAtUtc: true },
  });
  const lastRunByTeam = new Map<string, Date>();
  for (const row of latestRuns) {
    if (row.teamId && row._max.startedAtUtc) {
      lastRunByTeam.set(row.teamId, row._max.startedAtUtc);
    }
  }

  const due = teams
    .map((t) => ({ id: t.id, last: lastRunByTeam.get(t.id) ?? null }))
    // Never-run workspaces and workspaces whose newest run predates the
    // freshness window. A workspace inside its window is not touched: churning
    // it would spend the batch on workspaces that already have a current
    // picture while the ones that do not keep waiting.
    .filter((t) => t.last === null || t.last.getTime() <= cutoff.getTime())
    .sort((a, b) => {
      if (a.last === null && b.last === null) return 0;
      if (a.last === null) return -1;
      if (b.last === null) return 1;
      return a.last.getTime() - b.last.getTime();
    })
    .slice(0, limit);

  return due.map((t) => t.id);
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
  };

  let workspaces: string[];
  try {
    workspaces = await workspacesNeedingReconciliation(batchSize, new Date());
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
