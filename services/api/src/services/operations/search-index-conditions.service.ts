/**
 * SEARCH INDEX HEALTH — the producer for `search.indexing_failure`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SOURCE MEASURED FIRST, AND WHY IT WAS WRONG
 * ---------------------------------------------------------------------------
 * `search.indexing_failure` was registered with no producer at all. The first
 * producer read the newest terminal `GovernanceReconciliationRun` for the
 * workspace: FAILED or PARTIAL opened a condition, SUCCEEDED closed one.
 *
 * A run's exit status is a fact about a JOB, not about an INDEX. The
 * reconciliation scheduler converges by ENQUEUEING — it finds drifted rows,
 * schedules a rebuild for each under a deterministic job id, and returns — so
 * the run closes SUCCEEDED within milliseconds while the index is still empty.
 * The authority that owns those runs says exactly that in its own docstring,
 * and the reason it says it is that a purpose-built readiness derivation had
 * already been built to avoid this mistake.
 *
 * The consequence was the worst kind available to an operations surface: an
 * open indexing condition AUTO-RESOLVED while thousands of rebuilds sat in the
 * queue. A false all-clear, produced by the one source that exists to report
 * the opposite.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT MEASURES NOW
 * ---------------------------------------------------------------------------
 * `deriveSearchReadiness`, the canonical derivation, through the extracted
 * fact collector in `../search/search-health.service.js`:
 *
 *   * eligible records against records actually present in the index;
 *   * the removal backlog — documents whose source row is gone or ineligible,
 *     which is drift the two counts above cannot see;
 *   * the durable run row WITH ITS LEASE evaluated, so a crashed RUNNING row
 *     does not read as work in progress;
 *   * the queue's own job state for the outstanding records, so "still
 *     processing" is proven rather than assumed.
 *
 * The rule is not reimplemented here and the facts are not gathered twice: the
 * diagnostics endpoint an operator reads consumes the same module, so the page
 * and the condition cannot disagree about one workspace's index.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not run, trigger, schedule or repair a reconciliation, and it writes
 * no search document. It reads facts and records an operational condition. The
 * workspace cannot fix the reconciler, which is why the source is advisory and
 * offers no Resolve control — a genuinely healthy index closes it, through the
 * source-truth recovery sweep, from the same facts this read.
 */

import * as prismaPkg from "@prisma/client";
import type { IncidentSeverity } from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { recordIncident } from "../observability/incident.service.js";
import {
  classifySearchReadiness,
  resolveWorkspaceSearchReadiness,
} from "../search/search-health.service.js";

import { sweepSourceTruthRecoveries } from "./source-truth-recovery.service.js";

type PrismaClient = prismaPkg.PrismaClient;

/** The registered source this module is the declared producer for. */
export const SEARCH_INDEX_SOURCE_ID = "search.indexing_failure" as const;

/** `<prefix>:<teamId>` — one workspace-level condition, deduped on the team. */
export const SEARCH_INDEX_FINGERPRINT_PREFIX =
  "search:index_reconciliation" as const;

export function searchIndexFingerprint(teamId: string): string {
  return `${SEARCH_INDEX_FINGERPRINT_PREFIX}:${teamId}`;
}

export type SearchIndexConditionOutcome = {
  /** True when a condition is currently open for this workspace. */
  readonly active: boolean;
  /**
   * True when the index's health could not be concluded either way.
   *
   * Covers a workspace whose rebuilds are genuinely in flight (INITIALIZING /
   * PARTIAL) as well as one whose facts could not be read. Nothing opens and
   * nothing closes on it — which is the point: the two states that most look
   * like recovery are exactly the ones that must not be read as recovery.
   */
  readonly unknown: boolean;
  /** How many conditions this pass auto-resolved from a proven-healthy index. */
  readonly resolved: number;
  /** The derived readiness state, for the sweep's accounting and for tests. */
  readonly state: string;
};

/**
 * Open, re-observe or resolve this workspace's search-indexing condition.
 *
 * ONE condition per workspace: the fingerprint is the team, so a workspace
 * whose index is behind for twelve consecutive sweeps has one row with an
 * occurrence count of twelve rather than twelve rows.
 */
export async function syncSearchIndexConditions(
  input: { teamId: string; now?: Date },
  client: PrismaClient = defaultPrisma,
): Promise<SearchIndexConditionOutcome> {
  const now = input.now ?? new Date();

  let readiness: Awaited<ReturnType<typeof resolveWorkspaceSearchReadiness>>;
  try {
    readiness = await resolveWorkspaceSearchReadiness(
      { teamId: input.teamId, now },
      client,
    );
  } catch {
    // The facts could not be read. Nothing was learned, so nothing is opened
    // and nothing is closed — an unreadable index is not a healthy one.
    return { active: false, unknown: true, resolved: 0, state: "UNREADABLE" };
  }

  const verdict = classifySearchReadiness(readiness.state);

  if (verdict === "FAILING") {
    await recordIncident(
      {
        sourceId: SEARCH_INDEX_SOURCE_ID,
        teamId: input.teamId,
        category: "RECONCILIATION",
        // WARNING, not HIGH. Nothing evidential depends on the search index:
        // records, proofs, reports and packages are unaffected, and what is
        // degraded is FINDING them. Ranking it beside an unprovable record
        // would make the queue's genuinely worst rows harder to see.
        severity: "WARNING" as IncidentSeverity,
        fingerprint: searchIndexFingerprint(input.teamId),
        // COUNT-FREE and stable: the same sentence on every observation, so
        // nothing in it can go out of date the way a title carrying a number
        // does. The changing numbers travel in the metadata below.
        title: "Search index reconciliation failing",
        safeSummary:
          "This workspace's search index is out of step with its records, and nothing is currently working to close the gap, " +
          "so search results may be missing or out of date. " +
          "Evidence records, proofs, reports and verification packages are unaffected. " +
          "The condition closes on its own once the index is proven complete.",
        runbookSlug: "search-index",
        metadata: {
          // The DERIVED state, not a run's exit code. `STALLED` means work is
          // outstanding with nothing assigned to it; `FAILED` means the
          // durable run row says the reconciliation failed.
          readinessState: readiness.state,
          eligibleCount: readiness.eligibleCount,
          indexedCount: readiness.indexedCount,
          outstandingCount: readiness.outstandingCount,
          unresolvedRemovals: readiness.unresolvedRemovals,
          runStatus: readiness.runStatus,
          failureReason: readiness.failureReason,
        },
      },
      client,
    );
    return { active: true, unknown: false, resolved: 0, state: readiness.state };
  }

  if (verdict === "INDETERMINATE") {
    // INITIALIZING, PARTIAL, UNAVAILABLE, RESTRICTED, DEGRADED — and any
    // state a future release adds. Work may be genuinely in flight, the truth
    // may be unreadable, or a configured capability may be impaired beside a
    // converged count; in every case the index is NOT proven healthy, so an
    // open condition stays open, keeps its lifecycle and gains no resolver.
    return { active: false, unknown: true, resolved: 0, state: readiness.state };
  }

  // HEALTHY — READY or EMPTY_WORKSPACE, the only two states that assert
  // complete, unimpaired convergence. Positive proof that the
  // index is complete, and the shared sweep is what turns it into a
  // resolution, through the same probe, the same transition authority and the
  // same event and SLA writes every other source-truth recovery uses.
  const sweep = await sweepSourceTruthRecoveries(
    { teamId: input.teamId, sourceId: SEARCH_INDEX_SOURCE_ID, now },
    client,
  );
  return {
    active: false,
    unknown: false,
    resolved: sweep.resolved,
    state: readiness.state,
  };
}
