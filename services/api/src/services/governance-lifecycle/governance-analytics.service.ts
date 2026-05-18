/**
 * Phase 27.5 — Governance Analytics Service.
 *
 * Compliance-grade aggregations for the governance dashboard. Bounded
 * set of metrics, bounded set of windows (1h / 24h / 7d / 30d), severity
 * slicing, org-level rollup support.
 *
 * The service is read-only — no mutation. It runs a small fan-out of
 * cheap aggregate queries (`count`, `groupBy`) and returns a single
 * structured response. The dashboard caches it for 30s; operators see
 * a "as of" timestamp on every panel.
 *
 * Hard rules:
 *   - Metric catalog is bounded (`GOVERNANCE_ANALYTICS_METRICS`).
 *     Operators cannot request ad-hoc buckets.
 *   - Windows are bounded (`ANALYTICS_WINDOWS`). Empty / invalid
 *     windows default to 24h.
 *   - The service never returns privileged legal text. Every projection
 *     is operator-readable, catalog-bound IDs only.
 */

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import {
  ANALYTICS_WINDOWS,
  GOVERNANCE_ANALYTICS_METRICS,
  analyticsWindowToMilliseconds,
  type AnalyticsWindow,
  type GovernanceAnalyticsMetric,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";

export type GovernanceAnalyticsResult = {
  generatedAtUtc: string;
  teamId: string;
  window: AnalyticsWindow;
  windowMs: number;
  metrics: Record<GovernanceAnalyticsMetric, number>;
  severityBreakdown: {
    incidents: Record<"INFO" | "WARNING" | "HIGH" | "CRITICAL", number>;
    notifications: Record<"INFO" | "WARNING" | "HIGH" | "CRITICAL", number>;
  };
  lifecycleByState: Record<string, number>;
  destructionByStatus: Record<string, number>;
  immutableDriftByOutcome: Record<string, number>;
  topRetentionConflicts: ReadonlyArray<{
    scope: string;
    scopeQualifier: string | null;
    caseId: string | null;
    activeCount: number;
  }>;
  topReconciliationRuns: ReadonlyArray<{
    id: string;
    kind: string;
    status: string;
    startedAtUtc: string;
    finishedAtUtc: string | null;
    scanned: number;
    matched: number;
    created: number;
    failed: number;
  }>;
};

function normalizeWindow(w: string | undefined | null): AnalyticsWindow {
  if (typeof w === "string" && (ANALYTICS_WINDOWS as readonly string[]).includes(w)) {
    return w as AnalyticsWindow;
  }
  return "24h";
}

export async function computeGovernanceAnalytics(
  input: { teamId: string; window?: AnalyticsWindow },
  client: PrismaClient = defaultPrisma,
): Promise<GovernanceAnalyticsResult> {
  const window = normalizeWindow(input.window);
  const windowMs = analyticsWindowToMilliseconds(window);
  const since = new Date(Date.now() - windowMs);

  const [
    destructionQueueDepth,
    destructionBlockedCount,
    destructionExecutedCount,
    retentionConflictsRows,
    retentionExpirationVelocity,
    holdPressure,
    lifecycleTransitions,
    lifecycleBlockedTransitions,
    governanceIncidentOpen,
    immutableDriftCount,
    exportBlocks,
    reviewOverdue,
    incidentSeverityRows,
    notificationSeverityRows,
    lifecycleByStateRows,
    destructionByStatusRows,
    immutableDriftRows,
    topRetentionConflictsRows,
    topReconciliationRunsRows,
  ] = await Promise.all([
    client.destructionReview.count({
      where: {
        teamId: input.teamId,
        status: { in: ["PENDING", "UNDER_REVIEW", "DEFERRED", "APPROVED"] },
      },
    }),
    client.destructionReview.count({
      where: {
        teamId: input.teamId,
        status: "DENIED",
        updatedAt: { gte: since },
      },
    }),
    client.destructionReview.count({
      where: {
        teamId: input.teamId,
        status: "EXECUTED",
        executedAtUtc: { gte: since },
      },
    }),
    client.evidenceRetentionPolicy.groupBy({
      by: ["scope", "scopeQualifier", "caseId"],
      where: { teamId: input.teamId, status: "ACTIVE" },
      _count: { _all: true },
    }),
    client.evidence.count({
      where: {
        teamId: input.teamId,
        retentionUntilUtc: { gte: since, lt: new Date(Date.now() + windowMs) },
      },
    }),
    client.evidenceLegalHold.count({
      where: {
        teamId: input.teamId,
        status: prismaPkg.LegalHoldStatus.ACTIVE,
      },
    }),
    client.evidenceLifecycleEvent.count({
      where: {
        teamId: input.teamId,
        eventType: "lifecycle_transition",
        createdAt: { gte: since },
      },
    }),
    // Phase 27.5 — lifecycle_transition_blocked is emitted on the security
    // feed, not the lifecycle ledger. We count blocked-destruction
    // signals via the destruction-blocked counters proxy by looking at
    // immutable drift + blocked destruction holds — see metrics below.
    client.securityEvent.count({
      where: {
        teamId: input.teamId,
        eventType: "lifecycle_transition_blocked",
        createdAt: { gte: since },
      },
    }),
    client.operationalIncident.count({
      where: {
        teamId: input.teamId,
        category: prismaPkg.IncidentCategory.GOVERNANCE,
        status: { in: [prismaPkg.IncidentStatus.OPEN, prismaPkg.IncidentStatus.ACKNOWLEDGED] },
      },
    }),
    client.immutableStorageCheck.count({
      where: {
        teamId: input.teamId,
        outcome: {
          in: [
            prismaPkg.ImmutableStorageCheckOutcome.MISSING_LOCK,
            prismaPkg.ImmutableStorageCheckOutcome.RETENTION_MISMATCH,
            prismaPkg.ImmutableStorageCheckOutcome.LEGAL_HOLD_MISMATCH,
            prismaPkg.ImmutableStorageCheckOutcome.COMPLIANCE_MODE_MISMATCH,
          ],
        },
        checkedAtUtc: { gte: since },
      },
    }),
    client.governanceExportSnapshot.count({
      where: {
        teamId: input.teamId,
        exportEligibilityOutcome: {
          in: [
            "BLOCKED_BY_HOLD",
            "BLOCKED_BY_LIFECYCLE",
            "BLOCKED_BY_REVIEW_GATE",
            "BLOCKED_BY_POLICY",
            "BLOCKED_BY_RETENTION",
          ],
        },
        createdAt: { gte: since },
      },
    }),
    client.governanceNotification.count({
      where: {
        teamId: input.teamId,
        kind: prismaPkg.GovernanceNotificationKind.REVIEW_OVERDUE,
        acknowledgedAtUtc: null,
      },
    }),
    client.operationalIncident.groupBy({
      by: ["severity"],
      where: {
        teamId: input.teamId,
        category: prismaPkg.IncidentCategory.GOVERNANCE,
        createdAt: { gte: since },
      },
      _count: { _all: true },
    }),
    client.governanceNotification.groupBy({
      by: ["severity"],
      where: { teamId: input.teamId, lastSeenAtUtc: { gte: since } },
      _count: { _all: true },
    }),
    client.evidence.groupBy({
      by: ["lifecycleState"],
      where: { teamId: input.teamId },
      _count: { _all: true },
    }),
    client.destructionReview.groupBy({
      by: ["status"],
      where: { teamId: input.teamId, createdAt: { gte: since } },
      _count: { _all: true },
    }),
    client.immutableStorageCheck.groupBy({
      by: ["outcome"],
      where: { teamId: input.teamId, checkedAtUtc: { gte: since } },
      _count: { _all: true },
    }),
    client.evidenceRetentionPolicy.groupBy({
      by: ["scope", "scopeQualifier", "caseId"],
      where: { teamId: input.teamId, status: "ACTIVE" },
      _count: { _all: true },
      having: { id: { _count: { gt: 1 } } },
      orderBy: { _count: { id: "desc" } },
      take: 10,
    }),
    client.governanceReconciliationRun.findMany({
      where: { teamId: input.teamId, startedAtUtc: { gte: since } },
      orderBy: { startedAtUtc: "desc" },
      take: 20,
      select: {
        id: true,
        kind: true,
        status: true,
        startedAtUtc: true,
        finishedAtUtc: true,
        scannedCount: true,
        matchedCount: true,
        createdCount: true,
        failedCount: true,
      },
    }),
  ]);

  const retentionConflictCount = retentionConflictsRows.filter(
    (r) => r._count._all > 1,
  ).length;

  const metrics: Record<GovernanceAnalyticsMetric, number> = {
    destruction_queue_depth: destructionQueueDepth,
    destruction_blocked_count: destructionBlockedCount,
    destruction_executed_count: destructionExecutedCount,
    retention_conflicts: retentionConflictCount,
    retention_expiration_velocity: retentionExpirationVelocity,
    hold_pressure: holdPressure,
    lifecycle_transitions: lifecycleTransitions,
    lifecycle_blocked_transitions: lifecycleBlockedTransitions,
    governance_incident_open: governanceIncidentOpen,
    immutable_drift_count: immutableDriftCount,
    export_blocks: exportBlocks,
    review_overdue: reviewOverdue,
  };
  // Catalog completeness check (compile-time guard).
  for (const m of GOVERNANCE_ANALYTICS_METRICS) {
    if (!(m in metrics)) {
      (metrics as Record<string, number>)[m] = 0;
    }
  }

  function severityBucket(
    rows: ReadonlyArray<{ severity: string; _count: { _all: number } }>,
  ): Record<"INFO" | "WARNING" | "HIGH" | "CRITICAL", number> {
    const out: Record<"INFO" | "WARNING" | "HIGH" | "CRITICAL", number> = {
      INFO: 0,
      WARNING: 0,
      HIGH: 0,
      CRITICAL: 0,
    };
    for (const r of rows) {
      const s = r.severity as keyof typeof out;
      if (s in out) out[s] = r._count._all;
    }
    return out;
  }

  return {
    generatedAtUtc: new Date().toISOString(),
    teamId: input.teamId,
    window,
    windowMs,
    metrics,
    severityBreakdown: {
      incidents: severityBucket(incidentSeverityRows),
      notifications: severityBucket(notificationSeverityRows),
    },
    lifecycleByState: Object.fromEntries(
      lifecycleByStateRows.map((r) => [r.lifecycleState, r._count._all]),
    ),
    destructionByStatus: Object.fromEntries(
      destructionByStatusRows.map((r) => [r.status, r._count._all]),
    ),
    immutableDriftByOutcome: Object.fromEntries(
      immutableDriftRows.map((r) => [r.outcome, r._count._all]),
    ),
    topRetentionConflicts: topRetentionConflictsRows.map((r) => ({
      scope: r.scope,
      scopeQualifier: r.scopeQualifier,
      caseId: r.caseId,
      activeCount: r._count._all,
    })),
    topReconciliationRuns: topReconciliationRunsRows.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      startedAtUtc: r.startedAtUtc.toISOString(),
      finishedAtUtc: r.finishedAtUtc?.toISOString() ?? null,
      scanned: r.scannedCount,
      matched: r.matchedCount,
      created: r.createdCount,
      failed: r.failedCount,
    })),
  };
}
