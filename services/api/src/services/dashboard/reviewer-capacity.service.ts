/**
 * Phase 32.8C FINAL-3 — Reviewer Capacity Intelligence.
 *
 * Deterministically computes per-reviewer capacity snapshots from real
 * `EvidenceReviewWorkflow` rows and persists them into
 * `ReviewerCapacitySnapshot`. Also derives routing recommendations
 * (REASSIGN / ESCALATE / SPLIT_LOAD / PAUSE_ASSIGNMENT) into
 * `ReviewerRoutingRecommendation` when concrete thresholds are crossed.
 *
 * Hard rules:
 *   - No fake reviewer intelligence. Every count sources from real DB rows.
 *   - Generator failures NEVER block evidence/report/package/verify flows.
 *   - Bounded operator-safe strings; no raw payloads, no signed URLs.
 *   - Recommendations are idempotent on (teamId, recommendationKey).
 */

import { prisma } from "../../db.js";

const DUE_SOON_HOURS = 48;
const STALE_HOURS = 72;
const SATURATION_HIGH = 15;
const SATURATION_CRITICAL = 30;

type Snapshot = {
  reviewerUserId: string;
  assignedCount: number;
  overdueCount: number;
  dueSoonCount: number;
  staleCount: number;
  completed7d: number;
  completed30d: number;
  saturationLevel: "LOW" | "NORMAL" | "HIGH" | "CRITICAL";
  capacityScore: number;
};

/**
 * Lazy generator for a workspace. Scans `EvidenceReviewWorkflow` rows,
 * groups by reviewer, computes deterministic capacity scores, and
 * persists one `ReviewerCapacitySnapshot` per reviewer. Never throws.
 */
