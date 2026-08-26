/**
 * WORKSPACE SEARCH HEALTH — the fact collection behind `deriveSearchReadiness`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * `deriveSearchReadiness` has been the canonical index-health derivation for a
 * while, and exactly one caller could reach it: the diagnostics route, which
 * gathered its inputs INLINE. So the derivation was shared and the FACTS were
 * not, and anything else that wanted to know whether a workspace's search
 * index was healthy had to either call an HTTP endpoint or invent a proxy.
 *
 * `search.indexing_failure` invented a proxy, and it was the wrong one:
 *
 *     the newest terminal GovernanceReconciliationRun.status === "SUCCEEDED"
 *
 * That is a statement about a JOB, not about an INDEX. The reconciliation
 * scheduler converges by ENQUEUEING — it finds drifted rows, schedules a
 * rebuild for each under a deterministic job id, and returns — so the run
 * closes SUCCEEDED within milliseconds while the index is still empty. The
 * authority that owns this says so in its own words; see the `scheduled`
 * counter's docstring in `packages/shared-runtime/src/search-index-reconciliation.ts`.
 *
 * A source-truth probe reading that column therefore auto-resolved an open
 * indexing condition while five thousand rebuilds sat in the queue. That is a
 * false all-clear, produced by the one source that exists to report the
 * opposite.
 *
 * ---------------------------------------------------------------------------
 * WHAT MOVED, AND WHAT DELIBERATELY DID NOT
 * ---------------------------------------------------------------------------
 * The QUERIES moved here — the eligible-population breakdown, the index
 * counts, the removal backlog, the durable run row, and the queue probe. The
 * DERIVATION did not: `deriveSearchReadiness` stays in `@proovra/shared` and is
 * called, never reimplemented. There is one copy of the rule and now one copy
 * of the facts.
 *
 * The diagnostics route consumes this module rather than keeping its own
 * copies, so the endpoint an operator reads and the probe that closes a
 * condition cannot disagree about a workspace's index.
 *
 * ---------------------------------------------------------------------------
 * TENANT ISOLATION
 * ---------------------------------------------------------------------------
 * Every query below is bound to `teamId` in its own WHERE clause — the
 * evidence breakdown, the document counts, the removal backlog and the run
 * row. There is no arm that widens to `team_id IS NULL` and no post-read
 * filter that could be reordered away. `latestSearchRun` is tenant-bound in
 * the shared authority itself.
 */

import type { PrismaClient } from "@prisma/client";
import {
  deriveSearchReadiness,
  searchIndexableLifecycleSql,
  type SearchReadiness,
  type SearchScheduledWorkFacts,
} from "@proovra/shared";
import {
  latestSearchRun,
  type SearchRunSnapshot,
} from "@proovra/shared-runtime";

import { prisma as defaultPrisma } from "../../db.js";

import {
  probeSearchScheduledWork,
  SEARCH_SCHEDULED_WORK_PROBE_CEILING,
} from "./search-scheduled-work.service.js";

/**
 * THE ONE eligibility predicate.
 *
 * The same expression the diagnostics route, the worker's reconciler and the
 * removal backlog all use. Bound once here so the numerator, the denominator
 * and the drift query cannot be given three different definitions of "should
 * this record be in the index" — which is exactly how a coverage percentage
 * comes to sit at 98% forever.
 */
const ELIGIBLE_SQL = searchIndexableLifecycleSql("lifecycle_state");

/** The per-lifecycle partition of one workspace's evidence. */
export type SearchEvidenceBreakdown = {
  readonly activeIncluded: number;
  readonly archivedIncluded: number;
  readonly lockedIncluded: number;
  readonly trashedIncluded: number;
  readonly destroyedExcluded: number;
  readonly pendingDestructionExcluded: number;
};

