/**
 * Phase E4 — Bounded operational analytics service.
 *
 * Real data only. Every metric is source-traceable. Bounded queries.
 * Team-scoped. No fake counters. No AI / no predictions / no truth
 * scores / no legal-admissibility conclusions.
 *
 * Hard rules (pinned by `phase-e4-analytics.test.ts`):
 *
 *   - Every public function returns an `AnalyticsEnvelope` with:
 *       { generatedAt, window, sourceTrace, degradedSources, metrics }
 *   - `sourceTrace` lists every Prisma model + filter shape the
 *     metrics came from. Tests verify it is non-empty.
 *   - `window.days` is bounded by `ANALYTICS_MAX_WINDOW_DAYS = 180`
 *     and defaults to `ANALYTICS_DEFAULT_WINDOW_DAYS = 30`.
 *   - Queries are all `count` / `groupBy` / `findMany(take: limit)`.
 *     No unbounded scans. No `findMany` without `where + teamId`.
 *   - On any source failure, the metric value is `null` and the
 *     source name is pushed to `degradedSources`. The whole envelope
 *     still returns 200 with the partial result.
 *   - Personal workspace gets simplified metrics (a small subset);
 *     team / organization workspace gets the operational depth.
 *
 * Public functions:
 *   - getOperationsOverview(input)
 *   - getReviewerAnalytics(input)
 *   - getGovernanceAnalytics(input)
 *   - getAutomationAnalytics(input)
 *   - getArtifactReadinessAnalytics(input)
 */

import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { holdInReach, type ViewerReach } from "../access/record-reach.js";
import { activeEscalationWhere, openReviewWhere } from "../reviewer-ops/review-count-definitions.js";
import {
  workspaceCaseWhere,
  workspaceEvidenceWhere,
} from "@proovra/shared-runtime";

import { primaryPublishedPackageWhere } from "@proovra/shared-runtime/reports";
// ---------------------------------------------------------------------------
// Bounded window
// ---------------------------------------------------------------------------

export const ANALYTICS_DEFAULT_WINDOW_DAYS = 30;
export const ANALYTICS_MAX_WINDOW_DAYS = 180;
export const ANALYTICS_MIN_WINDOW_DAYS = 1;

export type AnalyticsScope = "SINGLE_OCCUPANT" | "SHARED";

export type AnalyticsInput = {
  teamId: string;
  scope: AnalyticsScope;
  /**
   * B7B-F03 (free-audit 0ea0): the reader's record reach
   * (`viewerReachInWorkspace`). Counts must not reveal the existence or
   * volume of records a restricted case closes to them, exactly as the
   * command center and governance control plane already do. Absent only for
   * a machine/system caller.
   */
  reach?: ViewerReach;
  windowDays?: number;
  prisma?: PrismaClient;
  nowMs?: number;
};

export type AnalyticsWindow = {
  days: number;
  start: string; // ISO
  end: string; // ISO
};

export type SourceTrace = ReadonlyArray<{
  metric: string;
  source: string;
  filter: string;
  windowed: boolean;
}>;

export type AnalyticsEnvelope<TMetrics> = {
  generatedAt: string;
  window: AnalyticsWindow;
  sourceTrace: SourceTrace;
  degradedSources: ReadonlyArray<string>;
  metrics: TMetrics;
};

function resolveWindow(input: AnalyticsInput): AnalyticsWindow {
  const nowMs = input.nowMs ?? Date.now();
  const days = clampWindow(input.windowDays);
  return {
    days,
    start: new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString(),
    end: new Date(nowMs).toISOString(),
  };
}

export function clampWindow(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return ANALYTICS_DEFAULT_WINDOW_DAYS;
  }
  return Math.max(
    ANALYTICS_MIN_WINDOW_DAYS,
    Math.min(ANALYTICS_MAX_WINDOW_DAYS, Math.floor(value)),
  );
}

/**
 * Wrap a Prisma query so the whole envelope never throws. On failure
 * the metric resolves to `null` and the source name is recorded in
 * `degradedSources`. The wrapper is intentionally generic — callers
 * pass a function that returns the metric value.
 */
/**
 * B7B-F03 (free-audit 0ea0, residual) — an escalation names the record it
 * escalates (nullable `evidenceId`); one closed to the reader is that
 * record's row and is not counted.
 */
