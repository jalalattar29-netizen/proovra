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

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";

export type WorkflowErrorCode =
  | "workflow_not_found"
  | "invalid_transition";

export class WorkflowError extends Error {
  code: WorkflowErrorCode;
  constructor(code: WorkflowErrorCode) {
    super(code);
    this.code = code;
  }
}

export type WorkflowActorContext = {
  actorUserId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export type AssignWorkflowInput = WorkflowActorContext & {
  workflowId: string;
  teamId: string;
  assigneeUserId: string;
};

export async function assignWorkflow(
  input: AssignWorkflowInput,
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.OperationalWorkflow> {
  const existing = await client.operationalWorkflow.findFirst({
    where: { id: input.workflowId, teamId: input.teamId },
  });
  if (!existing) throw new WorkflowError("workflow_not_found");
  const fromStatus = existing.status;
  const nextStatus =
    existing.status === "OPEN"
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
  } catch {
    /* best-effort */
  }
  await audit(client, input, updated.id, "assigned", existing);
  return updated;
}

export async function startWorkflow(
  input: WorkflowActorContext & { workflowId: string; teamId: string },
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.OperationalWorkflow> {
  return transition(client, input, prismaPkg.OperationalWorkflowStatus.IN_PROGRESS, "STARTED", "started");
}

export async function escalateWorkflow(
  input: WorkflowActorContext & { workflowId: string; teamId: string },
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.OperationalWorkflow> {
  const existing = await client.operationalWorkflow.findFirst({
    where: { id: input.workflowId, teamId: input.teamId },
  });
  if (!existing) throw new WorkflowError("workflow_not_found");
  const updated = await client.operationalWorkflow.update({
    where: { id: existing.id },
    data: {
      escalationLevel: existing.escalationLevel + 1,
      severity:
        existing.severity === "CRITICAL"
          ? "CRITICAL"
          : existing.severity === "HIGH"
            ? "CRITICAL"
            : existing.severity === "MEDIUM"
              ? "HIGH"
              : "MEDIUM",
      priority:
        existing.priority === "P0"
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
  } catch {
    /* best-effort */
  }
  await audit(client, input, updated.id, "escalated", existing);
  return updated;
}

export async function addMitigation(
  input: WorkflowActorContext & {
    workflowId: string;
    teamId: string;
    note: string;
  },
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.OperationalWorkflow> {
  const existing = await client.operationalWorkflow.findFirst({
    where: { id: input.workflowId, teamId: input.teamId },
  });
  if (!existing) throw new WorkflowError("workflow_not_found");
  const nextStatus =
    existing.status === "IN_PROGRESS" || existing.status === "ASSIGNED"
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
  } catch {
    /* best-effort */
  }
  await audit(client, input, updated.id, "mitigation_added", existing);
  return updated;
}

export async function resolveWorkflow(
  input: WorkflowActorContext & {
    workflowId: string;
    teamId: string;
    note?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.OperationalWorkflow> {
  const existing = await client.operationalWorkflow.findFirst({
    where: { id: input.workflowId, teamId: input.teamId },
  });
  if (!existing) throw new WorkflowError("workflow_not_found");
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
  } catch {
    /* best-effort */
  }
  await audit(client, input, updated.id, "resolved", existing);
  return updated;
}

export async function suppressWorkflow(
  input: WorkflowActorContext & { workflowId: string; teamId: string },
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.OperationalWorkflow> {
  return transition(client, input, prismaPkg.OperationalWorkflowStatus.SUPPRESSED, "SUPPRESSED", "suppressed");
}

export async function reopenWorkflow(
  input: WorkflowActorContext & { workflowId: string; teamId: string },
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.OperationalWorkflow> {
  const existing = await client.operationalWorkflow.findFirst({
    where: { id: input.workflowId, teamId: input.teamId },
  });
  if (!existing) throw new WorkflowError("workflow_not_found");
  if (
    existing.status !== prismaPkg.OperationalWorkflowStatus.RESOLVED &&
    existing.status !== prismaPkg.OperationalWorkflowStatus.SUPPRESSED
  ) {
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
  } catch {
    /* best-effort */
  }
  await audit(client, input, updated.id, "reopened", existing);
  return updated;
}

export async function scheduleRetry(
  input: WorkflowActorContext & {
    workflowId: string;
    teamId: string;
    nextRetryAtUtc: Date;
  },
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.OperationalWorkflow> {
  const existing = await client.operationalWorkflow.findFirst({
    where: { id: input.workflowId, teamId: input.teamId },
  });
  if (!existing) throw new WorkflowError("workflow_not_found");
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
  } catch {
    /* best-effort */
  }
  await audit(client, input, updated.id, "retry_scheduled", existing);
  return updated;
}

async function transition(
  client: PrismaClient,
  input: WorkflowActorContext & { workflowId: string; teamId: string },
  next: prismaPkg.OperationalWorkflowStatus,
  eventType:
    | "STARTED"
    | "SUPPRESSED",
  auditVerb: "started" | "suppressed",
): Promise<prismaPkg.OperationalWorkflow> {
  const existing = await client.operationalWorkflow.findFirst({
    where: { id: input.workflowId, teamId: input.teamId },
  });
  if (!existing) throw new WorkflowError("workflow_not_found");
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
  } catch {
    /* best-effort */
  }
  await audit(client, input, updated.id, auditVerb, existing);
  return updated;
}

async function audit(
  client: PrismaClient,
  input: WorkflowActorContext,
  workflowId: string,
  verb: string,
  source: prismaPkg.OperationalWorkflow,
): Promise<void> {
  await emitTenantAudit(
    {
      action: `observability.workflow.${verb}`,
      outcome: "success",
      sourceApp: "API",
      actorUserId: input.actorUserId,
      workspaceId: source.teamId,
      resourceType: "operational_workflow",
      resourceId: workflowId,
      metadata: {
        workflowKey: source.workflowKey,
        workflowType: source.workflowType,
        severity: source.severity,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
    },
    client,
  );
}

/**
 * Read-side helper: returns a single workflow projection for the
 * `/v1/ops/workflows/:id` endpoint.
 */
export async function getWorkflow(
  input: { workflowId: string; teamId: string },
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.OperationalWorkflow | null> {
  return client.operationalWorkflow.findFirst({
    where: { id: input.workflowId, teamId: input.teamId },
  });
}

/**
 * Read-side helper: list workflows for the workspace, with optional
 * status / type filters.
 */
export async function listWorkflows(
  input: {
    teamId: string;
    status?: string;
    workflowType?: string;
    limit?: number;
  },
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.OperationalWorkflow[]> {
  return client.operationalWorkflow.findMany({
    where: {
      teamId: input.teamId,
      ...(input.status
        ? { status: input.status as prismaPkg.OperationalWorkflowStatus }
        : {}),
      ...(input.workflowType
        ? {
            workflowType: input.workflowType as prismaPkg.OperationalWorkflowType,
          }
        : {}),
    },
    orderBy: [{ severity: "desc" }, { priority: "asc" }, { updatedAt: "desc" }],
    take: Math.min(Math.max(input.limit ?? 100, 1), 500),
  });
}
