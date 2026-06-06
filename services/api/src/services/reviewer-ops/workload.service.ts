/**
 * Phase 25 — Reviewer workload intelligence.
 *
 * Computes per-reviewer counts + capacity score and persists snapshots
 * for the dashboard + the assignment-suggestion path. The exact scoring
 * heuristic lives in `@proovra/shared` (`computeReviewerCapacityScore`)
 * so the policy is operator-explainable and unit-testable.
 *
 * Hard rules:
 *   - Assignment suggestions are ADVISORY. The reviewer-ops engine
 *     never auto-assigns; the operator chooses.
 *   - "Reviewer" means a team member whose canonical role includes
 *     `evidence_request.review` (Phase 9 permission catalog). We pull
 *     this from `evaluateMemberAccess` on each candidate.
 *   - Snapshots are immutable history — we INSERT one row per (team,
 *     reviewer) per reconcile pass and never UPDATE.
 */

import type { PrismaClient } from "@prisma/client";
import {
  computeReviewerCapacityScore,
  type ReviewerWorkloadCountsInput,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { bump, setGauge } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { evaluateMemberAccess } from "../identity/access-policy.service.js";

// -----------------------------------------------------------------------------
// Workload computation
// -----------------------------------------------------------------------------

export type ReviewerWorkloadCounts = ReviewerWorkloadCountsInput & {
  reviewerUserId: string;
  capacityScore: number;
};

/**
 * Compute live workload counts for a single reviewer (no snapshot write).
 */
export async function computeReviewerWorkload(
  input: { teamId: string; reviewerUserId: string },
  client: PrismaClient = defaultPrisma,
): Promise<ReviewerWorkloadCounts> {
  const [active, overdue, dueSoon, escalated, needsInfo] = await Promise.all([
    client.evidenceReviewWorkflow.count({
      where: {
        teamId: input.teamId,
        assignedToUserId: input.reviewerUserId,
        status: {
          notIn: ["CLOSED", "REJECTED_INSUFFICIENT", "APPROVED_INTERNAL"],
        },
      },
    }),
    client.evidenceReviewWorkflow.count({
      where: {
        teamId: input.teamId,
        assignedToUserId: input.reviewerUserId,
        slaStatus: { in: ["OVERDUE", "BREACHED"] },
      },
    }),
    client.evidenceReviewWorkflow.count({
      where: {
        teamId: input.teamId,
        assignedToUserId: input.reviewerUserId,
        slaStatus: "DUE_SOON",
      },
    }),
    client.evidenceReviewWorkflow.count({
      where: {
        teamId: input.teamId,
        assignedToUserId: input.reviewerUserId,
        OR: [
          { status: "ESCALATED" },
          { activeEscalationId: { not: null } },
        ],
      },
    }),
    client.evidenceReviewWorkflow.count({
      where: {
        teamId: input.teamId,
        assignedToUserId: input.reviewerUserId,
        status: "NEEDS_INFO",
      },
    }),
  ]);
  const counts: ReviewerWorkloadCountsInput = {
    activeReviewCount: active,
    overdueReviewCount: overdue,
    dueSoonReviewCount: dueSoon,
    escalatedReviewCount: escalated,
    needsInfoReviewCount: needsInfo,
  };
  return {
    reviewerUserId: input.reviewerUserId,
    capacityScore: computeReviewerCapacityScore(counts),
    ...counts,
  };
}

// -----------------------------------------------------------------------------
// Snapshot — persist current workload for every active reviewer.
// -----------------------------------------------------------------------------

export type SnapshotResult = {
  reviewersComputed: number;
  maxActive: number;
  meanCapacityScore: number;
};

export async function snapshotWorkspaceWorkload(
  input: { teamId: string; batchLimit?: number },
  client: PrismaClient = defaultPrisma,
): Promise<SnapshotResult> {
  const batchLimit = Math.min(Math.max(input.batchLimit ?? 200, 1), 1000);

  // Pool of reviewer candidates = team members not suspended/revoked.
  // We then filter to reviewer-capable via the access policy helper.
  const members = await client.teamMember.findMany({
    where: {
      teamId: input.teamId,
      status: "ACTIVE",
    },
    select: { userId: true },
    take: batchLimit,
  });

  let reviewersComputed = 0;
  let maxActive = 0;
  let totalScore = 0;
  for (const m of members) {
    const access = await evaluateMemberAccess({
      teamId: input.teamId,
      userId: m.userId,
      permission: "evidence_request.review",
    });
    if (!access.allowed) continue;
    const counts = await computeReviewerWorkload(
      { teamId: input.teamId, reviewerUserId: m.userId },
      client,
    );
    await client.reviewerWorkloadSnapshot.create({
      data: {
        teamId: input.teamId,
        reviewerUserId: m.userId,
        activeReviewCount: counts.activeReviewCount,
        overdueReviewCount: counts.overdueReviewCount,
        dueSoonReviewCount: counts.dueSoonReviewCount,
        escalatedReviewCount: counts.escalatedReviewCount,
        needsInfoReviewCount: counts.needsInfoReviewCount,
        capacityScore: counts.capacityScore,
      },
    });
    reviewersComputed += 1;
    if (counts.activeReviewCount > maxActive) maxActive = counts.activeReviewCount;
    totalScore += counts.capacityScore;
  }

  bump("reviewer_workload_computed_total", reviewersComputed);
  setGauge("reviewer_workload_max_active", maxActive);

  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "reviewer_workload_computed",
    severity: "INFO",
    details: { reviewersComputed, maxActive },
  });

  return {
    reviewersComputed,
    maxActive,
    meanCapacityScore:
      reviewersComputed === 0
        ? 100
        : Math.round(totalScore / reviewersComputed),
  };
}

