/**
 * Phase 32.8C FINAL-2 — Workflow lifecycle actions.
 *
 * Mirrors `incident.service.ts`. Every action:
 *   - Verifies the workflow exists in workspace scope.
 *   - Mutates only the bounded fields appropriate to the action.
 *   - Writes an `OperationalWorkflowEvent` history row.
 *   - Writes a `platform_audit_log` row.
 *
 * Hard rules:
 *   - No action bypasses underlying report/package/governance
 *     permissions. The dashboard does NOT trigger destructive
 *     operations like "retry now" — only operator-side mitigation
 *     bookkeeping (SCHEDULE_RETRY records intent, not execution).
 */
import * as prismaPkg from "@prisma/client";
import { prisma as defaultPrisma } from "../../db.js";
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";
export class WorkflowError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
    }
}
export async function assignWorkflow(input, client = defaultPrisma) {
    const existing = await client.operationalWorkflow.findFirst({
        where: { id: input.workflowId, teamId: input.teamId },
    });
    if (!existing)
        throw new WorkflowError("workflow_not_found");
    const fromStatus = existing.status;
    const nextStatus = existing.status === "OPEN"
        ? prismaPkg.OperationalWorkflowStatus.ASSIGNED
        : existing.status;
    const updated = await client.operationalWorkflow.update({
        where: { id: existing.id },
        data: {
            assignedOwnerUserId: input.assigneeUserId,
            assignedByUserId: input.actorUserId,
            assignedAtUtc: new Date(),
            status: nextStatus,
        },
    });
    try {
        await client.operationalWorkflowEvent.create({
            data: {
                workflowId: updated.id,
                teamId: input.teamId,
                eventType: "ASSIGNED",
                actorUserId: input.actorUserId,
                fromStatus,
                toStatus: nextStatus,
                summary: `Workflow assigned to operator ${input.assigneeUserId.slice(0, 8)}.`,
            },
        });
    }
    catch {
        /* best-effort */
    }
    await audit(client, input, updated.id, "assigned", existing);
    return updated;
}
export async function startWorkflow(input, client = defaultPrisma) {
    return transition(client, input, prismaPkg.OperationalWorkflowStatus.IN_PROGRESS, "STARTED", "started");
}
export async function escalateWorkflow(input, client = defaultPrisma) {
    const existing = await client.operationalWorkflow.findFirst({
        where: { id: input.workflowId, teamId: input.teamId },
    });
    if (!existing)
        throw new WorkflowError("workflow_not_found");
    const updated = await client.operationalWorkflow.update({
        where: { id: existing.id },
        data: {
            escalationLevel: existing.escalationLevel + 1,
            severity: existing.severity === "CRITICAL"
                ? "CRITICAL"
                : existing.severity === "HIGH"
                    ? "CRITICAL"
                    : existing.severity === "MEDIUM"
                        ? "HIGH"
                        : "MEDIUM",
            priority: existing.priority === "P0"
                ? "P0"
                : existing.priority === "P1"
                    ? "P0"
                    : existing.priority === "P2"
                        ? "P1"
                        : "P2",
        },
    });
    try {
        await client.operationalWorkflowEvent.create({
            data: {
                workflowId: updated.id,
                teamId: input.teamId,
                eventType: "ESCALATED",
                actorUserId: input.actorUserId,
                fromStatus: existing.status,
                toStatus: existing.status,
                summary: `Workflow escalated to level ${updated.escalationLevel}.`,
            },
        });
    }
    catch {
        /* best-effort */
    }
    await audit(client, input, updated.id, "escalated", existing);
    return updated;
}
export async function addMitigation(input, client = defaultPrisma) {
    const existing = await client.operationalWorkflow.findFirst({
        where: { id: input.workflowId, teamId: input.teamId },
    });
    if (!existing)
        throw new WorkflowError("workflow_not_found");
    const nextStatus = existing.status === "IN_PROGRESS" || existing.status === "ASSIGNED"
        ? prismaPkg.OperationalWorkflowStatus.MITIGATING
        : existing.status;
    const updated = await client.operationalWorkflow.update({
        where: { id: existing.id },
        data: {
            mitigationSummary: input.note.slice(0, 400),
            status: nextStatus,
        },
    });
    try {
        await client.operationalWorkflowEvent.create({
            data: {
                workflowId: updated.id,
                teamId: input.teamId,
                eventType: "MITIGATION_ADDED",
                actorUserId: input.actorUserId,
                fromStatus: existing.status,
                toStatus: nextStatus,
                summary: `Mitigation note recorded: ${input.note.slice(0, 200)}`,
            },
        });
    }
    catch {
        /* best-effort */
    }
    await audit(client, input, updated.id, "mitigation_added", existing);
    return updated;
}
export async function resolveWorkflow(input, client = defaultPrisma) {
    const existing = await client.operationalWorkflow.findFirst({
        where: { id: input.workflowId, teamId: input.teamId },
    });
    if (!existing)
        throw new WorkflowError("workflow_not_found");
    const updated = await client.operationalWorkflow.update({
        where: { id: existing.id },
        data: {
            status: prismaPkg.OperationalWorkflowStatus.RESOLVED,
            resolvedAtUtc: new Date(),
            resolutionSummary: input.note ? input.note.slice(0, 400) : null,
        },
    });
    try {
        await client.operationalWorkflowEvent.create({
            data: {
                workflowId: updated.id,
                teamId: input.teamId,
                eventType: "RESOLVED",
                actorUserId: input.actorUserId,
                fromStatus: existing.status,
                toStatus: prismaPkg.OperationalWorkflowStatus.RESOLVED,
                summary: input.note
                    ? `Workflow resolved: ${input.note.slice(0, 200)}`
                    : `Workflow resolved by operator.`,
            },
        });
    }
    catch {
        /* best-effort */
    }
    await audit(client, input, updated.id, "resolved", existing);
    return updated;
}
export async function suppressWorkflow(input, client = defaultPrisma) {
    return transition(client, input, prismaPkg.OperationalWorkflowStatus.SUPPRESSED, "SUPPRESSED", "suppressed");
}
export async function reopenWorkflow(input, client = defaultPrisma) {
    const existing = await client.operationalWorkflow.findFirst({
        where: { id: input.workflowId, teamId: input.teamId },
    });
    if (!existing)
        throw new WorkflowError("workflow_not_found");
    if (existing.status !== prismaPkg.OperationalWorkflowStatus.RESOLVED &&
        existing.status !== prismaPkg.OperationalWorkflowStatus.SUPPRESSED) {
        throw new WorkflowError("invalid_transition");
    }
    const updated = await client.operationalWorkflow.update({
        where: { id: existing.id },
        data: {
            status: prismaPkg.OperationalWorkflowStatus.OPEN,
            resolvedAtUtc: null,
            resolutionSummary: null,
        },
    });
    try {
        await client.operationalWorkflowEvent.create({
            data: {
                workflowId: updated.id,
                teamId: input.teamId,
                eventType: "REOPENED",
                actorUserId: input.actorUserId,
                fromStatus: existing.status,
                toStatus: prismaPkg.OperationalWorkflowStatus.OPEN,
                summary: "Workflow reopened by operator.",
            },
        });
    }
    catch {
        /* best-effort */
    }
    await audit(client, input, updated.id, "reopened", existing);
    return updated;
}
export async function scheduleRetry(input, client = defaultPrisma) {
    const existing = await client.operationalWorkflow.findFirst({
        where: { id: input.workflowId, teamId: input.teamId },
    });
    if (!existing)
        throw new WorkflowError("workflow_not_found");
    const updated = await client.operationalWorkflow.update({
        where: { id: existing.id },
        data: {
            nextRetryAtUtc: input.nextRetryAtUtc,
            retryCount: existing.retryCount + 1,
            lastAttemptAtUtc: new Date(),
        },
    });
    try {
        await client.operationalWorkflowEvent.create({
            data: {
                workflowId: updated.id,
                teamId: input.teamId,
                eventType: "RETRY_SCHEDULED",
                actorUserId: input.actorUserId,
                fromStatus: existing.status,
                toStatus: existing.status,
                summary: `Retry scheduled for ${input.nextRetryAtUtc.toISOString()} (attempt #${updated.retryCount}).`,
            },
        });
    }
    catch {
        /* best-effort */
    }
    await audit(client, input, updated.id, "retry_scheduled", existing);
    return updated;
}
async function transition(client, input, next, eventType, auditVerb) {
    const existing = await client.operationalWorkflow.findFirst({
        where: { id: input.workflowId, teamId: input.teamId },
    });
    if (!existing)
        throw new WorkflowError("workflow_not_found");
    const updated = await client.operationalWorkflow.update({
        where: { id: existing.id },
        data: { status: next },
    });
    try {
        await client.operationalWorkflowEvent.create({
            data: {
                workflowId: updated.id,
                teamId: input.teamId,
                eventType,
                actorUserId: input.actorUserId,
                fromStatus: existing.status,
                toStatus: next,
                summary: `Workflow ${auditVerb} by operator.`,
            },
        });
    }
    catch {
        /* best-effort */
    }
    await audit(client, input, updated.id, auditVerb, existing);
    return updated;
}
async function audit(client, input, workflowId, verb, source) {
    await appendPlatformAuditLog({
        userId: input.actorUserId,
        action: `observability.workflow.${verb}`,
        category: "observability.workflow",
        severity: "info",
        source: "workflow_service",
        outcome: "success",
        resourceType: "operational_workflow",
        resourceId: workflowId,
        metadata: {
            teamId: source.teamId,
            workflowKey: source.workflowKey,
            workflowType: source.workflowType,
            severity: source.severity,
        },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        db: client,
    });
}
/**
 * Read-side helper: returns a single workflow projection for the
 * `/v1/ops/workflows/:id` endpoint.
 */
export async function getWorkflow(input, client = defaultPrisma) {
    return client.operationalWorkflow.findFirst({
        where: { id: input.workflowId, teamId: input.teamId },
    });
}
/**
 * Read-side helper: list workflows for the workspace, with optional
 * status / type filters.
 */
export async function listWorkflows(input, client = defaultPrisma) {
    return client.operationalWorkflow.findMany({
        where: {
            teamId: input.teamId,
            ...(input.status
                ? { status: input.status }
                : {}),
            ...(input.workflowType
                ? {
                    workflowType: input.workflowType,
                }
                : {}),
        },
        orderBy: [{ severity: "desc" }, { priority: "asc" }, { updatedAt: "desc" }],
        take: Math.min(Math.max(input.limit ?? 100, 1), 500),
    });
}
