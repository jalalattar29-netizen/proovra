/**
 * Phase 25.5 — Reviewer-ops analytics.
 *
 * Two operator-readable analytics surfaces:
 *
 *   1. Escalation analytics — trend by day, hotspots by reason, mean
 *      resolution time, total open / resolved.
 *   2. Reviewer performance — per-reviewer rollups over a date range.
 *
 * Hard rules:
 *   - No private reviewer note text — only structured counts.
 *   - No legal-hold reason text. No raw evidence content.
 *   - Range is bounded (max 90 days). Routes pass the bounds; the
 *     service double-checks.
 *   - Operator-readable wording only; the catalog of allowed labels
 *     is `REVIEWER_OPS_ALLOWED_LABELS`.
 */

import type { PrismaClient } from "@prisma/client";
import {
  REVIEW_ESCALATION_REASONS,
  type EscalationAnalyticsBucket,
  type EscalationAnalyticsHotspot,
  type EscalationAnalyticsProjection,
  type ReviewEscalationReason,
  type ReviewerPerformanceProjection,
  type ReviewerPerformanceRow,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";

// -----------------------------------------------------------------------------
// Range helper
// -----------------------------------------------------------------------------

export const ANALYTICS_RANGE_MAX_DAYS = 90;
export const ANALYTICS_RANGE_DEFAULT_DAYS = 30;

function boundRange(days?: number): { startUtc: Date; endUtc: Date } {
  const range = Math.min(
    Math.max(Math.floor(days ?? ANALYTICS_RANGE_DEFAULT_DAYS), 1),
    ANALYTICS_RANGE_MAX_DAYS,
  );
  const endUtc = new Date();
  const startUtc = new Date(endUtc.getTime() - range * 86400_000);
  return { startUtc, endUtc };
}

function dayBucket(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// -----------------------------------------------------------------------------
// Escalation analytics
// -----------------------------------------------------------------------------

export async function getEscalationAnalytics(
  input: { teamId: string; rangeDays?: number },
  client: PrismaClient = defaultPrisma,
): Promise<EscalationAnalyticsProjection> {
  const { startUtc, endUtc } = boundRange(input.rangeDays);

  const [openTotal, inRangeRows, resolvedRows] = await Promise.all([
    client.reviewEscalation.count({
      where: {
        teamId: input.teamId,
        status: { in: ["OPEN", "ACKNOWLEDGED", "REASSIGNED"] },
      },
    }),
    client.reviewEscalation.findMany({
      where: {
        teamId: input.teamId,
        createdAt: { gte: startUtc, lte: endUtc },
      },
      select: {
        id: true,
        reason: true,
        status: true,
        createdAt: true,
        resolvedAtUtc: true,
        suppressedAtUtc: true,
      },
    }),
    client.reviewEscalation.findMany({
      where: {
        teamId: input.teamId,
        resolvedAtUtc: { gte: startUtc, lte: endUtc, not: null },
      },
      select: {
        createdAt: true,
        resolvedAtUtc: true,
        reason: true,
      },
    }),
  ]);

  // ---------- Daily buckets ----------
  const buckets = new Map<string, EscalationAnalyticsBucket>();
  // Seed buckets so the UI gets a contiguous range with zeros.
  for (
    let d = new Date(startUtc);
    d <= endUtc;
    d = new Date(d.getTime() + 86400_000)
  ) {
    const key = dayBucket(d);
    buckets.set(key, {
      dayBucket: key,
      opened: 0,
      resolved: 0,
      suppressed: 0,
    });
  }
  for (const row of inRangeRows) {
    const openedKey = dayBucket(row.createdAt);
    const ob = buckets.get(openedKey);
    if (ob) ob.opened += 1;
    if (row.resolvedAtUtc) {
      const rb = buckets.get(dayBucket(row.resolvedAtUtc));
      if (rb) rb.resolved += 1;
    }
    if (row.suppressedAtUtc) {
      const sb = buckets.get(dayBucket(row.suppressedAtUtc));
      if (sb) sb.suppressed += 1;
    }
  }
  const byDay = Array.from(buckets.values()).sort((a, b) =>
    a.dayBucket < b.dayBucket ? -1 : 1,
  );

  // ---------- Mean resolution time ----------
  let totalMs = 0;
  let resolvedCount = 0;
  for (const r of resolvedRows) {
    if (r.resolvedAtUtc) {
      totalMs += r.resolvedAtUtc.getTime() - r.createdAt.getTime();
      resolvedCount += 1;
    }
  }
  const meanResolutionMs =
    resolvedCount > 0 ? Math.round(totalMs / resolvedCount) : null;

  // ---------- Hotspots by reason ----------
  const hotspotMap = new Map<
    ReviewEscalationReason,
    { open: number; resolved: number; totalMs: number; resolvedCount: number }
  >();
  for (const reason of REVIEW_ESCALATION_REASONS) {
    hotspotMap.set(reason, {
      open: 0,
      resolved: 0,
      totalMs: 0,
      resolvedCount: 0,
    });
  }
  for (const row of inRangeRows) {
    const r = row.reason as ReviewEscalationReason;
    const slot = hotspotMap.get(r);
    if (!slot) continue;
    if (["OPEN", "ACKNOWLEDGED", "REASSIGNED"].includes(row.status)) {
      slot.open += 1;
    }
    if (row.resolvedAtUtc) {
      slot.resolved += 1;
      slot.totalMs += row.resolvedAtUtc.getTime() - row.createdAt.getTime();
      slot.resolvedCount += 1;
    }
  }
  const hotspots: EscalationAnalyticsHotspot[] = Array.from(
    hotspotMap.entries(),
  )
    .map(([reason, slot]) => ({
      reason,
      openCount: slot.open,
      resolvedCount: slot.resolved,
      meanResolutionMs:
        slot.resolvedCount > 0
          ? Math.round(slot.totalMs / slot.resolvedCount)
          : null,
    }))
    .filter((h) => h.openCount > 0 || h.resolvedCount > 0)
    .sort((a, b) => b.openCount - a.openCount);

  bump("reviewer_analytics_viewed_total");

  return {
    range: {
      startUtc: startUtc.toISOString(),
      endUtc: endUtc.toISOString(),
    },
    totalOpen: openTotal,
    totalOpenedInRange: inRangeRows.length,
    totalResolvedInRange: resolvedRows.length,
    meanResolutionMs,
    byDay,
    hotspots,
  };
}

// -----------------------------------------------------------------------------
// Reviewer performance
// -----------------------------------------------------------------------------

export async function getReviewerPerformance(
  input: { teamId: string; rangeDays?: number; limit?: number },
  client: PrismaClient = defaultPrisma,
): Promise<ReviewerPerformanceProjection> {
  const { startUtc, endUtc } = boundRange(input.rangeDays);
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);

  // Pull every workflow row that touches the range or is still
  // active. Cheaper than per-reviewer queries — the workspace size
  // is bounded by the reviewer team count.
  const rows = await client.evidenceReviewWorkflow.findMany({
    where: {
      teamId: input.teamId,
      assignedToUserId: { not: null },
    },
    select: {
      assignedToUserId: true,
      status: true,
      slaStatus: true,
      escalationLevel: true,
      activeEscalationId: true,
      completedAtUtc: true,
      assignedAtUtc: true,
      lastReviewedAt: true,
      reopenCount: true,
    },
  });

  type Agg = {
    active: number;
    completedInRange: number;
    approvedInRange: number;
    rejectedInRange: number;
    overdue: number;
    escalated: number;
    totalResolutionMs: number;
    resolvedCount: number;
    slaCompliantCompleted: number;
    completedTotal: number;
  };
  const agg = new Map<string, Agg>();
  function slot(userId: string): Agg {
    let s = agg.get(userId);
    if (s) return s;
    s = {
      active: 0,
      completedInRange: 0,
      approvedInRange: 0,
      rejectedInRange: 0,
      overdue: 0,
      escalated: 0,
      totalResolutionMs: 0,
      resolvedCount: 0,
      slaCompliantCompleted: 0,
      completedTotal: 0,
    };
    agg.set(userId, s);
    return s;
  }

  for (const r of rows) {
    if (!r.assignedToUserId) continue;
    const s = slot(r.assignedToUserId);
    const isCompleted =
      r.status === "APPROVED_INTERNAL" ||
      r.status === "REJECTED_INSUFFICIENT" ||
      r.status === "CLOSED";
    if (!isCompleted) s.active += 1;
    if (r.slaStatus === "OVERDUE" || r.slaStatus === "BREACHED") {
      s.overdue += 1;
    }
    if (r.status === "ESCALATED" || r.activeEscalationId) {
      s.escalated += 1;
    }
    if (r.completedAtUtc && r.completedAtUtc >= startUtc && r.completedAtUtc <= endUtc) {
      s.completedInRange += 1;
      s.completedTotal += 1;
      if (r.status === "APPROVED_INTERNAL") s.approvedInRange += 1;
      if (r.status === "REJECTED_INSUFFICIENT") s.rejectedInRange += 1;
      if (r.assignedAtUtc) {
        s.totalResolutionMs +=
          r.completedAtUtc.getTime() - r.assignedAtUtc.getTime();
        s.resolvedCount += 1;
      }
      if (r.slaStatus !== "BREACHED") s.slaCompliantCompleted += 1;
    }
  }

  // Capacity score per reviewer is the most-recent snapshot.
  const recent = await client.reviewerWorkloadSnapshot.findMany({
    where: { teamId: input.teamId },
    orderBy: { computedAtUtc: "desc" },
    take: 500,
    select: {
      reviewerUserId: true,
      capacityScore: true,
      computedAtUtc: true,
    },
  });
  const latestCapacity = new Map<string, number>();
  for (const r of recent) {
    if (!latestCapacity.has(r.reviewerUserId)) {
      latestCapacity.set(r.reviewerUserId, r.capacityScore);
    }
  }

  const projectedRows: ReviewerPerformanceRow[] = Array.from(agg.entries())
    .map(([reviewerUserId, s]) => {
      const meanResolutionMs =
        s.resolvedCount > 0
          ? Math.round(s.totalResolutionMs / s.resolvedCount)
          : null;
      const slaComplianceRate =
        s.completedTotal > 0
          ? s.slaCompliantCompleted / s.completedTotal
          : 1;
      return {
        reviewerUserId,
        active: s.active,
        completedInRange: s.completedInRange,
        approvedInRange: s.approvedInRange,
        rejectedInRange: s.rejectedInRange,
        overdue: s.overdue,
        escalated: s.escalated,
        meanResolutionMs,
        slaComplianceRate,
        capacityScore: latestCapacity.get(reviewerUserId) ?? 100,
      };
    })
    .sort((a, b) => {
      // Heavy load first — overdue + escalated dominate.
      const aScore = a.overdue * 4 + a.escalated * 3 + a.active;
      const bScore = b.overdue * 4 + b.escalated * 3 + b.active;
      return bScore - aScore;
    })
    .slice(0, limit);

  bump("reviewer_analytics_viewed_total");

  return {
    range: {
      startUtc: startUtc.toISOString(),
      endUtc: endUtc.toISOString(),
    },
    rows: projectedRows,
  };
}
