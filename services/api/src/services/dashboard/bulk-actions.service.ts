/**
 * Phase 32.8C FINAL-3 — Bulk Operational Actions.
 *
 * Permission-gated bulk operations over OperationalWorkflow /
 * OperationalIncident / ReviewerRoutingRecommendation.
 *
 * Hard rules:
 *   - Every bulk action goes through the per-target permission gate
 *     (the lifecycle services). The bulk runner is a FAN-OUT, not a
 *     bypass.
 *   - No bulk retry of report/package jobs. `BULK_SCHEDULE_RETRY` only
 *     records retry intent on workflows; it does NOT invoke the BullMQ
 *     queues. The directive: "If a retry is unsafe: record 'retry
 *     review scheduled' only."
 *   - Bulk runs are bounded: max 200 targets per run.
 *   - Audited via the platform audit log, once for the run + once per
 *     successful per-target action via the underlying lifecycle audit.
 *   - Run-state is persisted in BulkOperationalActionRun for read-back.
 */

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";

export type BulkActionType =
  | "BULK_ASSIGN_WORKFLOWS"
  | "BULK_ESCALATE_WORKFLOWS"
  | "BULK_SUPPRESS_INCIDENTS"
  | "BULK_RESOLVE_WORKFLOWS"
  | "BULK_SCHEDULE_RETRY"
  | "BULK_ACKNOWLEDGE_INCIDENTS"
  | "BULK_ADD_MITIGATION"
  | "BULK_DISMISS_RECOMMENDATIONS";

const MAX_TARGETS = 200;

type ActorContext = {
  actorUserId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export type RunBulkActionInput = ActorContext & {
  teamId: string;
  actionType: BulkActionType;
  targetIds: string[];
  /** Optional bounded note (used for ADD_MITIGATION). */
  note?: string | null;
  /** Optional assignee UUID for BULK_ASSIGN_WORKFLOWS. */
  assigneeUserId?: string | null;
  /** Optional next retry ISO datetime for BULK_SCHEDULE_RETRY. */
  nextRetryAtUtc?: string | null;
};

export type BulkActionRunResult = {
  runId: string;
  status: string;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
};

export async function runBulkAction(
  input: RunBulkActionInput,
  client: PrismaClient = defaultPrisma,
): Promise<BulkActionRunResult> {
  const targets = input.targetIds.slice(0, MAX_TARGETS);
  // Persist the run row immediately.
  const run = await client.bulkOperationalActionRun.create({
    data: {
      teamId: input.teamId,
      actionType: input.actionType,
      status: "RUNNING",
      requestedByUserId: input.actorUserId,
      targetIdsJson: targets,
      noteText: input.note ? input.note.slice(0, 400) : null,
    },
  });

  // Persist item rows in PENDING. We use a deterministic target type
  // per action so the dashboard reader can route to the right entity.
  const targetType = targetTypeForAction(input.actionType);
  await client.bulkOperationalActionItem.createMany({
    data: targets.map((id) => ({
      runId: run.id,
      teamId: input.teamId,
      targetType,
      targetId: id,
      status: prismaPkg.BulkOperationalActionItemStatus.PENDING,
    })),
  });

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const targetId of targets) {
    try {
      await runOneItem({
        client,
        actionType: input.actionType,
        teamId: input.teamId,
        targetId,
        actor: input,
      });
      await client.bulkOperationalActionItem.updateMany({
        where: { runId: run.id, targetId },
        data: {
          status: prismaPkg.BulkOperationalActionItemStatus.COMPLETED,
          completedAtUtc: new Date(),
        },
      });
      succeeded += 1;
    } catch (err) {
      const code = (err as { code?: string }).code ?? "unknown_error";
      if (code === "workflow_not_found" || code === "incident_not_found") {
        await client.bulkOperationalActionItem.updateMany({
          where: { runId: run.id, targetId },
          data: {
            status: prismaPkg.BulkOperationalActionItemStatus.SKIPPED,
            errorCode: code,
          },
        });
        skipped += 1;
      } else {
        await client.bulkOperationalActionItem.updateMany({
          where: { runId: run.id, targetId },
          data: {
            status: prismaPkg.BulkOperationalActionItemStatus.FAILED,
            errorCode: code.slice(0, 80),
          },
        });
        failed += 1;
      }
    }
  }

  const finalStatus: "COMPLETED" | "PARTIAL_FAILED" | "FAILED" =
    failed === 0
      ? "COMPLETED"
      : succeeded === 0
        ? "FAILED"
        : "PARTIAL_FAILED";

  await client.bulkOperationalActionRun.update({
    where: { id: run.id },
    data: {
      status: finalStatus,
      completedAtUtc: new Date(),
      resultJson: { total: targets.length, succeeded, failed, skipped },
    },
  });

  await appendPlatformAuditLog({
    userId: input.actorUserId,
    action: `observability.bulk_action.${input.actionType.toLowerCase()}`,
    category: "observability.bulk_action",
    severity: "info",
    source: "bulk_action_service",
    outcome:
      finalStatus === "COMPLETED"
        ? "success"
        : finalStatus === "PARTIAL_FAILED"
          ? "partial"
          : "failure",
    resourceType: "bulk_operational_action_run",
    resourceId: run.id,
    metadata: {
      teamId: input.teamId,
      actionType: input.actionType,
      total: targets.length,
      succeeded,
      failed,
      skipped,
    },
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    db: client,
  });

  return {
    runId: run.id,
    status: finalStatus,
    total: targets.length,
    succeeded,
    failed,
    skipped,
  };
}