function escalationInReach(reach: ViewerReach | undefined): Prisma.ReviewEscalationWhereInput {
  const ids = reach?.hidden.evidenceIds ?? [];
  return ids.length === 0 ? {} : { OR: [{ evidenceId: null }, { evidenceId: { notIn: ids } }] };
}

async function safe<T>(
  promise: Promise<T>,
  source: string,
  degraded: string[],
): Promise<T | null> {
  try {
    return await promise;
  } catch {
    if (!degraded.includes(source)) degraded.push(source);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 1. Operations overview
// ---------------------------------------------------------------------------

export type OperationsOverviewMetrics = {
  evidenceCreated: number | null;
  evidenceFinalized: number | null;
  openCases: number | null;
  openReviewWorkflows: number | null;
  openEscalations: number | null;
  /** Only meaningful for team scope; null in personal mode. */
  reviewerCount: number | null;
};

export async function getOperationsOverview(
  input: AnalyticsInput,
): Promise<AnalyticsEnvelope<OperationsOverviewMetrics>> {
  const prisma = input.prisma ?? defaultPrisma;
  // WORKSPACE-SCOPE CONVERGENCE — the canonical workspace populations,
  // resolved once for every query below.
  //
  // A strict `teamId` equality omitted a personal workspace's legacy
  // NULL-team rows and reported the smaller number as if it were the whole
  // population — so this page told a personal-workspace operator they had
  // captured less evidence than they actually had.
  //
  // Resolved through THIS function's client, not the module default: the
  // caller may inject one, and a scope resolved on a different connection
  // than the query it bounds is a scope that can describe a different
  // database.
  const [baseScope, baseCaseScope] = await Promise.all([
    workspaceEvidenceWhere(input.teamId, prisma),
    workspaceCaseWhere(input.teamId, prisma),
  ]);
  const scope = input.reach ? { AND: [baseScope, input.reach.evidence] } : baseScope;
  const caseScope = input.reach ? { AND: [baseCaseScope, input.reach.cases] } : baseCaseScope;
  const window = resolveWindow(input);
  const windowStart = new Date(window.start);
  const degraded: string[] = [];

  const sourceTrace: SourceTrace = [
    // The filter strings are operator-facing provenance: they must describe
    // the query that actually ran. "workspace scope" is the canonical
    // population (strict for a shared workspace, owner-bound NULL-team rows
    // included for a personal one) rather than a bare column equality.
    { metric: "evidenceCreated", source: "Evidence", filter: "workspace scope + createdAt>=window", windowed: true },
    { metric: "evidenceFinalized", source: "Evidence", filter: "workspace scope + status=REPORTED + createdAt>=window", windowed: true },
    { metric: "openCases", source: "Case", filter: "workspace scope + status=OPEN", windowed: false },
    { metric: "openReviewWorkflows", source: "EvidenceReviewWorkflow", filter: "evidence in workspace scope + open review (not approved, rejected or archived)", windowed: false },
    { metric: "openEscalations", source: "ReviewEscalation", filter: "teamId + status=OPEN", windowed: false },
    { metric: "reviewerCount", source: "TeamMember", filter: "teamId + role in (ADMIN, OWNER, MEMBER)", windowed: false },
  ];

  const [
    evidenceCreated,
    evidenceFinalized,
    openCases,
    openReviewWorkflows,
    openEscalations,
    reviewerCount,
  ] = await Promise.all([
    safe(
      prisma.evidence.count({
        where: { AND: [scope], createdAt: { gte: windowStart } },
      }),
      "Evidence",
      degraded,
    ),
    safe(
      prisma.evidence.count({
        where: {
          AND: [scope],
          createdAt: { gte: windowStart },
          // EvidenceStatus.REPORTED is the canonical "finalized" state
          // (artifact generated). String match to avoid enum import.
          status: "REPORTED" as never,
        },
      }),
      "Evidence",
      degraded,
    ),
    safe(
      prisma.case.count({
        where: { AND: [caseScope], status: "OPEN" as never },
      }),
      "Case",
      degraded,
    ),
    safe(
      prisma.evidenceReviewWorkflow.count({
        where: {
          // WORKSPACE-SCOPE CONVERGENCE — scoped through the Evidence the
          // workflow belongs to, not through its own `team_id`.
          //
          // `EvidenceReviewWorkflow.team_id` is nullable AND its writer
          // (`reviewer-workflow.service.ts`) stores `params.teamId ?? null`,
          // so a workflow created without an explicit workspace lands with a
          // NULL that no strict predicate can see. The Evidence row is the
          // ownership authority for a workflow — the relation is `@unique` —
          // so reading through it is both correct and one authority fewer.
          evidence: scope,
          // Round 2 (C H-3): THE open-review definition (rejected reviews are
          // finished too; this used to count them as open).
          ...openReviewWhere(),
        },
      }),
      "EvidenceReviewWorkflow",
      degraded,
    ),
    safe(
      prisma.reviewEscalation.count({
        where: { teamId: input.teamId, ...escalationInReach(input.reach), ...activeEscalationWhere() },
      }),
      "ReviewEscalation",
      degraded,
    ),
    input.scope === "SINGLE_OCCUPANT"
      ? Promise.resolve(null)
      : safe(
          prisma.teamMember.count({
            where: {
              teamId: input.teamId,
              // PHASE 12 REMEDIATION (2026-08-06) — "can act on reviews"
              // requires ACTIVE membership, not merely a stored role.
              status: "ACTIVE",
              // Members who can act on reviews — VIEWER cannot.
              role: { in: ["OWNER", "ADMIN", "MEMBER"] as never[] },
            },
          }),
          "TeamMember",
          degraded,
        ),
  ]);

  return {
    generatedAt: new Date(input.nowMs ?? Date.now()).toISOString(),
    window,
    sourceTrace,
    degradedSources: degraded,
    metrics: {
      evidenceCreated,
      evidenceFinalized,
      openCases,
      openReviewWorkflows,
      openEscalations,
      reviewerCount,
    },
  };
}

// ---------------------------------------------------------------------------
// 2. Reviewer analytics
// ---------------------------------------------------------------------------

export type ReviewerAnalyticsMetrics = {
  /** Total active review workflows for the team. */
  activeReviews: number | null;
  /** Workflows currently assigned to a reviewer. */
  assignedReviews: number | null;
  /** Workflows with status NOT_STARTED / IN_REVIEW past their SLA. */
  overdueReviews: number | null;
  /** Open escalations as a separate signal. */
  openEscalations: number | null;
  /** Resolved escalations in window. */
  resolvedEscalationsInWindow: number | null;
};

export async function getReviewerAnalytics(
  input: AnalyticsInput,
): Promise<AnalyticsEnvelope<ReviewerAnalyticsMetrics>> {
  const prisma = input.prisma ?? defaultPrisma;
  const window = resolveWindow(input);
  const windowStart = new Date(window.start);
  const degraded: string[] = [];

  const sourceTrace: SourceTrace = [
    { metric: "activeReviews", source: "EvidenceReviewWorkflow", filter: "teamId + open review (not approved, rejected or archived)", windowed: false },
    { metric: "assignedReviews", source: "EvidenceReviewWorkflow", filter: "teamId + open review + assignedToUserId not null", windowed: false },
    { metric: "overdueReviews", source: "EvidenceReviewWorkflow", filter: "teamId + open review + stored SLA overdue", windowed: false },
    { metric: "openEscalations", source: "ReviewEscalation", filter: "teamId + active escalation (open, acknowledged, reassigned)", windowed: false },
    { metric: "resolvedEscalationsInWindow", source: "ReviewEscalation", filter: "teamId + status=RESOLVED + updatedAt>=window", windowed: true },
  ];

  // Round 2 (C H-3): "active" is THE open-review definition. The old list left
  // QUEUED, ASSIGNED, RESPONSE_RECEIVED and REOPENED reviews out.
  const open = openReviewWhere();
  // B7B-F03: a workflow of a record closed to the reader is not counted.
  const workflowReach =
    input.reach && input.reach.hidden.evidenceIds.length > 0
      ? { evidenceId: { notIn: input.reach.hidden.evidenceIds } }
      : {};

  const [
    activeReviews,
    assignedReviews,
    overdueReviews,
    openEscalations,
    resolvedEscalationsInWindow,
  ] = await Promise.all([
    safe(
      prisma.evidenceReviewWorkflow.count({
        where: {
          teamId: input.teamId,
          ...workflowReach,
          ...open,
        },
      }),
      "EvidenceReviewWorkflow",
      degraded,
    ),
    safe(
      prisma.evidenceReviewWorkflow.count({
        where: {
          teamId: input.teamId,
          ...workflowReach,
          ...open,
          assignedToUserId: { not: null },
        },
      }),
      "EvidenceReviewWorkflow",
      degraded,
    ),
    safe(
      prisma.evidenceReviewWorkflow.count({
        where: {
          teamId: input.teamId,
          ...workflowReach,
          ...open,
          slaStatus: { in: ["OVERDUE", "BREACHED"] },
        },
      }),
      "EvidenceReviewWorkflow",
      degraded,
    ),
    safe(
      prisma.reviewEscalation.count({
        where: { teamId: input.teamId, ...escalationInReach(input.reach), ...activeEscalationWhere() },
      }),
      "ReviewEscalation",
      degraded,
    ),
    safe(
      prisma.reviewEscalation.count({
        where: {
          teamId: input.teamId,
          ...escalationInReach(input.reach),
          status: "RESOLVED",
          updatedAt: { gte: windowStart },
        },
      }),
      "ReviewEscalation",
      degraded,
    ),
  ]);

  return {
    generatedAt: new Date(input.nowMs ?? Date.now()).toISOString(),
    window,
    sourceTrace,
    degradedSources: degraded,
    metrics: {
      activeReviews,
      assignedReviews,
      overdueReviews,
      openEscalations,
      resolvedEscalationsInWindow,
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Governance analytics
// ---------------------------------------------------------------------------

export type GovernanceAnalyticsMetrics = {
  activeLegalHolds: number | null;
  activeCaseLegalHolds: number | null;
  legalHoldsPlacedInWindow: number | null;
  legalHoldsReleasedInWindow: number | null;
};

export async function getGovernanceAnalytics(
  input: AnalyticsInput,
): Promise<AnalyticsEnvelope<GovernanceAnalyticsMetrics>> {
  const prisma = input.prisma ?? defaultPrisma;
  const window = resolveWindow(input);
  const windowStart = new Date(window.start);
  const degraded: string[] = [];
  // B7B-F03: a hold naming a record or case closed to the reader is not counted.
  const holdReach = input.reach ? { AND: holdInReach(input.reach) } : {};

  const sourceTrace: SourceTrace = [
    { metric: "activeLegalHolds", source: "EvidenceLegalHold", filter: "teamId + status=ACTIVE", windowed: false },
    { metric: "activeCaseLegalHolds", source: "CaseLegalHold", filter: "teamId + status=ACTIVE", windowed: false },
    { metric: "legalHoldsPlacedInWindow", source: "EvidenceLegalHold", filter: "teamId + placedAtUtc>=window", windowed: true },
    { metric: "legalHoldsReleasedInWindow", source: "EvidenceLegalHold", filter: "teamId + releasedAtUtc>=window", windowed: true },
  ];

  const [
    activeLegalHolds,
    activeCaseLegalHolds,
    legalHoldsPlacedInWindow,
    legalHoldsReleasedInWindow,
  ] = await Promise.all([
    safe(
      prisma.evidenceLegalHold.count({
        where: { teamId: input.teamId, ...holdReach, status: "ACTIVE" },
      }),
      "EvidenceLegalHold",
      degraded,
    ),
    safe(
      prisma.evidenceLegalHold.count({
        // P12.3 canonical-only (scope='CASE').
        where: { scope: "CASE", teamId: input.teamId, ...holdReach, status: "ACTIVE" },
      }),
      "CaseLegalHold",
      degraded,
    ),
    safe(
      prisma.evidenceLegalHold.count({
        where: { teamId: input.teamId, ...holdReach, placedAtUtc: { gte: windowStart } },
      }),
      "EvidenceLegalHold",
      degraded,
    ),
    safe(
      prisma.evidenceLegalHold.count({
        where: {
          teamId: input.teamId,
          ...holdReach,
          releasedAtUtc: { gte: windowStart, not: null },
        } as never,
      }),
      "EvidenceLegalHold",
      degraded,
    ),
  ]);

  return {
    generatedAt: new Date(input.nowMs ?? Date.now()).toISOString(),
    window,
    sourceTrace,
    degradedSources: degraded,
    metrics: {
      activeLegalHolds,
      activeCaseLegalHolds,
      legalHoldsPlacedInWindow,
      legalHoldsReleasedInWindow,
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Automation analytics
// ---------------------------------------------------------------------------

export type AutomationAnalyticsMetrics = {
  enabledRules: number | null;
  runsInWindow: number | null;
  runsSucceededInWindow: number | null;
  runsFailedInWindow: number | null;
  runsSkippedInWindow: number | null;
  webhookDeliveriesInWindow: number | null;
  webhookDeliveriesSucceededInWindow: number | null;
  webhookDeliveriesFailedInWindow: number | null;
  webhookDeliveriesRetryScheduled: number | null;
  webhookDeliveriesRetryExhaustedInWindow: number | null;
  autoDisabledDestinations: number | null;
};

export async function getAutomationAnalytics(
  input: AnalyticsInput,
): Promise<AnalyticsEnvelope<AutomationAnalyticsMetrics>> {
  const prisma = input.prisma ?? defaultPrisma;
  const window = resolveWindow(input);
  const windowStart = new Date(window.start);
  const degraded: string[] = [];

  const sourceTrace: SourceTrace = [
    { metric: "enabledRules", source: "AutomationRule", filter: "teamId + enabled=true", windowed: false },
    { metric: "runsInWindow", source: "AutomationRun", filter: "teamId + createdAt>=window", windowed: true },
    { metric: "runsSucceededInWindow", source: "AutomationRun", filter: "teamId + status=SUCCEEDED + createdAt>=window", windowed: true },
    { metric: "runsFailedInWindow", source: "AutomationRun", filter: "teamId + status=FAILED + createdAt>=window", windowed: true },
    { metric: "runsSkippedInWindow", source: "AutomationRun", filter: "teamId + status=SKIPPED + createdAt>=window", windowed: true },
    { metric: "webhookDeliveriesInWindow", source: "AutomationWebhookDelivery", filter: "teamId + createdAt>=window", windowed: true },
    { metric: "webhookDeliveriesSucceededInWindow", source: "AutomationWebhookDelivery", filter: "teamId + status=SUCCEEDED + createdAt>=window", windowed: true },
    { metric: "webhookDeliveriesFailedInWindow", source: "AutomationWebhookDelivery", filter: "teamId + status=FAILED + createdAt>=window", windowed: true },
    { metric: "webhookDeliveriesRetryScheduled", source: "AutomationWebhookDelivery", filter: "teamId + status=RETRY_SCHEDULED", windowed: false },
    { metric: "webhookDeliveriesRetryExhaustedInWindow", source: "AutomationWebhookDelivery", filter: "teamId + status=RETRY_EXHAUSTED + createdAt>=window", windowed: true },
    { metric: "autoDisabledDestinations", source: "AutomationWebhookDestination", filter: "teamId + autoDisabledAt not null", windowed: false },
  ];

  const [
    enabledRules,
    runsInWindow,
    runsSucceededInWindow,
    runsFailedInWindow,
    runsSkippedInWindow,
    webhookDeliveriesInWindow,
    webhookDeliveriesSucceededInWindow,
    webhookDeliveriesFailedInWindow,
    webhookDeliveriesRetryScheduled,
    webhookDeliveriesRetryExhaustedInWindow,
    autoDisabledDestinations,
  ] = await Promise.all([
    safe(prisma.automationRule.count({ where: { teamId: input.teamId, enabled: true } }), "AutomationRule", degraded),
    safe(prisma.automationRun.count({ where: { teamId: input.teamId, createdAt: { gte: windowStart } } }), "AutomationRun", degraded),
    safe(prisma.automationRun.count({ where: { teamId: input.teamId, status: "SUCCEEDED", createdAt: { gte: windowStart } } }), "AutomationRun", degraded),
    safe(prisma.automationRun.count({ where: { teamId: input.teamId, status: "FAILED", createdAt: { gte: windowStart } } }), "AutomationRun", degraded),
    safe(prisma.automationRun.count({ where: { teamId: input.teamId, status: "SKIPPED", createdAt: { gte: windowStart } } }), "AutomationRun", degraded),
    safe(prisma.automationWebhookDelivery.count({ where: { teamId: input.teamId, createdAt: { gte: windowStart } } }), "AutomationWebhookDelivery", degraded),
    safe(prisma.automationWebhookDelivery.count({ where: { teamId: input.teamId, status: "SUCCEEDED", createdAt: { gte: windowStart } } }), "AutomationWebhookDelivery", degraded),
    safe(prisma.automationWebhookDelivery.count({ where: { teamId: input.teamId, status: "FAILED", createdAt: { gte: windowStart } } }), "AutomationWebhookDelivery", degraded),
    safe(prisma.automationWebhookDelivery.count({ where: { teamId: input.teamId, status: "RETRY_SCHEDULED" } }), "AutomationWebhookDelivery", degraded),
    safe(prisma.automationWebhookDelivery.count({ where: { teamId: input.teamId, status: "RETRY_EXHAUSTED", createdAt: { gte: windowStart } } }), "AutomationWebhookDelivery", degraded),
    safe(prisma.automationWebhookDestination.count({ where: { teamId: input.teamId, autoDisabledAt: { not: null } } }), "AutomationWebhookDestination", degraded),
  ]);

  return {
    generatedAt: new Date(input.nowMs ?? Date.now()).toISOString(),
    window,
    sourceTrace,
    degradedSources: degraded,
    metrics: {
      enabledRules,
      runsInWindow,
      runsSucceededInWindow,
      runsFailedInWindow,
      runsSkippedInWindow,
      webhookDeliveriesInWindow,
      webhookDeliveriesSucceededInWindow,
      webhookDeliveriesFailedInWindow,
      webhookDeliveriesRetryScheduled,
      webhookDeliveriesRetryExhaustedInWindow,
      autoDisabledDestinations,
    },
  };
}

// ---------------------------------------------------------------------------
// 5. Artifact readiness analytics
// ---------------------------------------------------------------------------

export type ArtifactReadinessAnalyticsMetrics = {
  reportsGeneratedInWindow: number | null;
  packagesGeneratedInWindow: number | null;
};

export async function getArtifactReadinessAnalytics(
  input: AnalyticsInput,
): Promise<AnalyticsEnvelope<ArtifactReadinessAnalyticsMetrics>> {
  const prisma = input.prisma ?? defaultPrisma;
  const window = resolveWindow(input);
  const windowStart = new Date(window.start);
  const degraded: string[] = [];

  const sourceTrace: SourceTrace = [
    { metric: "reportsGeneratedInWindow", source: "Report", filter: "evidence.teamId + generatedAtUtc>=window", windowed: true },
    { metric: "packagesGeneratedInWindow", source: "VerificationPackage", filter: "evidence.teamId + generatedAtUtc>=window", windowed: true },
  ];

  // Reports + VerificationPackages do not carry teamId directly — they
  // are tied to Evidence, which is the team-owned row. We scope through
  // the evidence relation so cross-team leakage is structurally
  // impossible: a delete of the Evidence cascades the artifact away.
  const [reportsGeneratedInWindow, packagesGeneratedInWindow] = await Promise.all([
    safe(
      prisma.report.count({
        where: {
          generatedAtUtc: { gte: windowStart },
          evidence: { teamId: input.teamId, ...(input.reach ? { AND: [input.reach.evidence] } : {}) },
        },
      }),
      "Report",
      degraded,
    ),
    safe(
      prisma.verificationPackage.count({
        where: primaryPublishedPackageWhere({
          generatedAtUtc: { gte: windowStart },
          evidence: { teamId: input.teamId, ...(input.reach ? { AND: [input.reach.evidence] } : {}) },
        }),
      }),
      "VerificationPackage",
      degraded,
    ),
  ]);

  return {
    generatedAt: new Date(input.nowMs ?? Date.now()).toISOString(),
    window,
    sourceTrace,
    degradedSources: degraded,
    metrics: { reportsGeneratedInWindow, packagesGeneratedInWindow },
  };
}
