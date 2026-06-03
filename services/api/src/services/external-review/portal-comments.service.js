/**
 * PROOVRA Phase 2B — Portal comments service.
 *
 * Threaded review communication scoped to a workflow. Comments are
 * stored under the existing portal grant + workspace anchor. One
 * level of nesting only.
 */
import { prisma as defaultPrisma } from "../../db.js";
import { emitPortalActivity } from "./portal-activity.service.js";
export async function postCommentInWorkflow(input) {
    if (!input.body || input.body.length === 0 || input.body.length > 4_000) {
        return { ok: false, denial: "COMMENT_BODY_INVALID" };
    }
    const prisma = input.prisma ?? defaultPrisma;
    if (input.parentCommentId) {
        const parent = await prisma.externalReviewComment.findFirst({
            where: { id: input.parentCommentId, teamId: input.teamId },
            select: { id: true, parentCommentId: true },
        });
        if (!parent)
            return { ok: false, denial: "OUT_OF_SCOPE" };
        if (parent.parentCommentId !== null) {
            // Bounded — one level of nesting.
            return { ok: false, denial: "OUT_OF_SCOPE" };
        }
    }
    const row = await prisma.externalReviewComment.create({
        data: {
            teamId: input.teamId,
            grantId: input.grantId,
            workflowId: input.workflowId,
            parentCommentId: input.parentCommentId ?? null,
            body: input.body,
            authorEmail: input.authorEmail,
            authorDisplay: input.authorDisplay,
        },
        select: { id: true },
    });
    await emitPortalActivity({
        prisma,
        teamId: input.teamId,
        grantId: input.grantId,
        code: "COMMENT_POSTED",
        payload: { workflowId: input.workflowId, commentId: row.id },
    });
    return { ok: true, commentId: row.id };
}
export async function listCommentsForWorkflow(input) {
    const prisma = input.prisma ?? defaultPrisma;
    return prisma.externalReviewComment.findMany({
        where: { teamId: input.teamId, workflowId: input.workflowId },
        orderBy: { createdAt: "asc" },
        take: 500,
        select: {
            id: true,
            parentCommentId: true,
            body: true,
            authorEmail: true,
            authorDisplay: true,
            createdAt: true,
            resolvedAtUtc: true,
        },
    });
}
