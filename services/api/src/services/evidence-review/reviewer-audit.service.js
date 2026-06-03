import { prisma } from "../../db.js";
export async function appendReviewerAuditEvent(params) {
    return prisma.evidenceReviewerAuditEvent.create({
        data: {
            evidenceId: params.evidenceId,
            actorUserId: params.actorUserId ?? null,
            eventType: params.eventType,
            metadata: params.metadata ?? undefined,
        },
    });
}
export async function listReviewerAuditEvents(evidenceId) {
    return prisma.evidenceReviewerAuditEvent.findMany({
        where: { evidenceId },
        orderBy: { createdAt: "desc" },
        take: 200,
        select: {
            id: true,
            eventType: true,
            metadata: true,
            createdAt: true,
            actor: {
                select: {
                    id: true,
                    email: true,
                    displayName: true,
                },
            },
        },
    });
}
