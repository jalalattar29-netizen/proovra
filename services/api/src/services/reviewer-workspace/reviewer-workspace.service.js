/**
 * PROOVRA Phase 2A — Reviewer Workspace aggregator.
 *
 * Single read that returns the bounded `ReviewerWorkspaceProjection`
 * shape the workspace UI consumes. Composes:
 *
 *   * Reviewer role + capabilities (reviewer-roles.ts)
 *   * Queue counts per bounded state (EvidenceReviewWorkflow)
 *   * Disagreement counts (ReviewerDisagreement)
 *   * QC counts + 7-day accuracy (qc-sample.service.ts)
 *   * Metrics ribbon (reviewer-metrics-aggregator.service.ts)
 *
 * Hard rules:
 *   * Workspace-anchored: every count filters on teamId.
 *   * Bounded shape — no provider raw bytes, no operator-internal
 *     identifiers beyond what the UI needs.
 */
import { REVIEWER_WORKSPACE_SCHEMA_VERSION, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { resolveReviewerRole } from "./reviewer-roles.js";
import { getQcAccuracy7d } from "./qc-sample.service.js";
import { getReviewerMetrics7d } from "./reviewer-metrics.service.js";
export async function projectReviewerWorkspace(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const roleResolution = resolveReviewerRole({
        workspaceRole: input.workspaceRole,
        isPlatformAdmin: input.isPlatformAdmin,
        reviewerRoleOverride: input.reviewerRoleOverride ?? null,
    });
    if (!roleResolution.role)
        return null;
    const sinceWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [assigned, unassigned, inProgress, escalated, completed, qcRow, challengerActive, awaitingAdj, resolvedWeek, metrics, activeReview,] = await Promise.all([
        prisma.evidenceReviewWorkflow.count({
            where: { teamId: input.teamId, assignedToUserId: input.userId, status: { in: ["ASSIGNED", "QUEUED"] } },
        }),
        prisma.evidenceReviewWorkflow.count({
            where: { teamId: input.teamId, assignedToUserId: null, status: "QUEUED" },
        }),
        prisma.evidenceReviewWorkflow.count({
            where: { teamId: input.teamId, status: "IN_REVIEW" },
        }),
        prisma.evidenceReviewWorkflow.count({
            where: { teamId: input.teamId, status: "ESCALATED" },
        }),
        prisma.evidenceReviewWorkflow.count({
            where: {
                teamId: input.teamId,
                status: { in: ["APPROVED_INTERNAL", "REJECTED_INSUFFICIENT", "CLOSED"] },
            },
        }),
        getQcAccuracy7d({ prisma, teamId: input.teamId }),
        prisma.reviewerDisagreement.count({
            where: {
                teamId: input.teamId,
                challengerUserId: input.userId,
                state: { in: ["FILED", "UNDER_SECOND_REVIEW", "UNDER_SUPERVISOR_REVIEW"] },
            },
        }),
        prisma.reviewerDisagreement.count({
            where: {
                teamId: input.teamId,
                state: { in: ["UNDER_SECOND_REVIEW", "UNDER_SUPERVISOR_REVIEW"] },
            },
        }),
        prisma.reviewerDisagreement.count({
            where: {
                teamId: input.teamId,
                resolvedAtUtc: { gte: sinceWeek },
            },
        }),
        getReviewerMetrics7d({ prisma, teamId: input.teamId, userId: input.userId }),
        prisma.evidenceReviewWorkflow.findFirst({
            where: {
                teamId: input.teamId,
                assignedToUserId: input.userId,
                status: { in: ["ASSIGNED", "IN_REVIEW"] },
            },
            orderBy: [{ priority: "desc" }, { dueAt: "asc" }],
            select: {
                id: true,
                evidenceId: true,
                codingSchemaId: true,
                codingSchemaVersion: true,
            },
        }),
    ]);
    // Pending QC samples — visible to QC reviewers + supervisors.
    const pendingSamples = await prisma.qcSample.count({
        where: { teamId: input.teamId, state: { in: ["SAMPLED", "ASSIGNED", "IN_PROGRESS"] } },
    });
    return {
        schemaVersion: REVIEWER_WORKSPACE_SCHEMA_VERSION,
        generatedAtUtc: new Date().toISOString(),
        role: roleResolution.role,
        capabilities: roleResolution.capabilities,
        queues: {
            assigned,
            unassigned,
            in_progress: inProgress,
            escalated,
            qc: pendingSamples,
            completed,
        },
        disagreements: {
            asChallenger: challengerActive,
            awaitingAdjudication: awaitingAdj,
            resolvedThisWeek: resolvedWeek,
        },
        qc: {
            pendingSamples,
            rendered7d: qcRow.rendered,
            failureRate7dPct: qcRow.failureRatePct,
        },
        metrics: {
            throughput7d: metrics.throughput7d,
            approvalRate7dPct: metrics.approvalRate7dPct,
            escalationRate7dPct: metrics.escalationRate7dPct,
            avgReviewDurationMs7d: metrics.avgReviewDurationMs7d,
        },
        activeReview: activeReview
            ? {
                workflowId: activeReview.id,
                evidenceId: activeReview.evidenceId,
                codingSchemaId: activeReview.codingSchemaId,
                codingSchemaVersion: activeReview.codingSchemaVersion,
            }
            : null,
    };
}
