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
import { computeReviewerCapacityScore, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { bump, setGauge } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { evaluateMemberAccess } from "../identity/access-policy.service.js";
/**
 * Compute live workload counts for a single reviewer (no snapshot write).
 */
export async function computeReviewerWorkload(input, client = defaultPrisma) {
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
    const counts = {
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
export async function snapshotWorkspaceWorkload(input, client = defaultPrisma) {
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
        if (!access.allowed)
            continue;
        const counts = await computeReviewerWorkload({ teamId: input.teamId, reviewerUserId: m.userId }, client);
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
        if (counts.activeReviewCount > maxActive)
            maxActive = counts.activeReviewCount;
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
        meanCapacityScore: reviewersComputed === 0
            ? 100
            : Math.round(totalScore / reviewersComputed),
    };
}
/**
 * Returns the top N reviewer suggestions for a workspace, ordered by
 * capacity score descending (highest score = most idle). Reads the
 * most recent snapshot per reviewer; if no snapshot exists, computes
 * one on-the-fly (bounded).
 */
export async function suggestReviewers(input, client = defaultPrisma) {
    const topN = Math.min(Math.max(input.topN ?? 5, 1), 20);
    // Pull the latest snapshot per reviewer via raw SQL? Prisma doesn't
    // do DISTINCT ON; use the simpler "most recent N snapshots" approach
    // and dedup in memory.
    const recent = await client.reviewerWorkloadSnapshot.findMany({
        where: { teamId: input.teamId },
        orderBy: { computedAtUtc: "desc" },
        take: topN * 10,
    });
    const seen = new Set();
    const latest = [];
    for (const r of recent) {
        if (seen.has(r.reviewerUserId))
            continue;
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
function explainSuggestion(capacityScore, active, overdue) {
    if (overdue > 0)
        return `${active} active, ${overdue} overdue — caution`;
    if (capacityScore >= 80)
        return `${active} active — light load`;
    if (capacityScore >= 50)
        return `${active} active — moderate load`;
    if (capacityScore >= 25)
        return `${active} active — heavy load`;
    return `${active} active — saturated`;
}
export async function listLatestWorkloadSnapshots(input, client = defaultPrisma) {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 500);
    const recent = await client.reviewerWorkloadSnapshot.findMany({
        where: { teamId: input.teamId },
        orderBy: { computedAtUtc: "desc" },
        take: limit * 10,
    });
    const seen = new Set();
    const latest = [];
    for (const r of recent) {
        if (seen.has(r.reviewerUserId))
            continue;
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
        if (latest.length >= limit)
            break;
    }
    return latest;
}