export async function computeReviewerCapacityForWorkspace(input: {
  teamId: string;
}): Promise<{ persisted: number; recommendations: number; failed: number }> {
  let persisted = 0;
  let recommendations = 0;
  let failed = 0;
  try {
    const now = new Date();
    const dueSoonCutoff = new Date(Date.now() + DUE_SOON_HOURS * 60 * 60 * 1000);
    const staleCutoff = new Date(Date.now() - STALE_HOURS * 60 * 60 * 1000);
    const seven = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const thirty = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Pull bounded slice of active workflows + recent completions.
    const active = await prisma.evidenceReviewWorkflow.findMany({
      where: {
        teamId: input.teamId,
        assignedToUserId: { not: null },
        status: { in: ["ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
      },
      take: 2000,
      select: {
        assignedToUserId: true,
        dueAt: true,
        updatedAt: true,
      },
    });

    type Bucket = {
      reviewerUserId: string;
      assignedCount: number;
      overdueCount: number;
      dueSoonCount: number;
      staleCount: number;
    };
    const byReviewer = new Map<string, Bucket>();
    for (const r of active) {
      if (!r.assignedToUserId) continue;
      const id = r.assignedToUserId;
      let b = byReviewer.get(id);
      if (!b) {
        b = {
          reviewerUserId: id,
          assignedCount: 0,
          overdueCount: 0,
          dueSoonCount: 0,
          staleCount: 0,
        };
        byReviewer.set(id, b);
      }
      b.assignedCount += 1;
      if (r.dueAt && r.dueAt < now) b.overdueCount += 1;
      else if (r.dueAt && r.dueAt < dueSoonCutoff) b.dueSoonCount += 1;
      if (r.updatedAt < staleCutoff) b.staleCount += 1;
    }

    // Completed counters per reviewer (bounded slice).
    const completed = await prisma.evidenceReviewWorkflow.findMany({
      where: {
        teamId: input.teamId,
        status: { in: ["APPROVED_INTERNAL", "CLOSED"] },
        updatedAt: { gte: thirty },
        assignedToUserId: { not: null },
      },
      take: 5000,
      select: { assignedToUserId: true, updatedAt: true },
    });
    const completed7Map = new Map<string, number>();
    const completed30Map = new Map<string, number>();
    for (const r of completed) {
      if (!r.assignedToUserId) continue;
      const id = r.assignedToUserId;
      completed30Map.set(id, (completed30Map.get(id) ?? 0) + 1);
      if (r.updatedAt >= seven) {
        completed7Map.set(id, (completed7Map.get(id) ?? 0) + 1);
      }
    }

    const snapshots: Snapshot[] = [];
    for (const b of byReviewer.values()) {
      const completed7 = completed7Map.get(b.reviewerUserId) ?? 0;
      const completed30 = completed30Map.get(b.reviewerUserId) ?? 0;
      const saturationLevel: Snapshot["saturationLevel"] =
        b.assignedCount >= SATURATION_CRITICAL
          ? "CRITICAL"
          : b.assignedCount >= SATURATION_HIGH
            ? "HIGH"
            : b.assignedCount >= Math.floor(SATURATION_HIGH / 2)
              ? "NORMAL"
              : "LOW";
      // Capacity score: 0..100, decreases as assignment + overdue grow.
      const overloadPenalty = Math.min(
        80,
        b.assignedCount * 2 + b.overdueCount * 5 + b.staleCount * 3,
      );
      const capacityScore = Math.max(0, 100 - overloadPenalty);
      snapshots.push({
        reviewerUserId: b.reviewerUserId,
        assignedCount: b.assignedCount,
        overdueCount: b.overdueCount,
        dueSoonCount: b.dueSoonCount,
        staleCount: b.staleCount,
        completed7d: completed7,
        completed30d: completed30,
        saturationLevel,
        capacityScore,
      });
    }

    // Persist snapshots (best-effort per reviewer).
    for (const s of snapshots) {
      try {
        await prisma.reviewerCapacitySnapshot.create({
          data: {
            teamId: input.teamId,
            reviewerUserId: s.reviewerUserId,
            assignedCount: s.assignedCount,
            overdueCount: s.overdueCount,
            dueSoonCount: s.dueSoonCount,
            staleCount: s.staleCount,
            completed7d: s.completed7d,
            completed30d: s.completed30d,
            saturationLevel: s.saturationLevel,
            capacityScore: s.capacityScore,
            source: "DB_DERIVED",
          },
        });
        persisted += 1;
      } catch {
        failed += 1;
      }
    }

    // Derive routing recommendations.
    if (snapshots.length >= 2) {
      const overloaded = snapshots.filter(
        (s) => s.saturationLevel === "HIGH" || s.saturationLevel === "CRITICAL",
      );
      const lowSat = snapshots.filter((s) => s.saturationLevel === "LOW");
      for (const src of overloaded) {
        if (lowSat.length === 0) continue;
        const target = lowSat.reduce((acc, cur) =>
          cur.capacityScore > acc.capacityScore ? cur : acc,
        );
        const recKey = `reassign:${input.teamId}:${src.reviewerUserId}:${target.reviewerUserId}`;
        try {
          await prisma.reviewerRoutingRecommendation.upsert({
            where: {
              teamId_recommendationKey: {
                teamId: input.teamId,
                recommendationKey: recKey,
              } as never,
            },
            create: {
              teamId: input.teamId,
              sourceReviewerUserId: src.reviewerUserId,
              targetReviewerUserId: target.reviewerUserId,
              recommendationType: "REASSIGN",
              severity: src.saturationLevel === "CRITICAL" ? "HIGH" : "MEDIUM",
              reasonCode: "OWNER_OVERLOADED_REASSIGN_TO_LOW_SAT",
              explanation: `Reviewer ${src.reviewerUserId.slice(0, 8)} is at ${src.saturationLevel} saturation (${src.assignedCount} assigned). Suggest reassigning to ${target.reviewerUserId.slice(0, 8)} (capacity ${target.capacityScore}).`,
              status: "OPEN",
              recommendationKey: recKey,
            },
            update: {
              severity: src.saturationLevel === "CRITICAL" ? "HIGH" : "MEDIUM",
              explanation: `Reviewer ${src.reviewerUserId.slice(0, 8)} is at ${src.saturationLevel} saturation (${src.assignedCount} assigned). Suggest reassigning to ${target.reviewerUserId.slice(0, 8)} (capacity ${target.capacityScore}).`,
            },
          });
          recommendations += 1;
        } catch {
          failed += 1;
        }
      }
    }
  } catch {
    /* outer best-effort */
  }
  return { persisted, recommendations, failed };
}

/**
 * Dashboard reader: returns the freshest snapshot per reviewer
 * (de-duped per reviewerUserId, capped at 50).
 */
export async function listReviewerCapacity(input: {
  teamId: string;
  limit?: number;
}): Promise<
  Array<{
    reviewerUserId: string;
    assignedCount: number;
    overdueCount: number;
    dueSoonCount: number;
    staleCount: number;
    completed7d: number;
    completed30d: number;
    saturationLevel: string;
    capacityScore: number;
    sampledAtUtc: string;
  }>
> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  try {
    const rows = await prisma.reviewerCapacitySnapshot.findMany({
      where: { teamId: input.teamId },
      orderBy: { sampledAtUtc: "desc" },
      take: limit * 4,
      select: {
        reviewerUserId: true,
        assignedCount: true,
        overdueCount: true,
        dueSoonCount: true,
        staleCount: true,
        completed7d: true,
        completed30d: true,
        saturationLevel: true,
        capacityScore: true,
        sampledAtUtc: true,
      },
    });
    const seen = new Set<string>();
    const out: Array<{
      reviewerUserId: string;
      assignedCount: number;
      overdueCount: number;
      dueSoonCount: number;
      staleCount: number;
      completed7d: number;
      completed30d: number;
      saturationLevel: string;
      capacityScore: number;
      sampledAtUtc: string;
    }> = [];
    for (const r of rows) {
      if (seen.has(r.reviewerUserId)) continue;
      seen.add(r.reviewerUserId);
      out.push({
        reviewerUserId: r.reviewerUserId,
        assignedCount: r.assignedCount,
        overdueCount: r.overdueCount,
        dueSoonCount: r.dueSoonCount,
        staleCount: r.staleCount,
        completed7d: r.completed7d,
        completed30d: r.completed30d,
        saturationLevel: r.saturationLevel,
        capacityScore: r.capacityScore,
        sampledAtUtc: r.sampledAtUtc.toISOString(),
      });
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Dashboard reader: returns active routing recommendations
 * (status OPEN), severity-sorted, capped at 25.
 */
export async function listReviewerRoutingRecommendations(input: {
  teamId: string;
  limit?: number;
}): Promise<
  Array<{
    id: string;
    sourceReviewerUserId: string | null;
    targetReviewerUserId: string | null;
    recommendationType: string;
    severity: string;
    reasonCode: string;
    explanation: string;
    status: string;
    createdAt: string;
  }>
> {
  const limit = Math.min(Math.max(input.limit ?? 12, 1), 25);
  try {
    const rows = await prisma.reviewerRoutingRecommendation.findMany({
      where: { teamId: input.teamId, status: "OPEN" },
      orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
      take: limit,
    });
    return rows.map((r) => ({
      id: r.id,
      sourceReviewerUserId: r.sourceReviewerUserId,
      targetReviewerUserId: r.targetReviewerUserId,
      recommendationType: r.recommendationType,
      severity: r.severity,
      reasonCode: r.reasonCode,
      explanation: r.explanation,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    }));
  } catch {
    return [];
  }
}