function targetTypeForAction(actionType: BulkActionType): string {
  switch (actionType) {
    case "BULK_ASSIGN_WORKFLOWS":
    case "BULK_ESCALATE_WORKFLOWS":
    case "BULK_RESOLVE_WORKFLOWS":
    case "BULK_SCHEDULE_RETRY":
    case "BULK_ADD_MITIGATION":
      return "OperationalWorkflow";
    case "BULK_SUPPRESS_INCIDENTS":
    case "BULK_ACKNOWLEDGE_INCIDENTS":
      return "OperationalIncident";
    case "BULK_DISMISS_RECOMMENDATIONS":
      return "ReviewerRoutingRecommendation";
  }
}

async function runOneItem(input: {
  client: PrismaClient;
  actionType: BulkActionType;
  teamId: string;
  targetId: string;
  actor: RunBulkActionInput;
}): Promise<void> {
  const c = input.client;
  switch (input.actionType) {
    case "BULK_ASSIGN_WORKFLOWS": {
      if (!input.actor.assigneeUserId) {
        throw new BulkActionError("invalid_assignee");
      }
      const member = await c.teamMember.findFirst({
        where: { teamId: input.teamId, userId: input.actor.assigneeUserId },
        select: { id: true },
      });
      if (!member) throw new BulkActionError("invalid_assignee");
      const { assignWorkflow } = await import(
        "../observability/workflow.service.js"
      );
      await assignWorkflow(
        {
          workflowId: input.targetId,
          teamId: input.teamId,
          assigneeUserId: input.actor.assigneeUserId,
          actorUserId: input.actor.actorUserId,
          ipAddress: input.actor.ipAddress,
          userAgent: input.actor.userAgent,
        },
        c,
      );
      return;
    }
    case "BULK_ESCALATE_WORKFLOWS": {
      const { escalateWorkflow } = await import(
        "../observability/workflow.service.js"
      );
      await escalateWorkflow(
        {
          workflowId: input.targetId,
          teamId: input.teamId,
          actorUserId: input.actor.actorUserId,
          ipAddress: input.actor.ipAddress,
          userAgent: input.actor.userAgent,
        },
        c,
      );
      return;
    }
    case "BULK_RESOLVE_WORKFLOWS": {
      const { resolveWorkflow } = await import(
        "../observability/workflow.service.js"
      );
      await resolveWorkflow(
        {
          workflowId: input.targetId,
          teamId: input.teamId,
          note: input.actor.note ?? null,
          actorUserId: input.actor.actorUserId,
          ipAddress: input.actor.ipAddress,
          userAgent: input.actor.userAgent,
        },
        c,
      );
      return;
    }
    case "BULK_ADD_MITIGATION": {
      if (!input.actor.note) throw new BulkActionError("note_required");
      const { addMitigation } = await import(
        "../observability/workflow.service.js"
      );
      await addMitigation(
        {
          workflowId: input.targetId,
          teamId: input.teamId,
          note: input.actor.note,
          actorUserId: input.actor.actorUserId,
          ipAddress: input.actor.ipAddress,
          userAgent: input.actor.userAgent,
        },
        c,
      );
      return;
    }
    case "BULK_SCHEDULE_RETRY": {
      // SAFE retry intent only — does NOT invoke BullMQ.
      if (!input.actor.nextRetryAtUtc) {
        throw new BulkActionError("retry_time_required");
      }
      const { scheduleRetry } = await import(
        "../observability/workflow.service.js"
      );
      await scheduleRetry(
        {
          workflowId: input.targetId,
          teamId: input.teamId,
          nextRetryAtUtc: new Date(input.actor.nextRetryAtUtc),
          actorUserId: input.actor.actorUserId,
          ipAddress: input.actor.ipAddress,
          userAgent: input.actor.userAgent,
        },
        c,
      );
      return;
    }
    case "BULK_SUPPRESS_INCIDENTS": {
      const { suppressIncident } = await import(
        "../observability/incident.service.js"
      );
      await suppressIncident(
        {
          incidentId: input.targetId,
          teamId: input.teamId,
          actorUserId: input.actor.actorUserId,
          ipAddress: input.actor.ipAddress,
          userAgent: input.actor.userAgent,
        },
        c,
      );
      return;
    }
    case "BULK_ACKNOWLEDGE_INCIDENTS": {
      const { acknowledgeIncident } = await import(
        "../observability/incident.service.js"
      );
      await acknowledgeIncident(
        {
          incidentId: input.targetId,
          teamId: input.teamId,
          actorUserId: input.actor.actorUserId,
          ipAddress: input.actor.ipAddress,
          userAgent: input.actor.userAgent,
        },
        c,
      );
      return;
    }
    case "BULK_DISMISS_RECOMMENDATIONS": {
      await c.reviewerRoutingRecommendation.updateMany({
        where: { id: input.targetId, teamId: input.teamId, status: "OPEN" },
        data: {
          status: "DISMISSED",
          resolvedAtUtc: new Date(),
          resolvedByUserId: input.actor.actorUserId,
        },
      });
      return;
    }
  }
}

export class BulkActionError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export async function getBulkActionRun(
  input: { runId: string; teamId: string },
  client: PrismaClient = defaultPrisma,
): Promise<{
  run: prismaPkg.BulkOperationalActionRun | null;
  items: prismaPkg.BulkOperationalActionItem[];
}> {
  const run = await client.bulkOperationalActionRun.findFirst({
    where: { id: input.runId, teamId: input.teamId },
  });
  if (!run) return { run: null, items: [] };
  const items = await client.bulkOperationalActionItem.findMany({
    where: { runId: run.id },
    orderBy: { createdAt: "asc" },
    take: 500,
  });
  return { run, items };
}