export type WorkspaceSearchHealthFacts = {
  /** Records the projection is supposed to have written. The denominator. */
  readonly eligibleCount: number;
  /** Eligible records currently present in the index. The numerator. */
  readonly indexedEvidenceCount: number;
  /** Every document in the index, all types. Back-compat reporting only. */
  readonly indexedTotal: number;
  readonly indexedByType: Readonly<Record<string, number>>;
  /** Informational. Never an input to the derived state. */
  readonly lastIndexedAtUtc: Date | null;
  /**
   * Documents whose source row is gone or has become ineligible.
   *
   * The OTHER direction of drift. Invisible to the two counts above: a
   * destroyed record's leftover document keeps `indexed >= eligible` while
   * Search still answers for a record governance decided no longer exists.
   */
  readonly unresolvedRemovals: number;
  /** The durable run row for THIS workspace, with its lease evaluated. */
  readonly run: SearchRunSnapshot | null;
  /** What the queue holds for the outstanding records, or undefined. */
  readonly scheduledWork: SearchScheduledWorkFacts | undefined;
  readonly breakdown: SearchEvidenceBreakdown;
  /** Every row the evidence table holds, including the excluded lifecycles. */
  readonly evidenceTotal: number;
};

/**
 * Gather every persisted fact `deriveSearchReadiness` consumes, for one
 * workspace.
 *
 * The queue probe is SKIPPED when nothing is outstanding: a converged
 * workspace has no question to ask, and paying a queue round trip to confirm
 * an empty answer would make the healthy path the slow one. Its absence is
 * then an honest omission rather than a claim that the queue was empty.
 */
