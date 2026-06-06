/**
 * PROOVRA Phase 2A — Reviewer Disagreement service.
 *
 * State machine for challenging another reviewer's decision:
 *
 *   FILED → UNDER_SECOND_REVIEW → UNDER_SUPERVISOR_REVIEW → RESOLVED_*
 *                              ↘ RESOLVED_*           ↗
 *                              ↘ WITHDRAWN
 *
 * Hard rules:
 *   * The challenger cannot be the original decision reviewer
 *     (DISAGREEMENT_SELF_FILE).
 *   * Every transition is checked against
 *     `isAllowedDisagreementTransition`.
 *   * Workspace-anchored reads + bounded denial reasons.
 */
import { DISAGREEMENT_STATES, isAllowedDisagreementTransition, REVIEWER_VERDICTS, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
// Phase 4 — wire audit emission via the canonical platform audit log.
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";
export async function fileDisagreement(input) {
    const prisma = input.prisma ?? defaultPrisma;
    if (!input.rationale || input.rationale.length === 0 || input.rationale.length > 600) {
        return deny("RATIONALE_REQUIRED");
    }
    const decision = await prisma.workflowReviewDecision.findFirst({
        where: {
            id: input.originalDecisionId,
            workflowId: input.workflowId,
            teamId: input.teamId,
        },
        select: { id: true, reviewerUserId: true },
    });
    if (!decision)
        return deny("DISAGREEMENT_NOT_FOUND");
    if (decision.reviewerUserId === input.challengerUserId) {
        return deny("DISAGREEMENT_SELF_FILE");
    }
    const created = await prisma.reviewerDisagreement.create({
        data: {
            teamId: input.teamId,
            workflowId: input.workflowId,
            originalDecisionId: input.originalDecisionId,
            state: "FILED",
            challengerUserId: input.challengerUserId,
            challengerRationale: input.rationale,
        },
        select: { id: true },
    });
    // Phase 4 — best-effort audit emission. Bounded metadata: IDs only.
    await appendPlatformAuditLog({
        userId: input.challengerUserId,
        action: "reviewer.disagreement.filed",
        category: "review",
        severity: "info",
        source: "reviewer_workspace.disagreement",
        outcome: "success",
        resourceType: "reviewer_disagreement",
        resourceId: created.id,
        metadata: {
            teamId: input.teamId,
            workflowId: input.workflowId,
            disagreementId: created.id,
            originalDecisionId: input.originalDecisionId,
            challengerUserId: input.challengerUserId,
        },
    }).catch(() => { });
    return { ok: true, disagreementId: created.id };
}
const DISAGREEMENT_RATIONALE_MAX = 600;
const DISAGREEMENT_RESOLUTION_MAX = 800;
function buildResolutionSummary(input) {
    const payload = {
        verdict: input.verdict,
        rationale: input.rationale,
        actorStage: input.actorStage,
    };
    const summary = JSON.stringify(payload);
    return summary.length > 0
        ? summary.slice(0, DISAGREEMENT_RESOLUTION_MAX)
        : null;
}
export async function transitionDisagreement(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const row = await prisma.reviewerDisagreement.findFirst({
        where: { id: input.disagreementId, teamId: input.teamId },
        select: { id: true, state: true, challengerUserId: true },
    });
    if (!row)
        return deny("DISAGREEMENT_NOT_FOUND");
    if (!DISAGREEMENT_STATES.includes(input.to) ||
        !isAllowedDisagreementTransition(row.state, input.to)) {
        return deny("DISAGREEMENT_STATE_INVALID");
    }
    const verdictRequired = input.to.startsWith("RESOLVED_") ||
        input.to === "UNDER_SECOND_REVIEW" ||
        input.to === "UNDER_SUPERVISOR_REVIEW";
    if (verdictRequired &&
        (!input.verdict ||
            !REVIEWER_VERDICTS.includes(input.verdict))) {
        if (input.to !== "UNDER_SECOND_REVIEW" && input.to !== "UNDER_SUPERVISOR_REVIEW") {
            return deny("VERDICT_REQUIRED");
        }
    }
    const now = new Date();
    const data = { state: input.to };
    const trimmedRationale = input.rationale && input.rationale.trim().length > 0
        ? input.rationale.trim().slice(0, DISAGREEMENT_RATIONALE_MAX)
        : null;
    if (input.to === "UNDER_SECOND_REVIEW") {
        data["secondReviewerUserId"] = input.actorUserId;
    }
    else if (input.to === "UNDER_SUPERVISOR_REVIEW") {
        data["supervisorUserId"] = input.actorUserId;
    }
    else if (input.to.startsWith("RESOLVED_")) {
        const actorStage = row.state.startsWith("UNDER_SUPERVISOR_REVIEW")
            ? "SUPERVISOR"
            : "SECOND_REVIEW";
        data["resolvedAtUtc"] = now;
        data["resolvedByUserId"] = input.actorUserId;
        data["resolution"] = buildResolutionSummary({
            verdict: input.verdict ?? null,
            rationale: trimmedRationale,
            actorStage,
        });
    }
    else if (input.to === "WITHDRAWN") {
        if (input.actorUserId !== row.challengerUserId) {
            return deny("NOT_PERMITTED");
        }
    }
    await prisma.reviewerDisagreement.update({
        where: { id: row.id },
        data: data,
    });
    // Phase 4 — best-effort audit emission for state transitions.
    await appendPlatformAuditLog({
        userId: input.actorUserId,
        action: "reviewer.disagreement.transitioned",
        category: "review",
        severity: "info",
        source: "reviewer_workspace.disagreement",
        outcome: "success",
        resourceType: "reviewer_disagreement",
        resourceId: row.id,
        metadata: {
            teamId: input.teamId,
            disagreementId: row.id,
            fromState: row.state,
            toState: input.to,
            resolution: input.verdict ?? null,
            actorUserId: input.actorUserId,
        },
    }).catch(() => { });
    return { ok: true };
}
export async function listDisagreements(input) {
    const prisma = input.prisma ?? defaultPrisma;
    return prisma.reviewerDisagreement.findMany({
        where: {
            teamId: input.teamId,
            ...(input.state ? { state: input.state } : {}),
            ...(input.forUserId
                ? {
                    OR: [
                        { challengerUserId: input.forUserId },
                        { secondReviewerUserId: input.forUserId },
                        { supervisorUserId: input.forUserId },
                    ],
                }
                : {}),
        },
        orderBy: { filedAtUtc: "desc" },
        take: Math.min(input.limit ?? 50, 200),
    });
}
function deny(reason) {
    return { ok: false, denial: reason };
}
