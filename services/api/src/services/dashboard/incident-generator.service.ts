/**
 * Phase 32.8C — Operations Control Plane: Incident Generator.
 *
 * Scans real operational state (existing tables, no fabricated data) and
 * deterministically generates `OperationalIncident` rows when concrete
 * thresholds are crossed. Routes incident creation through the existing
 * `recordIncident` upsert which:
 *   - Dedups on `(teamId, fingerprint)` so the same condition collapses
 *     into one incident with `occurrenceCount` ticked on re-fire.
 *   - Escalates severity on re-fire if the new severity rank is higher.
 *   - Reopens RESOLVED/SUPPRESSED rows on fresh occurrence.
 *
 * Hard rules:
 *   - Every fingerprint corresponds to a REAL condition observed in the
 *     workspace's existing tables. NO fabricated incidents.
 *   - Generator failures NEVER block evidence / report / package /
 *     verify core flows. Every scan + write is wrapped in try/catch.
 *   - Bounded counts, bounded summaries, no raw payloads exposed.
 *   - This is the DASHBOARD-READ generator. It runs lazily; the worker
 *     remains the authoritative path for incidents that originate
 *     deep in the pipeline (e.g., worker.health_start_failed).
 */

import {
  type IncidentCategory,
  type IncidentSeverity,
} from "@proovra/shared";

import type { Prisma } from "@prisma/client";

import { prisma } from "../../db.js";
import { recordIncident } from "../observability/incident.service.js";
import { workspaceIncidentWhere } from "../observability/incident-scope.js";
import { syncEvidenceIntegrityConditions } from "../operations/evidence-integrity-conditions.service.js";
import {
  safeOperationsFailureCategory,
  workspaceEvidenceWhere,
  type OperationsSourceOutcome,
  type OperationsSourceStage,
} from "@proovra/shared-runtime";

// ---------- Thresholds — every one is real platform state -----------------

const REPORT_BACKLOG_HIGH = 20;
const REPORT_BACKLOG_CRITICAL = 100;
const PACKAGE_BACKLOG_HIGH = 20;
const PACKAGE_BACKLOG_CRITICAL = 100;
const STALE_REVIEW_HOURS = 72;
const STALE_REVIEW_HIGH_COUNT = 5;
const RETRY_STORM_OCCURRENCE_THRESHOLD = 5;
const TELEMETRY_STALE_MINUTES = 30;
const WORKER_HEARTBEAT_STALE_MINUTES = 15;
const UNSIGNED_FINALIZED_AGED_DAYS = 14;
const UNSIGNED_FINALIZED_HIGH_COUNT = 5;
const COORDINATION_STALE_DAYS = 21;
const COORDINATION_STALE_HIGH_COUNT = 10;

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

type Generated = {
  fingerprint: string;
  category: IncidentCategory;
  severity: IncidentSeverity;
  title: string;
  safeSummary: string;
  runbookSlug?: string | null;
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
    /** Exactly one entry per attempted source, carrying stage and cause. */
    outcomes: OperationsSourceOutcome[];
  };
};

