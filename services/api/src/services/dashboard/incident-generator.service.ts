/**
 * Phase 32.8C — Operations Control Plane: Incident Generator.
 *
 * Observes real operational state (existing tables, no fabricated data) and
 * deterministically opens, refreshes and RESOLVES `OperationalIncident` rows
 * from what it sees. Incident writes go through the existing `recordIncident`
 * upsert, which dedups on `(teamId, fingerprint)`, and through
 * `resolveConditionFromSourceRecovery`, which closes a condition its source
 * says is over.
 *
 * WHAT MOVED, AND WHY
 * -------------------
 * The per-rule scanners that used to live here are gone. Each was a private
 * count that only discovery could run, which is precisely why an operator
 * could declare a report backlog resolved while all 26 records were still
 * above the threshold: nothing outside this file could ask the question.
 *
 * Every count, threshold and comparison now lives with its SOURCE, in
 * `operations-source-probes.ts`, and five callers share it — discovery, the
 * manual-resolution gate, recovery detection, recurrence detection and the
 * metric a row displays. This file CONSUMES that observation and owns the
 * accounting around it.
 *
 * Hard rules, unchanged:
 *   - Every fingerprint corresponds to a REAL condition observed in the
 *     workspace's existing tables. NO fabricated incidents.
 *   - Generator failures NEVER block evidence / report / package / verify
 *     core flows.
 *   - Bounded counts, bounded summaries, no raw payloads exposed.
 *   - This is the DASHBOARD-READ generator. It runs lazily; the worker
 *     remains the authoritative path for incidents that originate deep in the
 *     pipeline (e.g., worker.health_start_failed).
 */

import type { Prisma } from "@prisma/client";

import { prisma } from "../../db.js";
import {
  markConditionObservationStale,
  recordIncident,
  resolveConditionFromSourceRecovery,
} from "../observability/incident.service.js";
import { syncEvidenceIntegrityConditions } from "../operations/evidence-integrity-conditions.service.js";
import { syncDependentCancellationConditions } from "../billing/dependent-cancellation-conditions.service.js";
import { syncSearchIndexConditions } from "../operations/search-index-conditions.service.js";
import { sweepSourceTruthRecoveries } from "../operations/source-truth-recovery.service.js";
import {
  aggregateFingerprint,
  aggregateSpecs,
  observeAggregate,
} from "../operations/operations-source-probes.js";
import {
  reportSourceFailure,
  toSourceFailure,
} from "../operations/operations-source-diagnostics.js";
import {
  buildConditionMetric,
  workspaceEvidenceWhere,
  type OperationsSourceFailure,
} from "@proovra/shared-runtime";

type GenerationContext = {
  teamId: string;
  /**
   * The canonical workspace evidence scope, resolved ONCE per sweep.
   *
   * Every evidence-derived scan below filters through this rather than a raw
   * `teamId` equality. On a PERSONAL workspace the records live under the
   * owner's legacy `team_id = NULL` rows, which a strict filter misses — the
   * same defect that made the Operations page render "clear" over a workspace
   * Home was reporting as CRITICAL. `workspaceEvidenceWhere` widens to those
   * owner-bound NULL-team rows for personal workspaces only, so a shared team
   * keeps its strict filter and nothing leaks across tenants.
   */
  evidenceWhere: Prisma.EvidenceWhereInput;
};

/**
 * Run the full scan for a workspace. Never throws. Returns the count of
 * incidents persisted (created or incremented) and any per-rule errors.
 */
export type WorkspaceDiscoveryResult = {
  recorded: number;
  failed: number;
  rules: string[];
  /**
   * WORKSPACE-SCOPE CONVERGENCE (§7/§8) — WHICH sources this run actually
   * completed.
   *
   * The sweep used to return only `failed: <count>`, which cannot answer the
   * question readiness has to ask: a count of two failures says nothing about
   * WHICH two, so a run that lost the evidence-integrity scan and a run that
   * lost platform telemetry were indistinguishable — and only one of those
   * means the workspace's own picture is incomplete.
   */
  sources: {
    attempted: string[];
    successful: string[];
    failed: string[];
    truncated: string[];
    /**
     * WHY each failed source failed. One entry per id in `failed`.
     *
     * The ids alone were measured to be insufficient: a production workspace
     * reported six failed sources with no recoverable cause, because the
     * handlers below caught with a bare `catch {}` and did not bind the error.
     * Every handler now binds it, classifies it through one authority, and
     * reports the operator-side detail separately.
     */
    failures: OperationsSourceFailure[];
  };
};

