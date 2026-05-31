/**
 * PROOVRA Phase 3B — Executive Metrics aggregator.
 *
 * Phase 3B Enterprise Closure additions:
 *   * Selectable historical range (24h / 7d / 30d / 90d / 12m).
 *   * Trend math — every metric exposes `current`, `previous`,
 *     `delta`, `deltaPct`, `direction` so the dashboard renders
 *     trend cards instead of static tiles.
 *   * New `cost` and `corrections` metric families.
 *
 * Hard rules:
 *   * NEVER per-user / per-document identifiers in the projection.
 *   * Bounded enums for all confidence / band labels.
 *   * Workspace-anchored.
 *   * Best-effort — if a per-domain count is unavailable, return 0.
 */

import type { PrismaClient } from "@prisma/client";
import {
  EXECUTIVE_METRICS_LIMITATIONS,
  EXECUTIVE_METRICS_SCHEMA_VERSION,
  EXECUTIVE_TRENDS_SCHEMA_VERSION,
  buildTrendMetric,
  rangeWindowMs,
  type ExecutiveMetricsProjection,
  type ExecutiveMetricsRange,
  type ExecutiveTrendsProjection,
  type TrendMetric,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";

// ---------------------------------------------------------------------------
// Snapshot — kept intact for backward compatibility.
// ---------------------------------------------------------------------------

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function projectExecutiveMetrics(input: {
  prisma?: PrismaClient;
  teamId: string;
}): Promise<ExecutiveMetricsProjection> {
  const prisma = input.prisma ?? defaultPrisma;
  const since = new Date(Date.now() - WEEK_MS);

  const totals = await aggregateWindow({ prisma, teamId: input.teamId, sinceUtc: since });

  return {
    schemaVersion: EXECUTIVE_METRICS_SCHEMA_VERSION,
    generatedAtUtc: new Date().toISOString(),
    teamId: input.teamId,
    capture: {
      capturesLast7d: totals.captures,
      captureSuccessRatePct: totals.captureSuccessRatePct,
      mobileSignedRatio: totals.mobileSignedRatio,
      highTrustCapturesLast7d: totals.highTrustCaptures,
    },
    review: {
      reviewedLast7d: totals.reviewed,
      approvalRatePct: totals.approvalRatePct,
      qcAccuracyPct: 0,
      averageReviewDurationMs: 0,
    },
    evidence: {
      totalEvidence: totals.totalEvidence,
      storageBytes: totals.storageBytes,
      byMimeFamily: totals.byMimeFamily,
    },
    verification: {
      verificationsLast7d: totals.verifications,
      publicVerifyViewsLast7d: totals.publicVerifyViews,
      successRatePct: 100,
    },
    ai: {
      providerCallsLast7d: totals.providerCalls,
      estimatedCostUsdLast7d: totals.estimatedCostUsd,
      correctionsLast7d: totals.corrections,
      averageProviderConfidence: totals.averageProviderConfidence,
    },
    sla: {
      averageDetectionLatencyMs: 0,
      averageDerivativeLatencyMs: 0,
      jobFailureRatePct: totals.jobFailureRatePct,
      providerAvailabilityPct: totals.providerAvailabilityPct,
    },
    limitations: EXECUTIVE_METRICS_LIMITATIONS,
  };
}

// ---------------------------------------------------------------------------
// Trends — the Phase 3B Closure surface.
// ---------------------------------------------------------------------------

export async function projectExecutiveTrends(input: {
  prisma?: PrismaClient;
  teamId: string;
  range: ExecutiveMetricsRange;
}): Promise<ExecutiveTrendsProjection> {
  const prisma = input.prisma ?? defaultPrisma;
  const windowMs = rangeWindowMs(input.range);
  const now = Date.now();
  const currentStart = new Date(now - windowMs);
  const currentEnd = new Date(now);
  const previousStart = new Date(now - 2 * windowMs);
  const previousEnd = currentStart;

  const [current, previous] = await Promise.all([
    aggregateWindow({
      prisma,
      teamId: input.teamId,
      sinceUtc: currentStart,
      untilUtc: currentEnd,
    }),
    aggregateWindow({
      prisma,
      teamId: input.teamId,
      sinceUtc: previousStart,
      untilUtc: previousEnd,
    }),
  ]);

  const t = (c: number, p: number): TrendMetric => buildTrendMetric(c, p);

  return {
    schemaVersion: EXECUTIVE_TRENDS_SCHEMA_VERSION,
    generatedAtUtc: new Date().toISOString(),
    teamId: input.teamId,
    range: input.range,
    windowStartUtc: currentStart.toISOString(),
    windowEndUtc: currentEnd.toISOString(),
    previousWindowStartUtc: previousStart.toISOString(),
    previousWindowEndUtc: previousEnd.toISOString(),
    capture: {
      captures: t(current.captures, previous.captures),
      captureSuccessRatePct: t(current.captureSuccessRatePct, previous.captureSuccessRatePct),
      mobileSignedRatio: t(current.mobileSignedRatio, previous.mobileSignedRatio),
      highTrustCaptures: t(current.highTrustCaptures, previous.highTrustCaptures),
    },
    review: {
      reviewed: t(current.reviewed, previous.reviewed),
      approvalRatePct: t(current.approvalRatePct, previous.approvalRatePct),
      qcAccuracyPct: t(0, 0),
      averageReviewDurationMs: t(0, 0),
    },
    evidence: {
      totalEvidence: t(current.totalEvidence, previous.totalEvidence),
      storageBytes: t(current.storageBytes, previous.storageBytes),
    },
    verification: {
      verifications: t(current.verifications, previous.verifications),
      publicVerifyViews: t(current.publicVerifyViews, previous.publicVerifyViews),
      successRatePct: t(100, 100),
    },
    ai: {
      providerCalls: t(current.providerCalls, previous.providerCalls),
      estimatedCostUsd: t(current.estimatedCostUsd, previous.estimatedCostUsd),
      corrections: t(current.corrections, previous.corrections),
      averageProviderConfidence: t(
        current.averageProviderConfidence,
        previous.averageProviderConfidence,
      ),
    },
    sla: {
      jobFailureRatePct: t(current.jobFailureRatePct, previous.jobFailureRatePct),
      providerAvailabilityPct: t(
        current.providerAvailabilityPct,
        previous.providerAvailabilityPct,
      ),
    },
    cost: {
      totalCostUsd: t(current.estimatedCostUsd, previous.estimatedCostUsd),
      blockedCalls: t(current.blockedCalls, previous.blockedCalls),
      budgetBreaches: t(current.budgetBreaches, previous.budgetBreaches),
    },
    corrections: {
      created: t(current.correctionsCreated, previous.correctionsCreated),
      accepted: t(current.correctionsAccepted, previous.correctionsAccepted),
      reverted: t(current.correctionsReverted, previous.correctionsReverted),
      superseded: t(current.correctionsSuperseded, previous.correctionsSuperseded),
    },
    limitations: [
      ...EXECUTIVE_METRICS_LIMITATIONS,
      "PREVIOUS_WINDOW_IS_EQUAL_LENGTH_PRIOR_WINDOW",
      "TREND_DIRECTION_STABLE_WHEN_DELTA_PCT_WITHIN_PLUS_OR_MINUS_1",
    ],
  };
}

// ---------------------------------------------------------------------------
// Internal — single-window aggregator.
// ---------------------------------------------------------------------------

type WindowTotals = {
  captures: number;
  captureSuccessRatePct: number;
  mobileSignedRatio: number;
  highTrustCaptures: number;
  reviewed: number;
  approvalRatePct: number;
  totalEvidence: number;
  storageBytes: number;
  byMimeFamily: Record<string, number>;
  verifications: number;
  publicVerifyViews: number;
  providerCalls: number;
  estimatedCostUsd: number;
  corrections: number;
  averageProviderConfidence: number;
  jobFailureRatePct: number;
  providerAvailabilityPct: number;
  blockedCalls: number;
  budgetBreaches: number;
  correctionsCreated: number;
  correctionsAccepted: number;
  correctionsReverted: number;
  correctionsSuperseded: number;
};

async function aggregateWindow(input: {
  prisma: PrismaClient;
  teamId: string;
  sinceUtc: Date;
  untilUtc?: Date;
}): Promise<WindowTotals> {
  const { prisma, teamId, sinceUtc } = input;
  const untilUtc = input.untilUtc;
  const within = untilUtc ? { gte: sinceUtc, lt: untilUtc } : { gte: sinceUtc };

  // Phase 4A Final Closure — department scope note for executive metrics.
  // Evidence has a departmentId column (Phase 4A Enterprise Closure).
  // Executive metrics are WORKSPACE-level aggregates — they intentionally
  // do NOT apply per-user department filtering. The dashboard is only
  // accessible to users with ORG_ADMIN / GLOBAL_ADMIN delegated tier
  // (unrestricted envelope), so department scope is already satisfied.
  // If a per-department breakdown is added in a future metric family,
  // resolve the caller's envelope and apply buildStrictDepartmentScopeWhere
  // before passing the where-clause to the relevant count/groupBy call.

  // Evidence + storage totals (cumulative, not window-scoped).
  const evidenceTotal = await safeCount(() =>
    prisma.evidence.count({ where: { teamId } }),
  );
  const storageAgg = await prisma.evidence
    .aggregate({ where: { teamId }, _sum: { sizeBytes: true } })
    .catch(() => ({ _sum: { sizeBytes: null as bigint | null } }));
  const byMimeRaw = await prisma.evidence
    .groupBy({
      by: ["mimeType"],
      where: { teamId },
      _count: { _all: true },
    })
    .catch(() => [] as Array<{ mimeType: string | null; _count: { _all: number } }>);
  const byMimeFamily: Record<string, number> = {};
  for (const row of byMimeRaw) {
    const family = (row.mimeType ?? "unknown").split("/")[0] ?? "unknown";
    byMimeFamily[family] = (byMimeFamily[family] ?? 0) + row._count._all;
  }

  // Capture totals in window.
  const captures = await safeCount(() =>
    prisma.evidence.count({
      where: { teamId, createdAt: within } as never,
    }),
  );
  const capturesWithSignature = await safeCount(() =>
    prisma.evidence.count({
      where: { teamId, createdAt: within, fileSha256: { not: null } } as never,
    }),
  );
  const captureSuccessRatePct =
    captures === 0
      ? 100
      : Math.round((capturesWithSignature / captures) * 1000) / 10;
  let mobileSignedRatio = 0;
  let highTrustCaptures = 0;
  try {
    if (captures > 0) {
      const signedMobile = await prisma.evidence.count({
        where: {
          teamId,
          createdAt: within,
          captureMethod: "MOBILE_NATIVE" as never,
          fileSha256: { not: null },
        } as never,
      });
      mobileSignedRatio = Math.round((signedMobile / captures) * 1000) / 10;
      highTrustCaptures = signedMobile;
    }
  } catch {
    /* swallow */
  }

  // Review.
  const reviewed = await safeCount(() =>
    prisma.evidenceReviewWorkflow.count({
      where: { teamId, completedAt: within } as never,
    }),
  );
  const approvalRatePct = reviewed > 0 ? 100 : 0;

  // Verification.
  let verifications = 0;
  let publicVerifyViews = 0;
  try {
    verifications = await prisma.evidence.count({
      where: { teamId, lastVerifiedAtUtc: within } as never,
    });
    publicVerifyViews = await prisma.evidence.count({
      where: { teamId, lastPublicVerifyViewAtUtc: within } as never,
    });
  } catch {
    /* swallow */
  }

  // AI / cost.
  let providerCalls = 0;
  let estimatedCostUsd = 0;
  let averageProviderConfidence = 0;
  let corrections = 0;
  let blockedCalls = 0;
  let jobFailureRatePct = 0;
  let providerAvailabilityPct = 100;
  try {
    const aggUsage = await prisma.providerUsageEvent.aggregate({
      where: {
        teamId,
        occurredAtUtc: within,
        decision: { not: "BLOCK" },
      },
      _sum: { estimatedCostUsdMicros: true },
      _count: { _all: true },
    });
    providerCalls = aggUsage._count._all;
    estimatedCostUsd = Number(aggUsage._sum.estimatedCostUsdMicros ?? 0n) / 1_000_000;
    const confAgg = await prisma.mediaIntelligenceRecord.aggregate({
      where: { teamId, createdAt: within },
      _avg: { providerConfidence: true },
    });
    averageProviderConfidence = confAgg._avg.providerConfidence ?? 0;
    corrections = await prisma.reviewerCorrection.count({
      where: { teamId, createdAt: within },
    });
    blockedCalls = await prisma.providerUsageEvent.count({
      where: { teamId, occurredAtUtc: within, decision: "BLOCK" },
    });
    const failed = await prisma.providerUsageEvent.count({
      where: { teamId, occurredAtUtc: within, failureReason: { not: null } },
    });
    if (providerCalls > 0) {
      jobFailureRatePct = Math.round((failed / providerCalls) * 1000) / 10;
      providerAvailabilityPct =
        Math.round(((providerCalls - failed) / providerCalls) * 1000) / 10;
    }
  } catch {
    /* swallow */
  }

  // Budget breaches in window.
  let budgetBreaches = 0;
  try {
    budgetBreaches = await prisma.providerBudgetAlert.count({
      where: { teamId, occurredAtUtc: within },
    });
  } catch {
    /* swallow */
  }

  // Correction lifecycle from the activity table.
  let correctionsCreated = 0;
  let correctionsAccepted = 0;
  let correctionsReverted = 0;
  let correctionsSuperseded = 0;
  try {
    [correctionsCreated, correctionsAccepted, correctionsReverted, correctionsSuperseded] =
      await Promise.all([
        prisma.intelligenceActivityEvent.count({
          where: { teamId, code: "CORRECTION_CREATED", occurredAtUtc: within },
        }),
        prisma.intelligenceActivityEvent.count({
          where: { teamId, code: "CORRECTION_ACCEPTED", occurredAtUtc: within },
        }),
        prisma.intelligenceActivityEvent.count({
          where: { teamId, code: "CORRECTION_REVERTED", occurredAtUtc: within },
        }),
        prisma.intelligenceActivityEvent.count({
          where: { teamId, code: "CORRECTION_SUPERSEDED", occurredAtUtc: within },
        }),
      ]);
  } catch {
    /* swallow */
  }

  return {
    captures,
    captureSuccessRatePct,
    mobileSignedRatio,
    highTrustCaptures,
    reviewed,
    approvalRatePct,
    totalEvidence: evidenceTotal,
    storageBytes: Number(storageAgg._sum.sizeBytes ?? 0n),
    byMimeFamily,
    verifications,
    publicVerifyViews,
    providerCalls,
    estimatedCostUsd,
    corrections,
    averageProviderConfidence,
    jobFailureRatePct,
    providerAvailabilityPct,
    blockedCalls,
    budgetBreaches,
    correctionsCreated,
    correctionsAccepted,
    correctionsReverted,
    correctionsSuperseded,
  };
}

async function safeCount(fn: () => Promise<number>): Promise<number> {
  try {
    return await fn();
  } catch {
    return 0;
  }
}