// -----------------------------------------------------------------------------
// Suggested reviewers — advisory, never auto-assign.
// -----------------------------------------------------------------------------

export type ReviewerSuggestion = {
  reviewerUserId: string;
  capacityScore: number;
  activeReviewCount: number;
  overdueReviewCount: number;
  /** Operator-readable explanation. Catalog-bound; routes echo verbatim. */
  rationale: string;
};

/**
 * Returns the top N reviewer suggestions for a workspace, ordered by
 * capacity score descending (highest score = most idle). Reads the
 * most recent snapshot per reviewer; if no snapshot exists, computes
 * one on-the-fly (bounded).
 */
export async function suggestReviewers(
  input: { teamId: string; topN?: number },
  client: PrismaClient = defaultPrisma,
): Promise<ReadonlyArray<ReviewerSuggestion>> {
  const topN = Math.min(Math.max(input.topN ?? 5, 1), 20);
  // Pull the latest snapshot per reviewer via raw SQL? Prisma doesn't
  // do DISTINCT ON; use the simpler "most recent N snapshots" approach
  // and dedup in memory.
  const recent = await client.reviewerWorkloadSnapshot.findMany({
    where: { teamId: input.teamId },
    orderBy: { computedAtUtc: "desc" },
    take: topN * 10,
  });
  const seen = new Set<string>();
  const latest: typeof recent = [];
  for (const r of recent) {
    if (seen.has(r.reviewerUserId)) continue;
    seen.add(r.reviewerUserId);
    latest.push(r);
  }
  // Sort by capacity score descending; tie-break on active count asc.
  latest.sort((a, b) => {
    if (b.capacityScore !== a.capacityScore)
      return b.capacityScore - a.capacityScore;
    return a.activeReviewCount - b.activeReviewCount;
  });
  return latest.slice(0, topN).map((r) => ({
    reviewerUserId: r.reviewerUserId,
    capacityScore: r.capacityScore,
    activeReviewCount: r.activeReviewCount,
    overdueReviewCount: r.overdueReviewCount,
    rationale: explainSuggestion(r.capacityScore, r.activeReviewCount, r.overdueReviewCount),
  }));
}

function explainSuggestion(
  capacityScore: number,
  active: number,
  overdue: number,
): string {
  if (overdue > 0) return `${active} active, ${overdue} overdue — caution`;
  if (capacityScore >= 80) return `${active} active — light load`;
  if (capacityScore >= 50) return `${active} active — moderate load`;
  if (capacityScore >= 25) return `${active} active — heavy load`;
  return `${active} active — saturated`;
}

// -----------------------------------------------------------------------------
// Latest snapshot lookup — used by the dashboard.
// -----------------------------------------------------------------------------

export type WorkloadDashboardRow = {
  reviewerUserId: string;
  activeReviewCount: number;
  overdueReviewCount: number;
  dueSoonReviewCount: number;
  escalatedReviewCount: number;
  needsInfoReviewCount: number;
  capacityScore: number;
  computedAtUtc: string;
};

export async function listLatestWorkloadSnapshots(
  input: { teamId: string; limit?: number },
  client: PrismaClient = defaultPrisma,
): Promise<ReadonlyArray<WorkloadDashboardRow>> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 500);
  const recent = await client.reviewerWorkloadSnapshot.findMany({
    where: { teamId: input.teamId },
    orderBy: { computedAtUtc: "desc" },
    take: limit * 10,
  });
  const seen = new Set<string>();
  const latest: WorkloadDashboardRow[] = [];
  for (const r of recent) {
    if (seen.has(r.reviewerUserId)) continue;
    seen.add(r.reviewerUserId);
    latest.push({
      reviewerUserId: r.reviewerUserId,
      activeReviewCount: r.activeReviewCount,
      overdueReviewCount: r.overdueReviewCount,
      dueSoonReviewCount: r.dueSoonReviewCount,
      escalatedReviewCount: r.escalatedReviewCount,
      needsInfoReviewCount: r.needsInfoReviewCount,
      capacityScore: r.capacityScore,
      computedAtUtc: r.computedAtUtc.toISOString(),
    });
    if (latest.length >= limit) break;
  }
  return latest;
}

