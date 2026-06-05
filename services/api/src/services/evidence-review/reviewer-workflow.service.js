import * as prismaPkg from "@prisma/client";
import { prisma } from "../../db.js";
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";
import { templateIdentityAuditMetadata, } from "../templates/identity-resolver.service.js";
function toWorkflowSummary(workflow) {
    if (!workflow) {
        return {
            available: false,
            workflow: null,
        };
    }
    return {
        available: true,
        workflow: {
            id: workflow.id,
            evidenceId: workflow.evidenceId,
            workspaceType: workflow.workspaceType,
            teamId: workflow.teamId ?? null,
            status: workflow.status,
            priority: workflow.priority,
            dueAt: workflow.dueAt ? workflow.dueAt.toISOString() : null,
            lastReviewedAt: workflow.lastReviewedAt
                ? workflow.lastReviewedAt.toISOString()
                : null,
            closedAt: workflow.closedAt ? workflow.closedAt.toISOString() : null,
            createdAt: workflow.createdAt.toISOString(),
            updatedAt: workflow.updatedAt.toISOString(),
            assignedTo: workflow.assignedTo != null
                ? {
                    id: workflow.assignedTo.id,
                    email: workflow.assignedTo.email ?? null,
                    displayName: workflow.assignedTo.displayName ?? null,
                }
                : null,
            assignedBy: workflow.assignedBy != null
                ? {
                    id: workflow.assignedBy.id,
                    email: workflow.assignedBy.email ?? null,
                    displayName: workflow.assignedBy.displayName ?? null,
                }
                : null,
        },
    };
}
export async function getEvidenceReviewerWorkflow(evidenceId) {
    return prisma.evidenceReviewWorkflow.findUnique({
        where: { evidenceId },
        select: {
            id: true,
            evidenceId: true,
            workspaceType: true,
            teamId: true,
            status: true,
            priority: true,
            dueAt: true,
            lastReviewedAt: true,
            closedAt: true,
            createdAt: true,
            updatedAt: true,
            assignedTo: {
                select: {
                    id: true,
                    email: true,
                    displayName: true,
                },
            },
            assignedBy: {
                select: {
                    id: true,
                    email: true,
                    displayName: true,
                },
            },
        },
    });
}
export async function getEvidenceReviewerWorkflowSummary(evidenceId) {
    const workflow = await getEvidenceReviewerWorkflow(evidenceId);
    return toWorkflowSummary(workflow);
}
export async function listEvidenceReviewerWorkflowEvents(evidenceId) {
    const workflow = await prisma.evidenceReviewWorkflow.findUnique({
        where: { evidenceId },
        select: { id: true },
    });
    if (!workflow) {
        return [];
    }
    return prisma.evidenceReviewWorkflowEvent.findMany({
        where: { workflowId: workflow.id },
        orderBy: { createdAt: "desc" },
        take: 200,
        select: {
            id: true,
            eventType: true,
            note: true,
            previousValue: true,
            nextValue: true,
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
export async function upsertEvidenceReviewerWorkflow(params) {
    const existing = await prisma.evidenceReviewWorkflow.findUnique({
        where: { evidenceId: params.evidenceId },
        select: {
            id: true,
            status: true,
            priority: true,
            dueAt: true,
            assignedToUserId: true,
            assignedByUserId: true,
            templateSlug: true,
            templateVersion: true,
            templateDbId: true,
        },
    });
    const nextStatus = params.status ?? existing?.status ?? prismaPkg.EvidenceReviewWorkflowStatus.NOT_STARTED;
    const nextPriority = params.priority ?? existing?.priority ?? prismaPkg.EvidenceReviewWorkflowPriority.NORMAL;
    // Phase T — resolve the trio fields once so both create and update
    // branches stay in lockstep. The trio is optional: when undefined we
    // leave the row alone; when null we write NULL (legacy evidence).
    const trio = params.templateIdentity === undefined ? null : params.templateIdentity;
    const trioProvided = params.templateIdentity !== undefined;
    const workflow = existing
        ? await prisma.evidenceReviewWorkflow.update({
            where: { evidenceId: params.evidenceId },
            data: {
                assignedToUserId: params.assignedToUserId !== undefined
                    ? params.assignedToUserId
                    : existing.assignedToUserId,
                assignedByUserId: params.assignedToUserId !== undefined ? params.actorUserId : existing.assignedByUserId,
                status: nextStatus,
                priority: nextPriority,
                dueAt: params.dueAt !== undefined ? params.dueAt : existing.dueAt,
                lastReviewedAt: nextStatus === prismaPkg.EvidenceReviewWorkflowStatus.IN_REVIEW ||
                    nextStatus === prismaPkg.EvidenceReviewWorkflowStatus.APPROVED_INTERNAL ||
                    nextStatus === prismaPkg.EvidenceReviewWorkflowStatus.CLOSED
                    ? new Date()
                    : undefined,
                closedAt: nextStatus === prismaPkg.EvidenceReviewWorkflowStatus.CLOSED
                    ? new Date()
                    : null,
                // Phase T — only touch trio columns when caller opted in.
                ...(trioProvided
                    ? {
                        templateSlug: trio?.templateSlug ?? null,
                        templateVersion: trio?.templateVersion ?? null,
                        templateDbId: trio?.templateDbId ?? null,
                    }
                    : {}),
            },
        })
        : await prisma.evidenceReviewWorkflow.create({
            data: {
                evidenceId: params.evidenceId,
                workspaceType: params.workspaceType,
                teamId: params.teamId ?? null,
                assignedToUserId: params.assignedToUserId ?? null,
                assignedByUserId: params.assignedToUserId ? params.actorUserId : null,
                status: nextStatus,
                priority: nextPriority,
                dueAt: params.dueAt ?? null,
                lastReviewedAt: nextStatus === prismaPkg.EvidenceReviewWorkflowStatus.IN_REVIEW
                    ? new Date()
                    : null,
                closedAt: nextStatus === prismaPkg.EvidenceReviewWorkflowStatus.CLOSED
                    ? new Date()
                    : null,
                // Phase T — stamp trio at create time when caller provided it.
                ...(trioProvided
                    ? {
                        templateSlug: trio?.templateSlug ?? null,
                        templateVersion: trio?.templateVersion ?? null,
                        templateDbId: trio?.templateDbId ?? null,
                    }
                    : {}),
            },
        });
    // Phase T — emit bounded audit event when caller opted in AND slug exists.
    // Fire-and-forget; emission failure NEVER breaks the upsert.
    if (trioProvided && trio?.templateSlug) {
        void appendPlatformAuditLog({
            userId: params.actorUserId,
            action: "reviewer_workflow.template_identity.stamped",
            category: "reviewer_workflow",
            severity: "info",
            source: "reviewer_workflow_upsert",
            outcome: "success",
            resourceType: "evidence_review_workflow",
            resourceId: workflow.id,
            metadata: {
                ...templateIdentityAuditMetadata({
                    evidenceId: params.evidenceId,
                    source: params.templateIdentitySource ?? "capture",
                    trio,
                }),
                workflowId: workflow.id,
            },
        }).catch(() => {
            /* audit emission must never break the reviewer-workflow upsert */
        });
    }
    const events = [];
    if (!existing) {
        events.push(prisma.evidenceReviewWorkflowEvent.create({
            data: {
                workflowId: workflow.id,
                evidenceId: params.evidenceId,
                actorUserId: params.actorUserId,
                eventType: prismaPkg.EvidenceReviewWorkflowEventType.CREATED,
                nextValue: {
                    status: nextStatus,
                    priority: nextPriority,
                    assignedToUserId: params.assignedToUserId ?? null,
                    dueAt: params.dueAt?.toISOString() ?? null,
                },
                note: params.note ?? null,
            },
        }));
    }
    if (existing?.assignedToUserId !== workflow.assignedToUserId || (!existing && workflow.assignedToUserId)) {
        events.push(prisma.evidenceReviewWorkflowEvent.create({
            data: {
                workflowId: workflow.id,
                evidenceId: params.evidenceId,
                actorUserId: params.actorUserId,
                eventType: workflow.assignedToUserId
                    ? prismaPkg.EvidenceReviewWorkflowEventType.ASSIGNED
                    : prismaPkg.EvidenceReviewWorkflowEventType.UNASSIGNED,
                previousValue: { assignedToUserId: existing?.assignedToUserId ?? null },
                nextValue: { assignedToUserId: workflow.assignedToUserId ?? null },
                note: params.note ?? null,
            },
        }));
    }
    if (existing?.status !== workflow.status) {
        events.push(prisma.evidenceReviewWorkflowEvent.create({
            data: {
                workflowId: workflow.id,
                evidenceId: params.evidenceId,
                actorUserId: params.actorUserId,
                eventType: workflow.status === prismaPkg.EvidenceReviewWorkflowStatus.IN_REVIEW
                    ? prismaPkg.EvidenceReviewWorkflowEventType.REVIEW_STARTED
                    : workflow.status === prismaPkg.EvidenceReviewWorkflowStatus.APPROVED_INTERNAL
                        ? prismaPkg.EvidenceReviewWorkflowEventType.REVIEW_COMPLETED
                        : workflow.status === prismaPkg.EvidenceReviewWorkflowStatus.ESCALATED
                            ? prismaPkg.EvidenceReviewWorkflowEventType.ESCALATED
                            : workflow.status === prismaPkg.EvidenceReviewWorkflowStatus.CLOSED
                                ? prismaPkg.EvidenceReviewWorkflowEventType.CLOSED
                                : prismaPkg.EvidenceReviewWorkflowEventType.STATUS_CHANGED,
                previousValue: { status: existing?.status ?? null },
                nextValue: { status: workflow.status },
                note: params.note ?? null,
            },
        }));
    }
    if (existing?.priority !== workflow.priority) {
        events.push(prisma.evidenceReviewWorkflowEvent.create({
            data: {
                workflowId: workflow.id,
                evidenceId: params.evidenceId,
                actorUserId: params.actorUserId,
                eventType: prismaPkg.EvidenceReviewWorkflowEventType.PRIORITY_CHANGED,
                previousValue: { priority: existing?.priority ?? null },
                nextValue: { priority: workflow.priority },
                note: params.note ?? null,
            },
        }));
    }
    const existingDueAt = existing?.dueAt?.toISOString() ?? null;
    const nextDueAt = workflow.dueAt?.toISOString() ?? null;
    if (existingDueAt !== nextDueAt) {
        events.push(prisma.evidenceReviewWorkflowEvent.create({
            data: {
                workflowId: workflow.id,
                evidenceId: params.evidenceId,
                actorUserId: params.actorUserId,
                eventType: prismaPkg.EvidenceReviewWorkflowEventType.DUE_DATE_CHANGED,
                previousValue: { dueAt: existingDueAt },
                nextValue: { dueAt: nextDueAt },
                note: params.note ?? null,
            },
        }));
    }
    if (events.length > 0) {
        await prisma.$transaction(events);
    }
    return getEvidenceReviewerWorkflowSummary(params.evidenceId);
}
