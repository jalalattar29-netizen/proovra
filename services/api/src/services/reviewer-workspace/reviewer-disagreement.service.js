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
    return { ok: true, disagreementId: created.id };
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
    if (input.to === "UNDER_SECOND_REVIEW") {
        data["secondReviewerUserId"] = input.actorUserId;
    }
    else if (input.to === "UNDER_SUPERVISOR_REVIEW") {
        data["supervisorUserId"] = input.actorUserId;
    }
    else if (input.to.startsWith("RESOLVED_")) {
        data["resolvedAtUtc"] = now;
        if (input.verdict) {
            data["supervisorVerdict"] = input.verdict;
        }
        if (input.rationale) {
            data["supervisorRationale"] = input.rationale.slice(0, 600);
        }
        if (input.actorUserId && !row.state.startsWith("UNDER_SUPERVISOR_REVIEW")) {
            // Second-reviewer rendered a decision; record on the
            // second-reviewer columns when supervisor review hasn't begun.
            data["secondReviewerVerdict"] = input.verdict ?? null;
            data["secondReviewerRationale"] = input.rationale?.slice(0, 600) ?? null;
            data["secondReviewerDecidedAt"] = now;
        }
    }
    else if (input.to === "WITHDRAWN") {
        if (input.actorUserId !== row.challengerUserId) {
            return deny("NOT_PERMITTED");
        }
        data["withdrawnAtUtc"] = now;
    }
    await prisma.reviewerDisagreement.update({
        where: { id: row.id },
        data: data,
    });
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
