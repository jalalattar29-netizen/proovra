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
 *   * Best-effort COUNTS — if a per-domain count is unavailable, return 0.
 *   * RATES / LATENCIES are NEVER fabricated: a rate with no denominator,
 *     or a metric with no real data source, is emitted as `null`
 *     ("Not measured"), never as a 0/100 stand-in.
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
import {
  workspaceEvidenceWhere,
} from "@proovra/shared-runtime";

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
      qcAccuracyPct: totals.qcAccuracyPct,
      averageReviewDurationMs: totals.averageReviewDurationMs,
    },
    evidence: {
      totalEvidence: totals.totalEvidence,
      storageBytes: totals.storageBytes,
      byMimeFamily: totals.byMimeFamily,
    },
    verification: {
      verificationsLast7d: totals.verifications,
      publicVerifyViewsLast7d: totals.publicVerifyViews,
      // No pass/fail verification-result source — honest null, not a 100.
      successRatePct: null,
    },
    ai: {
      providerCallsLast7d: totals.providerCalls,
      estimatedCostUsdLast7d: totals.estimatedCostUsd,
      correctionsLast7d: totals.corrections,
      averageProviderConfidence: totals.averageProviderConfidence,
    },
    sla: {
      // No detection/derivative-timing source — honest null, not a fake 0.
      averageDetectionLatencyMs: null,
      averageDerivativeLatencyMs: null,
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
  // Null-aware trend: if EITHER window lacks the metric, there is no honest
  // trend — emit null rather than fabricating a 0/100 baseline.
  const tn = (c: number | null, p: number | null): TrendMetric | null =>
    c === null || p === null ? null : buildTrendMetric(c, p);

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
      captureSuccessRatePct: tn(current.captureSuccessRatePct, previous.captureSuccessRatePct),
      mobileSignedRatio: t(current.mobileSignedRatio, previous.mobileSignedRatio),
      highTrustCaptures: t(current.highTrustCaptures, previous.highTrustCaptures),
    },
    review: {
      reviewed: t(current.reviewed, previous.reviewed),
      approvalRatePct: tn(current.approvalRatePct, previous.approvalRatePct),
      qcAccuracyPct: tn(current.qcAccuracyPct, previous.qcAccuracyPct),
      averageReviewDurationMs: tn(
        current.averageReviewDurationMs,
        previous.averageReviewDurationMs,
      ),
    },
    evidence: {
      totalEvidence: t(current.totalEvidence, previous.totalEvidence),
      storageBytes: t(current.storageBytes, previous.storageBytes),
    },
    verification: {
      verifications: t(current.verifications, previous.verifications),
      publicVerifyViews: t(current.publicVerifyViews, previous.publicVerifyViews),
      // No pass/fail verification-result source — honest null, never a
      // fabricated 100-baseline trend.
      successRatePct: null,
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
      providerAvailabilityPct: tn(
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
  captureSuccessRatePct: number | null;
  mobileSignedRatio: number;
  highTrustCaptures: number;
  reviewed: number;
  /**
   * Share of completed reviews that ended APPROVED_INTERNAL, in [0, 100].
   * NULL when no reviews completed in the window — never a 100 placeholder.
   */
  approvalRatePct: number | null;
  /**
   * QC pass rate = PASS / (PASS + FAIL + PARTIAL) over rendered QcSample
   * verdicts, in [0, 100]. NULL when no verdicts exist in the window.
   */
  qcAccuracyPct: number | null;
  /**
   * Mean workflow completion latency (ms). NULL when no reviews completed.
   */
  averageReviewDurationMs: number | null;
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
  providerAvailabilityPct: number | null;
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
  // WORKSPACE-SCOPE CONVERGENCE — the canonical workspace population,
  // resolved once for every query below. A strict `teamId` equality here
  // omitted a personal workspace's legacy NULL-team rows, and reported the
  // smaller number as if it were the whole population.
  const scope = await workspaceEvidenceWhere(teamId, prisma);
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
    prisma.evidence.count({ where: { AND: [scope] } }),
  );
  const storageAgg = await prisma.evidence
    .aggregate({ where: { AND: [scope] }, _sum: { sizeBytes: true } })
    .catch(() => ({ _sum: { sizeBytes: null as bigint | null } }));
  const byMimeRaw = await prisma.evidence
    .groupBy({
      by: ["mimeType"],
      where: { AND: [scope] },
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
    captures === 0 ? null : Math.round((capturesWithSignature / captures) * 1000) / 10;
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

  // Review — completion counted by the real completion timestamp column.
  const reviewed = await safeCount(() =>
    prisma.evidenceReviewWorkflow.count({
      where: { teamId, completedAtUtc: within } as never,
    }),
  );

  // Approval rate — REAL: completed workflows that ended APPROVED_INTERNAL
  // over all completed workflows. NULL when nothing completed (no honest
  // rate to report — never a 100 stand-in).
  let approvalRatePct: number | null = null;
  // Review duration — REAL: mean(completedAtUtc − createdAt) over completed
  // workflows. NULL when nothing completed.
  let averageReviewDurationMs: number | null = null;
  try {
    if (reviewed > 0) {
      const approved = await prisma.evidenceReviewWorkflow.count({
        where: {
          teamId,
          completedAtUtc: within,
          status: "APPROVED_INTERNAL",
        } as never,
      });
      approvalRatePct = Math.round((approved / reviewed) * 1000) / 10;

      const completedRows = await prisma.evidenceReviewWorkflow.findMany({
        where: { teamId, completedAtUtc: within } as never,
        select: { createdAt: true, completedAtUtc: true } as never,
      });
      let durationSum = 0;
      let durationCount = 0;
      for (const row of completedRows as Array<{
        createdAt: Date | null;
        completedAtUtc: Date | null;
      }>) {
        if (row.createdAt && row.completedAtUtc) {
          const ms = row.completedAtUtc.getTime() - row.createdAt.getTime();
          if (ms >= 0) {
            durationSum += ms;
            durationCount += 1;
          }
        }
      }
      averageReviewDurationMs =
        durationCount > 0 ? Math.round(durationSum / durationCount) : null;
    }
  } catch {
    /* swallow — leave approval/duration null */
  }

  // QC accuracy — REAL: PASS / (PASS + FAIL + PARTIAL) over rendered QcSample
  // verdicts in the window. NULL when no verdicts were rendered.
  let qcAccuracyPct: number | null = null;
  try {
    const verdictRows = await prisma.qcSample.groupBy({
      by: ["verdict"],
      where: { teamId, verdictAtUtc: within, verdict: { not: null } } as never,
      _count: { _all: true },
    });
    let pass = 0;
    let total = 0;
    for (const row of verdictRows as Array<{
      verdict: string | null;
      _count: { _all: number };
    }>) {
      const n = row._count._all;
      total += n;
      if (row.verdict === "PASS") pass += n;
    }
    if (total > 0) {
      qcAccuracyPct = Math.round((pass / total) * 1000) / 10;
    }
  } catch {
    /* swallow — leave qcAccuracy null */
  }

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
  let providerAvailabilityPct: number | null = null;
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
    qcAccuracyPct,
    averageReviewDurationMs,
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