export async function collectWorkspaceSearchHealthFacts(
  input: { teamId: string; now?: Date },
  client: PrismaClient = defaultPrisma,
): Promise<WorkspaceSearchHealthFacts> {
  const now = input.now ?? new Date();
  const teamId = input.teamId;

  const [breakdownRaw, indexedByTypeRaw, run, removalRows] = await Promise.all([
    // Per-state breakdown — one round trip. A mutually-exclusive partition of
    // every row in `evidence` for this team: DESTROYED and PENDING_DESTRUCTION
    // win their bucket regardless of deleted_at / archived_at / locked_at, so
    // the buckets sum to a single number.
    client.$queryRawUnsafe<
      Array<{
        active_included: bigint;
        archived_included: bigint;
        locked_included: bigint;
        trashed_included: bigint;
        destroyed_excluded: bigint;
        pending_destruction_excluded: bigint;
      }>
    >(
      `SELECT
         COUNT(*) FILTER (
           WHERE ${ELIGIBLE_SQL}
             AND deleted_at IS NULL
             AND archived_at IS NULL
             AND locked_at IS NULL
         )::bigint AS active_included,
         COUNT(*) FILTER (
           WHERE ${ELIGIBLE_SQL}
             AND deleted_at IS NULL
             AND archived_at IS NOT NULL
         )::bigint AS archived_included,
         COUNT(*) FILTER (
           WHERE ${ELIGIBLE_SQL}
             AND deleted_at IS NULL
             AND archived_at IS NULL
             AND locked_at IS NOT NULL
         )::bigint AS locked_included,
         COUNT(*) FILTER (
           WHERE ${ELIGIBLE_SQL}
             AND deleted_at IS NOT NULL
         )::bigint AS trashed_included,
         COUNT(*) FILTER (
           WHERE COALESCE(lifecycle_state, 'ACTIVE') = 'DESTROYED'
         )::bigint AS destroyed_excluded,
         COUNT(*) FILTER (
           WHERE COALESCE(lifecycle_state, 'ACTIVE') = 'PENDING_DESTRUCTION'
         )::bigint AS pending_destruction_excluded
       FROM evidence
       WHERE team_id = $1::uuid`,
      teamId,
    ),
    client.$queryRawUnsafe<
      Array<{ document_type: string; n: bigint; last_indexed: Date | null }>
    >(
      `SELECT document_type,
              COUNT(*)::bigint    AS n,
              MAX(indexed_at_utc) AS last_indexed
         FROM evidence_search_documents
        WHERE team_id = $1::uuid
        GROUP BY document_type`,
      teamId,
    ),
    latestSearchRun(client, teamId, now),
    client.$queryRawUnsafe<Array<{ pending: number }>>(
      `SELECT COUNT(*)::int AS pending
         FROM evidence_search_documents d
         LEFT JOIN evidence e ON e.id = d.source_id
        WHERE d.team_id = $1::uuid
          AND d.document_type = 'EVIDENCE'
          AND (e.id IS NULL OR NOT (${searchIndexableLifecycleSql("e.lifecycle_state")}))`,
      teamId,
    ),
  ]);

  const bd = breakdownRaw[0] ?? {
    active_included: 0n,
    archived_included: 0n,
    locked_included: 0n,
    trashed_included: 0n,
    destroyed_excluded: 0n,
    pending_destruction_excluded: 0n,
  };
  const breakdown: SearchEvidenceBreakdown = {
    activeIncluded: Number(bd.active_included),
    archivedIncluded: Number(bd.archived_included),
    lockedIncluded: Number(bd.locked_included),
    trashedIncluded: Number(bd.trashed_included),
    destroyedExcluded: Number(bd.destroyed_excluded),
    pendingDestructionExcluded: Number(bd.pending_destruction_excluded),
  };
  const eligibleCount =
    breakdown.activeIncluded +
    breakdown.archivedIncluded +
    breakdown.lockedIncluded +
    breakdown.trashedIncluded;
  const evidenceTotal =
    eligibleCount +
    breakdown.destroyedExcluded +
    breakdown.pendingDestructionExcluded;

  const indexedByType: Record<string, number> = {};
  let indexedTotal = 0;
  let lastIndexedAtUtc: Date | null = null;
  for (const row of indexedByTypeRaw) {
    const n = Number(row.n);
    indexedByType[row.document_type] = n;
    indexedTotal += n;
    if (
      row.last_indexed &&
      (lastIndexedAtUtc === null || row.last_indexed > lastIndexedAtUtc)
    ) {
      lastIndexedAtUtc = row.last_indexed;
    }
  }
  const indexedEvidenceCount = indexedByType.EVIDENCE ?? 0;
  const unresolvedRemovals = removalRows[0]?.pending ?? 0;

  let scheduledWork: SearchScheduledWorkFacts | undefined;
  if (indexedEvidenceCount < eligibleCount) {
    // The outstanding records themselves, bounded and tenant-scoped by the
    // SAME eligibility authority the counts use — so the probe can never be
    // pointed at a record this workspace does not own, and can never disagree
    // with the denominator about which records are missing.
    const outstanding = await client.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT e.id::text AS id
         FROM evidence e
         LEFT JOIN evidence_search_documents d
                ON d.source_id = e.id
               AND d.document_type = 'EVIDENCE'
        WHERE e.team_id = $1::uuid
          AND ${ELIGIBLE_SQL}
          AND d.source_id IS NULL
        ORDER BY e.updated_at ASC
        LIMIT $2`,
      teamId,
      SEARCH_SCHEDULED_WORK_PROBE_CEILING,
    );
    scheduledWork = await probeSearchScheduledWork({
      sourceIds: outstanding.map((r) => r.id),
    });
  }

  return {
    eligibleCount,
    indexedEvidenceCount,
    indexedTotal,
    indexedByType,
    lastIndexedAtUtc,
    unresolvedRemovals,
    run,
    scheduledWork,
    breakdown,
    evidenceTotal,
  };
}

/**
 * THE CANONICAL READINESS OF ONE WORKSPACE'S SEARCH INDEX.
 *
 * Facts from this module, rule from `@proovra/shared`. Callers that only need
 * the verdict use this; the diagnostics route uses the facts as well, because
 * it reports the counts alongside the state.
 *
 * `authorized` and `serviceReachable` are true by construction here: the
 * caller reached the database, and every caller has already settled
 * authorization at its own boundary — the route through `requireSearchActor`,
 * the operational probe through the workspace scope it was handed. Asserting
 * either from inside this function would be inventing an answer to a question
 * it cannot see.
 */
export async function resolveWorkspaceSearchReadiness(
  input: {
    teamId: string;
    now?: Date;
    /** Secondary capabilities configured for this workspace and not answering. */
    degradedCapabilities?: ReadonlyArray<string>;
    /** Pre-collected facts, when the caller already gathered them. */
    facts?: WorkspaceSearchHealthFacts;
  },
  client: PrismaClient = defaultPrisma,
): Promise<SearchReadiness> {
  const now = input.now ?? new Date();
  const facts =
    input.facts ??
    (await collectWorkspaceSearchHealthFacts({ teamId: input.teamId, now }, client));
  return deriveSearchReadiness({
    eligibleCount: facts.eligibleCount,
    indexedCount: facts.indexedEvidenceCount,
    unresolvedRemovals: facts.unresolvedRemovals,
    lastIndexedAtUtc: facts.lastIndexedAtUtc,
    run: facts.run
      ? {
          status: facts.run.status,
          leaseValid: facts.run.leaseValid,
          failureCategory: facts.run.failureCategory,
        }
      : null,
    scheduledWork: facts.scheduledWork,
    authorized: true,
    serviceReachable: true,
    degradedCapabilities: input.degradedCapabilities,
    now,
  });
}

/**
 * WHAT AN OPERATIONS CONDITION SHOULD SAY ABOUT A READINESS STATE.
 *
 * ---------------------------------------------------------------------------
 * THE MAPPING, AND WHY EACH SIDE IS WHERE IT IS
 * ---------------------------------------------------------------------------
 * HEALTHY — the index is correct and nothing is outstanding:
 *
 *   READY            everything eligible is present, nothing awaiting removal;
 *   DEGRADED         the same, qualified by a secondary capability (semantic
 *                    search) that is configured and not answering. Deterministic
 *                    search is complete, so the INDEX is healthy;
 *   EMPTY_WORKSPACE  there is nothing to index and no leftover document. A
 *                    complete state, not a pending one.
 *
 * FAILING — proven drift or a proven failure:
 *
 *   STALLED  work is outstanding and nothing is assigned to it — no run, or a
 *            finished run with drift remaining and no job in flight;
 *   FAILED   the durable run row says the reconciliation failed.
 *
 * INDETERMINATE — everything else, and all of it fails closed:
 *
 *   INITIALIZING  outstanding work with a rebuild genuinely in flight;
 *   PARTIAL       the same, with some records already indexed;
 *   UNAVAILABLE   the service could not be reached, so no count was measured;
 *   RESTRICTED    an answer about the ACTOR, not about the index.
 *
 * INITIALIZING and PARTIAL are the subtle ones. They are NOT healthy — the
 * index is incomplete — and they are NOT proven failures either, because
 * something is demonstrably working on it. Reading them as recovery is the
 * exact defect this replaces; reading them as failure would open a condition
 * every time a workspace uploaded a record. UNKNOWN is what they are: the
 * probe cannot conclude, so nothing opens and nothing closes.
 */
export type SearchHealthVerdict = "HEALTHY" | "FAILING" | "INDETERMINATE";

export function classifySearchReadiness(
  state: SearchReadiness["state"],
): SearchHealthVerdict {
  switch (state) {
    case "READY":
    case "DEGRADED":
    case "EMPTY_WORKSPACE":
      return "HEALTHY";
    case "STALLED":
    case "FAILED":
      return "FAILING";
    default:
      // INITIALIZING, PARTIAL, UNAVAILABLE, RESTRICTED — and anything a future
      // state adds. A state this build does not recognise must never be read
      // as recovery, so the default is the fail-closed one by construction
      // rather than by remembering to extend a list.
      return "INDETERMINATE";
  }
}