export async function generateIncidentsForWorkspace(
  input: { teamId: string; requestId?: string | null; traceId?: string | null },
): Promise<WorkspaceDiscoveryResult> {
  const rules: string[] = [];
  let recorded = 0;
  let failed = 0;
  const attempted: string[] = [];
  const successful: string[] = [];
  const failedSources: string[] = [];
  const truncatedSources: string[] = [];
  const failures: OperationsSourceFailure[] = [];

  /**
   * ONE place a source failure is recorded, so the id and the reason cannot
   * come apart. Every handler below routes through this; none of them may
   * push onto `failedSources` directly, and
   * `operations-source-accounting.test.ts` pins that.
   *
   * `stage` matters: SCAN means the condition could not be LOOKED for, WRITE
   * means it was found and could not be RECORDED. The second is strictly
   * worse — there is a real, observed, unrecorded condition in the workspace —
   * and only the second can be true while discovery is perfectly healthy,
   * which is exactly the production signature this closes.
   */
  const failSource = (
    sourceIds: string[],
    stage: "SCAN" | "WRITE" | "UNKNOWN",
    err: unknown,
  ): void => {
    failed += 1;
    for (const sourceId of sourceIds) {
      const failure = toSourceFailure(sourceId, stage, err);
      failedSources.push(sourceId);
      failures.push(failure);
      reportSourceFailure(failure, err, {
        workspaceId: input.teamId,
        requestId: input.requestId ?? null,
        traceId: input.traceId ?? null,
      });
    }
  };

  // Resolve the canonical workspace evidence scope ONCE, and thread it through
  // every evidence-derived scan below. This is the whole correction: a raw
  // `teamId` equality misses a personal workspace's legacy `team_id = NULL`
  // records, so the sweep found nothing and Operations rendered "clear" over a
  // workspace with real, unresolved conditions.
  const ctx: GenerationContext = {
    teamId: input.teamId,
    evidenceWhere: await workspaceEvidenceWhere(input.teamId, prisma),
  };

  // ---------------------------------------------------------------------
  // ATTENTION ARCHITECTURE PHASE 3 — per-Evidence integrity conditions.
  //
  // Run FIRST and separately from the threshold rules below, because it is a
  // different shape of scan: the rules each answer "has this workspace-level
  // threshold been crossed?" and produce at most one incident, while this
  // one answers "which individual records currently cannot be proven?" and
  // produces one condition PER RECORD.
  //
  // That difference is the point. A threshold rule that said "17 records
  // failed timestamping" would be exactly the grouping this phase retracts:
  // seventeen records that each need fixing, rendered as one number nobody
  // can act on. Each record gets its own condition, its own acknowledgement
  // and its own resolution, driven by that record's own status column.
  // ---------------------------------------------------------------------
  // The integrity scan covers three registered sources in one pass (TSA
  // failure, OTS failure, aged OTS pending), so all three share its outcome.
  const INTEGRITY_SOURCE_IDS = [
    "evidence_integrity.tsa_failed",
    "evidence_integrity.ots_failed",
    "evidence_integrity.ots_pending_aged",
  ];
  attempted.push(...INTEGRITY_SOURCE_IDS);
  try {
    const integrity = await syncEvidenceIntegrityConditions({
      teamId: ctx.teamId,
    });
    recorded += integrity.opened + integrity.reobserved;
    if (integrity.opened > 0 || integrity.reobserved > 0) {
      rules.push("evidence_integrity:per_record");
    }
    if (!integrity.complete) {
      // Say so rather than reporting a tidy number over a bounded read. A
      // bounded read is not a complete one, and a workspace whose integrity
      // scan hit its limit must not be describable as clear.
      rules.push("evidence_integrity:scan_incomplete");
      truncatedSources.push(...INTEGRITY_SOURCE_IDS);
    } else {
      successful.push(...INTEGRITY_SOURCE_IDS);
    }
  } catch (err) {
    // The integrity pass both scans AND writes, so its stage cannot be
    // attributed from out here without guessing. It tags its own error with
    // the stage it was in (`inSourceStage`), and UNKNOWN is the honest
    // fallback for anything that reached here untagged.
    failSource(INTEGRITY_SOURCE_IDS, "UNKNOWN", err);
  }

  // -------------------------------------------------------------------------
  // THE DEPENDENT STORAGE-CANCELLATION SOURCE.
  //
  // Written by the billing path when a base plan is cancelled and one of its
  // recurring Storage add-ons cannot be stopped — but SWEPT here as well, and
  // that is not redundancy. An obligation recorded while Operations was
  // unavailable would otherwise carry no condition until something else
  // happened to it, and this workspace's operator would see nothing while the
  // customer was still being charged.
  //
  // It is a READ of the add-on's own durable obligation state, bounded to this
  // workspace. It contacts no payment provider: a probe or a sweep that could
  // itself fail at the provider would make the condition look recovered when
  // the provider was merely unreachable.
  const DEPENDENT_CANCELLATION_SOURCE_IDS = [
    "billing.dependent_cancellation_failed",
  ];
  attempted.push(...DEPENDENT_CANCELLATION_SOURCE_IDS);
  try {
    const dependent = await syncDependentCancellationConditions({
      teamId: ctx.teamId,
    });
    recorded += dependent.opened;
    if (dependent.opened > 0) {
      rules.push("billing_dependent_cancellation:per_record");
    }
    successful.push(...DEPENDENT_CANCELLATION_SOURCE_IDS);
  } catch (err) {
    // SCAN: this source both reads the obligations and writes their
    // conditions, and the read is what fails first if anything does.
    failSource(DEPENDENT_CANCELLATION_SOURCE_IDS, "SCAN", err);
  }

  // -------------------------------------------------------------------------
  // THE AGGREGATE SOURCES.
  //
  // The scanners that used to live in this file are gone. Each of them was a
  // private count that only discovery could run, which is exactly why an
  // operator could declare a backlog resolved: nothing else in the product
  // could ask whether the backlog was still there.
  //
  // The count now lives with its source, in `operations-source-probes.ts`, and
  // this loop CONSUMES it. Same predicate, same threshold, same comparison, in
  // discovery and in the resolve path and in the metric the row displays.
  //
  // Per-source isolation is still the load-bearing property: one broken
  // observation marks ITS source failed and the sweep continues, and a broken
  // source can never fabricate a clear result because its id is absent from
  // `successful`.
  // -------------------------------------------------------------------------
  const probeCtxBase = {
    teamId: ctx.teamId,
    client: prisma,
    now: new Date(),
    evidenceWhere: ctx.evidenceWhere,
  };

  for (const spec of aggregateSpecs()) {
    const sourceId = spec.sourceId;
    attempted.push(sourceId);
    const fingerprint = aggregateFingerprint(spec, ctx.teamId);
    const observation = await observeAggregate(spec, {
      ...probeCtxBase,
      fingerprint,
    });

    if (observation.activity === "UNKNOWN") {
      // The source could not be READ. Nothing is learned, nothing is written
      // about whether the condition holds, and any metric already on the row
      // is flagged rather than replaced — a stale number that says it is stale
      // is honest; a zero would say "recovered", which is the one thing we do
      // not know.
      await markConditionObservationStale({ teamId: ctx.teamId, fingerprint });
      failSource(
        [sourceId],
        "SCAN",
        new Error(`${sourceId}: source could not be observed`),
      );
      continue;
    }

    if (observation.activity === "ACTIVE") {
      rules.push(fingerprint);
      try {
        await recordIncident({
          // The spec IS the source. Eight aggregate sources, eight contracts,
          // and the loop carries the id rather than the reader inferring it
          // from a fingerprint prefix.
          sourceId: spec.sourceId,
          teamId: ctx.teamId,
          category: spec.category,
          severity: observation.severity ?? "WARNING",
          fingerprint,
          // STABLE AND COUNT-FREE. The number is in the metric, where it can
          // be refreshed; a title carrying "(26)" was written once and then
          // frozen for the life of the condition.
          title: spec.stableTitle,
          safeSummary: spec.describe({ value: observation.currentValue ?? 0 }),
          runbookSlug: spec.runbookSlug,
          metric: buildConditionMetric({
            currentValue: observation.currentValue ?? 0,
            thresholdValue: observation.thresholdValue ?? spec.thresholdValue,
            criticalThresholdValue: observation.criticalThresholdValue,
            unit: spec.unit,
            observedAtUtc: observation.observedAtUtc,
            truncated: observation.truncated,
            affectedEntityType: spec.affectedEntityType,
          }),
        });
        recorded += 1;
        successful.push(sourceId);
      } catch (err) {
        // The scan SAW the condition and the write failed. The source is not
        // successful: its condition exists and is not recorded, which is
        // exactly the state that must stop a clear assertion.
        failSource([sourceId], "WRITE", err);
      }
      continue;
    }

    // RECOVERED. Below threshold, positively observed — which is a different
    // fact from "discovery did not re-record it", and the difference is why
    // threshold conditions used to stay OPEN forever after a workspace fixed
    // them. Resolving is idempotent: an already-resolved condition is left
    // untouched by the shared transition authority.
    try {
      await resolveConditionFromSourceRecovery({
        teamId: ctx.teamId,
        fingerprint,
        safeMessage: `${spec.stableTitle}: the source is below its threshold of ${spec.thresholdValue} ${spec.unit}. Resolved from positive observation, not from absence in a scan.`,
        metric: buildConditionMetric({
          currentValue: observation.currentValue ?? 0,
          thresholdValue: observation.thresholdValue ?? spec.thresholdValue,
          criticalThresholdValue: observation.criticalThresholdValue,
          unit: spec.unit,
          observedAtUtc: observation.observedAtUtc,
          truncated: observation.truncated,
          affectedEntityType: spec.affectedEntityType,
        }),
      });
      // Looked, and found the condition no longer true. That IS a successful
      // source — the distinction between "looked and found nothing" and "did
      // not look" is the whole reason this accounting exists.
      successful.push(sourceId);
    } catch (err) {
      failSource([sourceId], "WRITE", err);
    }
  }

  // -------------------------------------------------------------------------
  // SEARCH INDEX RECONCILIATION — one workspace-level advisory condition.
  //
  // Registered for a release with no producer at all, on the reasoning that
  // index health belonged to the Search run authority. It did, and that
  // authority writes a terminal `GovernanceReconciliationRun` PER WORKSPACE,
  // which is exactly what a producer needs. Reading it is the producer.
  // -------------------------------------------------------------------------
  {
    const sourceId = "search.indexing_failure";
    attempted.push(sourceId);
    try {
      const outcome = await syncSearchIndexConditions({ teamId: ctx.teamId });
      if (outcome.active) {
        recorded += 1;
        rules.push("search:index_reconciliation");
      }
      // A COMPLETED READ, INCLUDING THE ONE THAT FOUND NO RUN.
      //
      // "The reconciler has not concluded anything for this workspace yet" is
      // an ANSWER the run table gave, not a failure to reach it — and most
      // workspaces are in exactly that state, so treating it as a source
      // failure would log an error per workspace per sweep and mean nothing.
      //
      // The distinction still exists where it decides something: the PROBE
      // answers UNKNOWN for the same state, so an absent run can never close
      // an open condition. Discovery opens none and closes none, which is the
      // correct behaviour for an absence.
      if (outcome.unknown) rules.push("search:index_never_reconciled");
      successful.push(sourceId);
    } catch (err) {
      // WRITE, not UNKNOWN. `syncSearchIndexConditions` handles its own READ
      // failures — an unreadable index returns `unknown` rather than throwing,
      // because "we could not measure it" must not open or close anything. So
      // anything that escapes to here happened while RECORDING the condition,
      // and naming the stage correctly is what lets a schema fault be told
      // apart from a source that could not be observed.
      failSource([sourceId], "WRITE", err);
    }
  }

  // -------------------------------------------------------------------------
  // IMMUTABLE STORAGE DRIFT — recovery only.
  //
  // The Worker's reconciler OPENS these and never closed them, which was
  // survivable only because the source used to be operator-closable. It is
  // source truth now, so something has to read the reconciler's newest verdict
  // and close the conditions it has cleared — otherwise a source with no
  // Resolve control and no recovery sweep would be a permanently stuck row,
  // which is the failure this reclassification is accused of causing and must
  // not actually cause.
  //
  // DISCOVERY IS NOT THE PRODUCER HERE. This opens nothing; the reconciler
  // remains the only writer that raises an immutable-drift condition.
  // -------------------------------------------------------------------------
  {
    const sourceId = "storage.immutable_drift";
    attempted.push(sourceId);
    try {
      await sweepSourceTruthRecoveries({
        teamId: ctx.teamId,
        sourceId,
      });
      successful.push(sourceId);
    } catch (err) {
      failSource([sourceId], "SCAN", err);
    }
  }

  return {
    recorded,
    failed,
    rules,
    sources: {
      attempted,
      successful,
      failed: failedSources,
      truncated: truncatedSources,
      failures,
    },
  };
}
