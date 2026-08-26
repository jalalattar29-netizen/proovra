/**
 * SEARCH INDEX RECONCILIATION — the producer for `search.indexing_failure`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SOURCE STOPPED BEING A ROADMAP ENTRY
 * ---------------------------------------------------------------------------
 * `search.indexing_failure` was registered with no producer and the stated
 * reason that index health "is owned by the SEARCH_INDEX run authority and its
 * own readiness projection". That was accurate and it was also the description
 * of a producer nobody had written.
 *
 * The worker's reconciler claims ONE WORKSPACE AT A TIME through the shared
 * governance-run wrapper, so `governance_reconciliation_runs` already carries,
 * per workspace, a durable row with `kind = SEARCH_INDEX`, a terminal status
 * and a start instant. Whether this workspace's search index is currently
 * being kept in step is a fact that table states. This reads it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not run, trigger, schedule or repair a reconciliation, and it does
 * not read or write a single search document. It reads one run row and records
 * an operational condition. The workspace cannot fix the reconciler, which is
 * why the source is advisory and offers no Resolve control: the next
 * successful run closes the condition, through the source-truth recovery
 * sweep, from the same table this read.
 */

import * as prismaPkg from "@prisma/client";
import type { IncidentSeverity } from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { recordIncident } from "../observability/incident.service.js";

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

/**
 * The statuses that mean the run did not do its job.
 *
 * PARTIAL is included with FAILED, and the distinction it draws is the one
 * that matters here: a run that reconciled some documents and could not
 * reconcile others has left the index out of step, and calling that a success
 * because it did not throw is the shape of false all-clear this programme
 * exists to remove.
 */
const FAILING_RUN_STATUSES: readonly prismaPkg.GovernanceReconciliationStatus[] =
  [
    prismaPkg.GovernanceReconciliationStatus.FAILED,
    prismaPkg.GovernanceReconciliationStatus.PARTIAL,
  ];

export type SearchIndexConditionOutcome = {
  /** True when a condition is currently open for this workspace. */
  readonly active: boolean;
  /** True when the newest terminal run could not be read at all. */
  readonly unknown: boolean;
  /** How many conditions this pass auto-resolved from a later good run. */
  readonly resolved: number;
};

/**
 * Open, re-observe or resolve this workspace's search-indexing condition.
 *
 * ONE condition per workspace: the fingerprint is the team, so a workspace
 * whose reconciliation fails on twelve consecutive ticks has one row with an
 * occurrence count of twelve rather than twelve rows.
 *
 * A workspace with NO terminal run yet opens nothing. "The reconciler has not
 * finished here" is not the same as "the reconciler failed here", and inventing
 * a condition from an absence is how a surface starts describing its own blind
 * spots as findings.
 */
export async function syncSearchIndexConditions(
  input: { teamId: string; now?: Date },
  client: PrismaClient = defaultPrisma,
): Promise<SearchIndexConditionOutcome> {
  const now = input.now ?? new Date();

  const run = await client.governanceReconciliationRun.findFirst({
    where: {
      teamId: input.teamId,
      kind: prismaPkg.GovernanceReconciliationKind.SEARCH_INDEX,
      // TERMINAL ONLY. A RUNNING row has concluded nothing, and treating one
      // as either answer would let a condition open or close on the strength
      // of work still in flight.
      status: {
        in: [
          prismaPkg.GovernanceReconciliationStatus.SUCCEEDED,
          prismaPkg.GovernanceReconciliationStatus.FAILED,
          prismaPkg.GovernanceReconciliationStatus.PARTIAL,
        ],
      },
    },
    orderBy: [{ startedAtUtc: "desc" }, { id: "desc" }],
    select: { status: true, finishedAtUtc: true, startedAtUtc: true },
  });

  if (!run) {
    // Nothing observed. No condition is opened and no existing one is closed:
    // an absence proves neither.
    return { active: false, unknown: true, resolved: 0 };
  }

  const failing = FAILING_RUN_STATUSES.includes(run.status);

  if (failing) {
    await recordIncident(
      {
        sourceId: SEARCH_INDEX_SOURCE_ID,
        teamId: input.teamId,
        category: "RECONCILIATION",
        // WARNING, not HIGH. Nothing evidential depends on the search index:
        // records, proofs, reports and packages are unaffected, and what is
        // degraded is finding them. Ranking it beside an unprovable record
        // would make the queue's genuinely worst rows harder to see.
        severity: "WARNING" as IncidentSeverity,
        fingerprint: searchIndexFingerprint(input.teamId),
        // COUNT-FREE and stable: the same sentence on every observation, so
        // nothing in it can go out of date the way a title carrying a number
        // does.
        title: "Search index reconciliation failing",
        safeSummary:
          "This workspace's most recent search-index reconciliation did not complete successfully, so search results may be missing or out of date. " +
          "Evidence records, proofs, reports and verification packages are unaffected. " +
          "The condition closes on its own when a reconciliation run for this workspace succeeds.",
        runbookSlug: "search-index",
        metadata: {
          runStatus: run.status,
          runStartedAtUtc: run.startedAtUtc.toISOString(),
          runFinishedAtUtc: run.finishedAtUtc
            ? run.finishedAtUtc.toISOString()
            : null,
        },
      },
      client,
    );
    return { active: true, unknown: false, resolved: 0 };
  }

  // The newest terminal run SUCCEEDED. That is positive proof of recovery, and
  // the shared sweep is what turns it into a resolution — through the same
  // probe, the same transition authority and the same event and SLA writes
  // every other source-truth recovery uses.
  const sweep = await sweepSourceTruthRecoveries(
    { teamId: input.teamId, sourceId: SEARCH_INDEX_SOURCE_ID, now },
    client,
  );
  return { active: false, unknown: false, resolved: sweep.resolved };
}