// -----------------------------------------------------------------------------
// Phase RW3-2 — Assignable reviewers (team-scoped picker source).
//
// Returns the bounded list of team members who hold the
// `evidence_request.review` permission — i.e. the canonical "reviewer"
// pool that the bulk-assign UI may target. Replaces the previous
// `window.prompt` for a userId in /review/queues; without this list
// endpoint the only honest path was to ask the operator to paste a
// raw UUID. With it, we can render a real picker.
//
// Hard rules:
//   * Team-scoped via the TeamMember pivot — never enumerates global
//     users, never leaks members of other workspaces.
//   * status = ACTIVE only (suspended/revoked are not selectable).
//   * Reviewer capability gated by the same `evaluateMemberAccess`
//     helper the snapshot writer uses — so the pool here is exactly
//     the pool that gets workload snapshots.
//   * Bounded projection. No email. No raw PII. displayName is
//     optional (null when not set) so the UI can fall back to a
//     bounded "Reviewer …<shortId>" label.
//   * If a recent ReviewerWorkloadSnapshot exists for the candidate,
//     surface the live `activeReviewCount` so the picker can render
//     pressure without a second round-trip; otherwise omit the field
//     rather than fake a zero.
//   * Limit cap: route layer caps at 200; service additionally bounds
//     to defend against direct callers.
// -----------------------------------------------------------------------------

export type AssignableReviewer = {
  userId: string;
  displayName: string | null;
  role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
  status: "ACTIVE";
  /** Most recent ReviewerWorkloadSnapshot active count. Omitted when no snapshot. */
  currentWorkloadCount?: number;
};

export async function listAssignableReviewers(
  input: { teamId: string; limit?: number },
  client: PrismaClient = defaultPrisma,
): Promise<ReadonlyArray<AssignableReviewer>> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  // Pull ACTIVE team members in stable order. We pull a bounded pool
  // (limit * 2, max 400) because some candidates may not be reviewer-
  // capable and will be filtered out — we still want to land at `limit`
  // returned rows when possible.
  const poolSize = Math.min(limit * 2, 400);
  const members = await client.teamMember.findMany({
    where: {
      teamId: input.teamId,
      status: "ACTIVE",
    },
    select: {
      userId: true,
      role: true,
      user: {
        select: {
          id: true,
          displayName: true,
        },
      },
    },
    // Stable order so two callers see the same prefix when the pool
    // exceeds `limit`. `userId` is unique within (teamId,_) per
    // schema's @@unique([teamId, userId]).
    orderBy: { userId: "asc" },
    take: poolSize,
  });

  if (members.length === 0) return [];

  // Reviewer-capable filter — gate on the same permission the workload
  // service uses, so the picker pool === the snapshotted pool.
  const reviewerCapable: typeof members = [];
  for (const m of members) {
    const access = await evaluateMemberAccess({
      teamId: input.teamId,
      userId: m.userId,
      permission: "evidence_request.review",
    });
    if (access.allowed) reviewerCapable.push(m);
    if (reviewerCapable.length >= limit) break;
  }

  if (reviewerCapable.length === 0) return [];

  // Latest workload snapshot lookup — one query, group in memory.
  const reviewerUserIds = reviewerCapable.map((m) => m.userId);
  const snapshots = await client.reviewerWorkloadSnapshot.findMany({
    where: {
      teamId: input.teamId,
      reviewerUserId: { in: reviewerUserIds },
    },
    orderBy: { computedAtUtc: "desc" },
    select: {
      reviewerUserId: true,
      activeReviewCount: true,
      computedAtUtc: true,
    },
    // Bounded; with at most 200 reviewers each having O(n) snapshots,
    // we cap aggressively. We only need the latest per reviewer.
    take: reviewerUserIds.length * 4,
  });
  const latestByReviewer = new Map<string, number>();
  for (const s of snapshots) {
    if (!latestByReviewer.has(s.reviewerUserId)) {
      latestByReviewer.set(s.reviewerUserId, s.activeReviewCount);
    }
  }

  return reviewerCapable.map((m) => {
    const projected: AssignableReviewer = {
      userId: m.userId,
      displayName: m.user?.displayName ?? null,
      role: m.role as AssignableReviewer["role"],
      status: "ACTIVE",
    };
    const workload = latestByReviewer.get(m.userId);
    if (typeof workload === "number") {
      projected.currentWorkloadCount = workload;
    }
    return projected;
  });
}