export async function generateIncidentsForWorkspace(
  input: { teamId: string },
): Promise<WorkspaceDiscoveryResult> {
  const rules: string[] = [];
  let recorded = 0;
  let failed = 0;
  const attempted: string[] = [];
  const successful: string[] = [];
  const failedSources: string[] = [];
  const truncatedSources: string[] = [];
  const outcomes: OperationsSourceOutcome[] = [];

  /**
   * Record one source's result.
   *
   * THE DEFECT THIS CLOSES. The handlers below used to be a bare
   * `} catch { failedSources.push(id); }`: they recorded WHICH source gave way
   * and threw the reason on the floor. Production paid for it exactly once —
   * six sources failed, `safeFailureCategory` projected as null, and the only
   * way to learn the cause was to reproduce the database locally.
   *
   * Nothing derived from the exception reaches this record except a bounded
   * category from the shared categoriser; the message, the SQL and the row
   * contents never leave this function.
   */
  const note = (
    ids: string[],
    outcome: OperationsSourceOutcome["outcome"],
    stage: OperationsSourceStage | null = null,
    err?: unknown,
  ): void => {
    const category = outcome === "FAILED" ? safeOperationsFailureCategory(err) : null;
    // A schema mismatch, a permission denial and a constraint violation do not
    // clear on their own: telling an operator to retry them wastes the one
    // action the page offers. The transient classes DO retry usefully.
    const retryable =
      outcome === "FAILED" &&
      (category === "timeout" ||
        category === "database_unavailable" ||
        category === "queue_unavailable");
    for (const sourceId of ids) {
      outcomes.push({
        sourceId,
        outcome,
        stage: outcome === "FAILED" ? (stage ?? "UNKNOWN") : null,
        category,
        retryable,
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
    if (integrity.rowFailures > 0) {
      // Some records could not be turned into conditions while others could.
      // The source is NOT successful — its picture is a floor — but the rows
      // that DID work are recorded, which is the whole point of isolating them.
      failedSources.push(...INTEGRITY_SOURCE_IDS);
      note(INTEGRITY_SOURCE_IDS, "FAILED", "WRITE", integrity.firstRowError);
    } else if (!integrity.complete) {
      // Say so rather than reporting a tidy number over a bounded read. A
      // bounded read is not a complete one, and a workspace whose integrity
      // scan hit its limit must not be describable as clear.
      rules.push("evidence_integrity:scan_incomplete");
      truncatedSources.push(...INTEGRITY_SOURCE_IDS);
      note(INTEGRITY_SOURCE_IDS, "TRUNCATED");
    } else {
      successful.push(...INTEGRITY_SOURCE_IDS);
      note(INTEGRITY_SOURCE_IDS, "SUCCEEDED");
    }
  } catch (err) {
    failed += 1;
    failedSources.push(...INTEGRITY_SOURCE_IDS);
    // READ: the scan never got as far as a per-record write. This is the arm
    // production took — the population query named a column the database did
    // not have, so every record was invisible and `recorded` stayed 0.
    note(INTEGRITY_SOURCE_IDS, "FAILED", "READ", err);
  }

  // Each entry names the REGISTERED source it covers, so the run records
  // which sources it completed rather than only how many failed. Per-source
  // isolation is the load-bearing property: one broken scan marks ITS source
  // failed and the sweep continues, and a broken source can never fabricate a
  // clear result because its id is absent from `successful`.
  const RULES: Array<[string, () => Promise<Generated | null>]> = [
    ["pipeline.report_backlog", () => scanReportBacklog(ctx)],
    ["pipeline.package_backlog", () => scanPackageBacklog(ctx)],
    ["review.stale_workflows", () => scanStaleReviews(ctx)],
    ["queue.retry_storm", () => scanRetryStorms(ctx)],
    ["platform.telemetry_stale", () => scanStaleTelemetry(ctx)],
    ["platform.worker_heartbeat_stale", () => scanWorkerHeartbeatStaleness(ctx)],
    ["pipeline.signed_without_report_aged", () => scanUnsignedFinalizedAged(ctx)],
    ["coordination.backlog_stale", () => scanCoordinationBacklogStale(ctx)],
  ];

  for (const [sourceId, rule] of RULES) {
    attempted.push(sourceId);
    try {
      const result = await rule();
      if (result) {
        rules.push(result.fingerprint);
        try {
          await recordIncident({
            teamId: ctx.teamId,
            category: result.category,
            severity: result.severity,
            fingerprint: result.fingerprint,
            title: result.title,
            safeSummary: result.safeSummary,
            runbookSlug: result.runbookSlug ?? null,
          });
          recorded += 1;
          successful.push(sourceId);
          note([sourceId], "SUCCEEDED");
        } catch (err) {
          // The scan SAW the condition and the write failed. The source is not
          // successful: its condition exists and is not recorded, which is
          // exactly the state that must stop a clear assertion.
          failed += 1;
          failedSources.push(sourceId);
          // WRITE, not READ. The population was legible and the projection was
          // formed; what gave way was persisting it. That distinction decides
          // whether an operator looks at the database schema or at a
          // constraint, so it is recorded rather than flattened.
          note([sourceId], "FAILED", "WRITE", err);
        }
      } else {
        // Scanned, nothing above threshold. That IS a successful source — the
        // distinction between "looked and found nothing" and "did not look" is
        // the whole reason this accounting exists.
        successful.push(sourceId);
        note([sourceId], "SUCCEEDED");
      }
    } catch (err) {
      failed += 1;
      failedSources.push(sourceId);
      note([sourceId], "FAILED", "READ", err);
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
      outcomes,
    },
  };
}

// ---------- Per-rule scanners ---------------------------------------------

async function scanReportBacklog(
  ctx: GenerationContext,
): Promise<Generated | null> {
  const backlog = await prisma.evidence.count({
    where: {
      AND: [ctx.evidenceWhere, { status: "SIGNED", latestReportVersion: null }],
    },
  });
  if (backlog < REPORT_BACKLOG_HIGH) return null;
  const severity: IncidentSeverity =
    backlog >= REPORT_BACKLOG_CRITICAL ? "CRITICAL" : "HIGH";
  return {
    fingerprint: `dashboard:pipeline:report_backlog:${ctx.teamId}`,
    category: "REPORT" as IncidentCategory,
    severity,
    title: `Report backlog above threshold (${backlog})`,
    safeSummary: `${backlog} signed evidence rows have no generated report. Threshold: HIGH at ${REPORT_BACKLOG_HIGH}, CRITICAL at ${REPORT_BACKLOG_CRITICAL}. Source: Evidence(status=SIGNED, latestReportVersion=null).`,
    runbookSlug: "report-pipeline",
  };
}

async function scanPackageBacklog(
  ctx: GenerationContext,
): Promise<Generated | null> {
  const backlog = await prisma.evidence.count({
    where: {
      AND: [
        ctx.evidenceWhere,
        { status: "REPORTED", verificationPackageVersion: null },
      ],
    },
  });
  if (backlog < PACKAGE_BACKLOG_HIGH) return null;
  const severity: IncidentSeverity =
    backlog >= PACKAGE_BACKLOG_CRITICAL ? "CRITICAL" : "HIGH";
  return {
    fingerprint: `dashboard:pipeline:package_backlog:${ctx.teamId}`,
    category: "PACKAGE" as IncidentCategory,
    severity,
    title: `Verification package backlog above threshold (${backlog})`,
    safeSummary: `${backlog} reported evidence rows have no verification package. Threshold: HIGH at ${PACKAGE_BACKLOG_HIGH}, CRITICAL at ${PACKAGE_BACKLOG_CRITICAL}. Source: Evidence(status=REPORTED, verificationPackageVersion=null).`,
    runbookSlug: "package-pipeline",
  };
}

async function scanStaleReviews(
  ctx: GenerationContext,
): Promise<Generated | null> {
  const since = new Date(
    Date.now() - STALE_REVIEW_HOURS * 60 * 60 * 1000,
  );
  const stale = await prisma.evidenceReviewWorkflow.count({
    where: {
      // WORKSPACE-SCOPE CONVERGENCE — scoped through the Evidence the workflow
      // belongs to, not through the workflow's own `team_id`.
      //
      // PROVEN, not assumed: `EvidenceReviewWorkflow.team_id` is nullable AND
      // its writer (`reviewer-workflow.service.ts`) stores
      // `params.teamId ?? null`, so every workflow created without an explicit
      // workspace lands with a NULL that no strict predicate can see. The
      // model has no owner column either, so the NULL arm could not be
      // owner-bound even if it were added. The Evidence row IS the ownership
      // authority here — the relation is `@unique` — so reading through it is
      // both correct and one authority fewer.
      evidence: ctx.evidenceWhere,
      status: { in: ["ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
      updatedAt: { lt: since },
    },
  });
  if (stale < STALE_REVIEW_HIGH_COUNT) return null;
  return {
    fingerprint: `dashboard:review:stale_assignments:${ctx.teamId}`,
    category: "WORKER" as IncidentCategory,
    severity: stale >= STALE_REVIEW_HIGH_COUNT * 3 ? "HIGH" : "WARNING",
    title: `Stale reviewer assignments (${stale})`,
    safeSummary: `${stale} assigned/in-review/needs-info review workflows have not been touched in ${STALE_REVIEW_HOURS}h+. Source: EvidenceReviewWorkflow.updatedAt.`,
    runbookSlug: "reviewer-ops",
  };
}

async function scanRetryStorms(
  ctx: GenerationContext,
): Promise<Generated | null> {
  // Re-derive from existing OperationalIncident rows so a retry storm
  // surfaces here even when the worker-side recorder is not the trigger.
  const stormCount = await prisma.operationalIncident.count({
    where: {
      // WORKSPACE-SCOPE CONVERGENCE — was
      // `OR: [{ teamId: ctx.teamId }, { teamId: null }]`. A retry storm in a
      // DELETED workspace would have counted toward this one's threshold,
      // because deleting a workspace rewrites its incidents' team_id to NULL.
      ...workspaceIncidentWhere(ctx.teamId),
      status: { in: ["OPEN", "ACKNOWLEDGED"] },
      occurrenceCount: { gte: RETRY_STORM_OCCURRENCE_THRESHOLD },
    },
  });
  if (stormCount === 0) return null;
  return {
    fingerprint: `dashboard:reliability:retry_storms:${ctx.teamId}`,
    category: "WORKER" as IncidentCategory,
    severity: stormCount >= 3 ? "HIGH" : "WARNING",
    title: `Retry storm pattern detected (${stormCount} repeat incidents)`,
    safeSummary: `${stormCount} active incidents are recurring with occurrenceCount >= ${RETRY_STORM_OCCURRENCE_THRESHOLD}. Source: OperationalIncident.occurrenceCount.`,
    runbookSlug: "retry-storm",
  };
}

async function scanStaleTelemetry(
  ctx: GenerationContext,
): Promise<Generated | null> {
  // QueueTelemetrySnapshot is workspace-scoped (teamId nullable). A
  // freshest sample older than the threshold flags telemetry as stale.
  const recent = await prisma.queueTelemetrySnapshot.findFirst({
    where: { teamId: ctx.teamId },
    orderBy: { sampledAtUtc: "desc" },
    select: { sampledAtUtc: true },
  });
  if (!recent) return null; // healthy_empty — no rows yet is not a problem
  const ageMinutes =
    (Date.now() - recent.sampledAtUtc.getTime()) / 60_000;
  if (ageMinutes < TELEMETRY_STALE_MINUTES) return null;
  return {
    fingerprint: `dashboard:telemetry:queue_stale:${ctx.teamId}`,
    category: "WORKER" as IncidentCategory,
    severity: ageMinutes > TELEMETRY_STALE_MINUTES * 4 ? "HIGH" : "WARNING",
    title: `Queue telemetry sampler delayed (${Math.round(ageMinutes)}m)`,
    safeSummary: `Latest QueueTelemetrySnapshot row for this workspace is ${Math.round(ageMinutes)} minutes old. Worker remains operational; the sampler may be delayed or paused. Threshold: ${TELEMETRY_STALE_MINUTES} minutes.`,
    runbookSlug: "telemetry-sampler",
  };
}

async function scanWorkerHeartbeatStaleness(
  _ctx: GenerationContext,
): Promise<Generated | null> {
  // WorkerTelemetrySnapshot is process-global (no team scope). Scan the
  // freshest row per workerKind = WORKER and report if it's older than
  // the threshold.
  const recent = await prisma.workerTelemetrySnapshot.findFirst({
    where: { workerKind: "WORKER" },
    orderBy: { heartbeatAtUtc: "desc" },
    select: { heartbeatAtUtc: true, status: true },
  });
  if (!recent) return null;
  const ageMinutes =
    (Date.now() - recent.heartbeatAtUtc.getTime()) / 60_000;
  if (ageMinutes < WORKER_HEARTBEAT_STALE_MINUTES) return null;
  // Note: this is a global condition; we attach it to the team for
  // dashboard visibility but the fingerprint is workspace-scoped so
  // every workspace surfaces the condition independently.
  return {
    fingerprint: `dashboard:worker:heartbeat_stale:${_ctx.teamId}`,
    category: "WORKER" as IncidentCategory,
    severity:
      ageMinutes > WORKER_HEARTBEAT_STALE_MINUTES * 4 ? "CRITICAL" : "HIGH",
    title: `Worker heartbeat stale (${Math.round(ageMinutes)}m)`,
    safeSummary: `Last persisted worker heartbeat is ${Math.round(ageMinutes)} minutes old (status=${recent.status}). Threshold: ${WORKER_HEARTBEAT_STALE_MINUTES} minutes. The worker process or its DB connection may be down.`,
    runbookSlug: "worker-heartbeat",
  };
}

async function scanUnsignedFinalizedAged(
  ctx: GenerationContext,
): Promise<Generated | null> {
  // "Unsigned finalized" = status UPLOADED (upload complete, signing
  // pending) where createdAt is older than the cutoff. We use createdAt
  // as the age signal because the Evidence model does not record a
  // separate finalization timestamp — the status transition is the
  // signal.
  const cutoff = new Date(
    Date.now() - UNSIGNED_FINALIZED_AGED_DAYS * 24 * 60 * 60 * 1000,
  );
  const aged = await prisma.evidence.count({
    where: {
      AND: [ctx.evidenceWhere, { status: "UPLOADED", createdAt: { lt: cutoff } }],
    },
  });
  if (aged < UNSIGNED_FINALIZED_HIGH_COUNT) return null;
  return {
    fingerprint: `dashboard:integrity:unsigned_aged:${ctx.teamId}`,
    category: "GOVERNANCE" as IncidentCategory,
    severity: aged >= UNSIGNED_FINALIZED_HIGH_COUNT * 3 ? "HIGH" : "WARNING",
    title: `Unsigned evidence aged > ${UNSIGNED_FINALIZED_AGED_DAYS}d (${aged})`,
    safeSummary: `${aged} evidence rows are status=UPLOADED but unsigned and older than ${UNSIGNED_FINALIZED_AGED_DAYS} days. Source: Evidence(status=UPLOADED, createdAt < cutoff). Threshold: HIGH at ${UNSIGNED_FINALIZED_HIGH_COUNT}.`,
    runbookSlug: "signing-pipeline",
  };
}

async function scanCoordinationBacklogStale(
  ctx: GenerationContext,
): Promise<Generated | null> {
  const cutoff = new Date(
    Date.now() - COORDINATION_STALE_DAYS * 24 * 60 * 60 * 1000,
  );
  // Unresolved reviewer comments + annotations + case comments older
  // than the cutoff. Each query is wrapped — a single failure degrades
  // that count to 0 without breaking the rule.
  const [staleComments, staleAnnotations, staleCaseComments] = await Promise.all([
    prisma.evidenceReviewerComment
      .count({
        where: {
          // Scoped through the SAME canonical evidence filter: a comment on a
          // personal workspace's legacy NULL-team record must still count.
          evidence: ctx.evidenceWhere,
          resolvedAtUtc: null,
          createdAt: { lt: cutoff },
        },
      })
      .catch(() => 0),
    prisma.evidenceAnnotation
      .count({
        where: {
          evidence: ctx.evidenceWhere,
          resolvedAtUtc: null,
          createdAt: { lt: cutoff },
        },
      })
      .catch(() => 0),
    prisma.caseComment
      .count({
        where: {
          teamId: ctx.teamId,
          resolvedAtUtc: null,
          createdAt: { lt: cutoff },
        },
      })
      .catch(() => 0),
  ]);
  const total = staleComments + staleAnnotations + staleCaseComments;
  if (total < COORDINATION_STALE_HIGH_COUNT) return null;
  return {
    fingerprint: `dashboard:coordination:stale_backlog:${ctx.teamId}`,
    category: "GOVERNANCE" as IncidentCategory,
    severity:
      total >= COORDINATION_STALE_HIGH_COUNT * 3 ? "HIGH" : "WARNING",
    title: `Coordination backlog stale > ${COORDINATION_STALE_DAYS}d (${total} items)`,
    safeSummary: `${staleComments} reviewer comments, ${staleAnnotations} annotations, ${staleCaseComments} case comments unresolved for more than ${COORDINATION_STALE_DAYS} days. Threshold: HIGH at ${COORDINATION_STALE_HIGH_COUNT}.`,
    runbookSlug: "coordination-backlog",
  };
}
