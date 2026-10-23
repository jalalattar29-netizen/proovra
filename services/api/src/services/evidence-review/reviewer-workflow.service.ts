import type { Prisma } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import { prisma } from "../../db.js";
import { recordReviewStatusOnCustodyTx } from "./reviewer-audit.service.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
// PHASE 12 POINT 4 PASS C1 — the ONE definition of "this status is a verdict".
import { isDecisionDerivedWorkflowStatus } from "./review-status-vocabulary.js";
import { AppError, ErrorCode } from "../../errors.js";
import { isAllowedReviewStageTransition, mapDbStatusToReviewStage } from "@proovra/shared";
import {
  templateIdentityAuditMetadata,
  type TemplateIdentityStampSource,
  type TemplateIdentityTrio,
} from "../templates/identity-resolver.service.js";

function toWorkflowSummary(
  workflow: Awaited<ReturnType<typeof getEvidenceReviewerWorkflow>>
) {
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
      assignedTo:
        workflow.assignedTo != null
          ? {
              id: workflow.assignedTo.id,
              email: workflow.assignedTo.email ?? null,
              displayName: workflow.assignedTo.displayName ?? null,
            }
          : null,
      assignedBy:
        workflow.assignedBy != null
          ? {
              id: workflow.assignedBy.id,
              email: workflow.assignedBy.email ?? null,
              displayName: workflow.assignedBy.displayName ?? null,
            }
          : null,
    },
  };
}

export async function getEvidenceReviewerWorkflow(evidenceId: string) {
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

export async function getEvidenceReviewerWorkflowSummary(evidenceId: string) {
  const workflow = await getEvidenceReviewerWorkflow(evidenceId);
  return toWorkflowSummary(workflow);
}

export async function listEvidenceReviewerWorkflowEvents(evidenceId: string) {
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

/**
 * The workflow PATCH may change routing state only, and only along the shared
 * stage matrix (2026-10-23).
 *
 * ESCALATED and REOPENED are LIFECYCLE DECISIONS: they need a written reason,
 * Escalate opens a real escalation for the workspace's admins, and Reopen
 * starts a new decision round. Setting them here skipped all of that.
 */
const LIFECYCLE_DECISION_STATUSES: ReadonlySet<string> = new Set(["ESCALATED", "REOPENED"]);

export async function upsertEvidenceReviewerWorkflow(params: {
  evidenceId: string;
  workspaceType: "PERSONAL" | "TEAM";
  teamId?: string | null;
  actorUserId: string;
  assignedToUserId?: string | null;
  status?: prismaPkg.EvidenceReviewWorkflowStatus | null;
  priority?: prismaPkg.EvidenceReviewWorkflowPriority | null;
  dueAt?: Date | null;
  note?: string | null;
  /**
   * OPTIMISTIC CONCURRENCY (2026-10-23) — the `updatedAt` the caller's edit
   * was based on. When given and the row has moved since, the write is
   * refused (409 CONFLICT, reason stale_workflow) instead of silently
   * overwriting someone else's change. The write itself is conditional on the
   * row's `updatedAt`, so two concurrent writers cannot both win.
   */
  expectedUpdatedAt?: Date | null;
  // Phase T — canonical template-identity trio sourced from the upstream
  // Evidence row. Callers thread the trio through here so the reviewer
  // queue and downstream surfaces can group / filter by the same
  // template that produced the evidence. All three fields are nullable:
  //   - undefined  -> caller did not opt into stamping; leave row as-is.
  //   - null       -> evidence has no template (legacy / direct upload);
  //                   write NULL columns explicitly.
  //   - string/Int -> stamp the value.
  // Propagation failure (e.g. resolver returned null fields) must never
  // break the upsert — the workflow row is created with NULL trio.
  templateIdentity?: TemplateIdentityTrio | null;
  /**
   * Source label for the audit event when templateIdentity is set. Defaults
   * to "capture" because the dominant call site is capture-finalize.
   */
  templateIdentitySource?: TemplateIdentityStampSource;
}) {
  // PHASE 12 POINT 4 PASS C1 — this upsert is the ADMINISTRATIVE writer
  // (assignment, priority, due date, template trio). It is NOT the decision
  // authority, and it may not project a verdict.
  //
  // Until now a caller could PATCH `status: "APPROVED_INTERNAL"` straight
  // onto the row: no immutable decision was appended, no second-review or
  // adjudication rule ran, no stale/terminal check applied, and the workflow
  // then carried an approval its own decision log did not contain. Verdicts
  // belong to `recordReviewDecision`, which appends the immutable row and
  // derives this status in the same transaction.
  if (isDecisionDerivedWorkflowStatus(params.status)) {
    throw new AppError(
      ErrorCode.INVALID_STATE_TRANSITION,
      "Review verdicts are recorded as decisions, not assigned as a status.",
      {
        reason: "decision_status_requires_decision_authority",
        field: "status",
        value: String(params.status),
      },
    );
  }

  // Phase T — resolve the trio fields once so both create and update
  // branches stay in lockstep. The trio is optional: when undefined we
  // leave the row alone; when null we write NULL (legacy evidence).
  const trio: TemplateIdentityTrio | null =
    params.templateIdentity === undefined ? null : params.templateIdentity;
  const trioProvided = params.templateIdentity !== undefined;
  const trioColumns = trioProvided
    ? {
        templateSlug: trio?.templateSlug ?? null,
        templateVersion: trio?.templateVersion ?? null,
        templateDbId: trio?.templateDbId ?? null,
      }
    : {};

  // ONE TRANSACTION (2026-10-23): the row and its events are written
  // together, so a workflow can no longer exist without its creation event or
  // carry events for a write that did not land.
  const { workflow } = await prisma.$transaction(async (tx) => {
    const existing = await tx.evidenceReviewWorkflow.findUnique({
      where: { evidenceId: params.evidenceId },
      select: {
        id: true,
        status: true,
        priority: true,
        dueAt: true,
        assignedToUserId: true,
        assignedByUserId: true,
        updatedAt: true,
      },
    });

    if (
      existing &&
      params.expectedUpdatedAt &&
      existing.updatedAt.getTime() !== params.expectedUpdatedAt.getTime()
    ) {
      throw new AppError(ErrorCode.CONFLICT, "This review changed since you opened it. Reload and try again.", {
        reason: "stale_workflow",
        currentUpdatedAt: existing.updatedAt.toISOString(),
      });
    }

    // A workflow cannot be CREATED in a lifecycle-decision state either
    // (audit F10): Escalated with no escalation, Reopened with no new round.
    if (!existing && params.status && LIFECYCLE_DECISION_STATUSES.has(params.status)) {
      throw new AppError(
        ErrorCode.INVALID_STATE_TRANSITION,
        "Escalate and Reopen are review decisions with a reason, not a status edit.",
        { reason: "lifecycle_decision_required", field: "status", value: String(params.status) },
      );
    }
    // Closing an ESCALATED review is the Close decision, which resolves the
    // escalation raised about it (audit F5) — never an editor status change
    // that would leave the admins' escalation open.
    if (existing && existing.status === "ESCALATED" && params.status === "CLOSED") {
      throw new AppError(
        ErrorCode.INVALID_STATE_TRANSITION,
        "Close an escalated review with the Close decision, which resolves its escalation.",
        { reason: "lifecycle_decision_required", field: "status", value: "CLOSED" },
      );
    }
    // THE STAGE MATRIX applies to a status CHANGE on an existing workflow.
    if (existing && params.status && params.status !== existing.status) {
      if (LIFECYCLE_DECISION_STATUSES.has(params.status)) {
        throw new AppError(
          ErrorCode.INVALID_STATE_TRANSITION,
          "Escalate and Reopen are review decisions with a reason, not a status edit.",
          { reason: "lifecycle_decision_required", field: "status", value: String(params.status) },
        );
      }
      const from = mapDbStatusToReviewStage(existing.status as string);
      const to = mapDbStatusToReviewStage(params.status as string);
      if (!isAllowedReviewStageTransition(from, to)) {
        throw new AppError(
          ErrorCode.INVALID_STATE_TRANSITION,
          "That review state is not reachable from the current one.",
          { reason: "invalid_stage_transition", from, to },
        );
      }
    }

    const nextStatus = params.status ?? existing?.status ?? prismaPkg.EvidenceReviewWorkflowStatus.NOT_STARTED;
    const nextPriority =
      params.priority ?? existing?.priority ?? prismaPkg.EvidenceReviewWorkflowPriority.NORMAL;

    let workflow;
    if (existing) {
      // Conditional on the row we read: a concurrent writer that landed in
      // between makes this match nothing, and the write is refused.
      const claim = await tx.evidenceReviewWorkflow.updateMany({
        where: { id: existing.id, updatedAt: existing.updatedAt },
        data: {
          assignedToUserId:
            params.assignedToUserId !== undefined
              ? params.assignedToUserId
              : existing.assignedToUserId,
          assignedByUserId:
            params.assignedToUserId !== undefined ? params.actorUserId : existing.assignedByUserId,
          status: nextStatus,
          priority: nextPriority,
          dueAt: params.dueAt !== undefined ? params.dueAt : existing.dueAt,
          lastReviewedAt:
            nextStatus === prismaPkg.EvidenceReviewWorkflowStatus.IN_REVIEW ||
            nextStatus === prismaPkg.EvidenceReviewWorkflowStatus.CLOSED
              ? new Date()
              : undefined,
          closedAt:
            nextStatus === prismaPkg.EvidenceReviewWorkflowStatus.CLOSED
              ? new Date()
              : null,
          ...trioColumns,
        },
      });
      if (claim.count !== 1) {
        throw new AppError(ErrorCode.CONFLICT, "This review changed since you opened it. Reload and try again.", {
          reason: "stale_workflow",
        });
      }
      workflow = await tx.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: existing.id } });
    } else {
      workflow = await tx.evidenceReviewWorkflow.create({
        data: {
          evidenceId: params.evidenceId,
          workspaceType: params.workspaceType,
          teamId: params.teamId ?? null,
          assignedToUserId: params.assignedToUserId ?? null,
          assignedByUserId: params.assignedToUserId ? params.actorUserId : null,
          status: nextStatus,
          priority: nextPriority,
          dueAt: params.dueAt ?? null,
          lastReviewedAt:
            nextStatus === prismaPkg.EvidenceReviewWorkflowStatus.IN_REVIEW
              ? new Date()
              : null,
          closedAt:
            nextStatus === prismaPkg.EvidenceReviewWorkflowStatus.CLOSED
              ? new Date()
              : null,
          ...trioColumns,
        },
      });
    }

    const event = (
      eventType: prismaPkg.EvidenceReviewWorkflowEventType,
      previousValue: Prisma.InputJsonValue | undefined,
      nextValue: Prisma.InputJsonValue,
    ) =>
      tx.evidenceReviewWorkflowEvent.create({
        data: {
          workflowId: workflow.id,
          evidenceId: params.evidenceId,
          actorUserId: params.actorUserId,
          eventType,
          ...(previousValue !== undefined ? { previousValue } : {}),
          nextValue,
          note: params.note ?? null,
        },
      });

    if (!existing) {
      // CREATION IS ONE EVENT (2026-10-23). The initial status, priority and
      // assignee are recorded in its nextValue; the UNASSIGNED,
      // STATUS_CHANGED and PRIORITY_CHANGED rows that used to accompany it
      // described no change. An assignee set at creation is still a real
      // assignment and keeps its own event.
      await event(prismaPkg.EvidenceReviewWorkflowEventType.CREATED, undefined, {
        status: nextStatus,
        priority: nextPriority,
        assignedToUserId: params.assignedToUserId ?? null,
        dueAt: params.dueAt?.toISOString() ?? null,
      } as Prisma.InputJsonValue);
      // ET-CUS-12 — a workflow opened with a status is on custody, in this
      // transaction (third audit: the route appended it after commit).
      if (params.status) {
        await recordReviewStatusOnCustodyTx(tx, {
          evidenceId: params.evidenceId,
          actorUserId: params.actorUserId,
          status: String(workflow.status),
          decision: "WORKFLOW_EDITOR",
        });
      }
      if (workflow.assignedToUserId) {
        await event(
          prismaPkg.EvidenceReviewWorkflowEventType.ASSIGNED,
          { assignedToUserId: null } as Prisma.InputJsonValue,
          { assignedToUserId: workflow.assignedToUserId } as Prisma.InputJsonValue,
        );
      }
      return { workflow, existing };
    }

    if (existing.assignedToUserId !== workflow.assignedToUserId) {
      await event(
        workflow.assignedToUserId
          ? prismaPkg.EvidenceReviewWorkflowEventType.ASSIGNED
          : prismaPkg.EvidenceReviewWorkflowEventType.UNASSIGNED,
        { assignedToUserId: existing.assignedToUserId ?? null } as Prisma.InputJsonValue,
        { assignedToUserId: workflow.assignedToUserId ?? null } as Prisma.InputJsonValue,
      );
    }
    if (existing.status !== workflow.status) {
      await event(
        workflow.status === prismaPkg.EvidenceReviewWorkflowStatus.IN_REVIEW
          ? prismaPkg.EvidenceReviewWorkflowEventType.REVIEW_STARTED
          : workflow.status === prismaPkg.EvidenceReviewWorkflowStatus.CLOSED
            ? prismaPkg.EvidenceReviewWorkflowEventType.CLOSED
            : prismaPkg.EvidenceReviewWorkflowEventType.STATUS_CHANGED,
        { status: existing.status } as Prisma.InputJsonValue,
        { status: workflow.status } as Prisma.InputJsonValue,
      );
      // ET-CUS-12 — only a real status change, and in this transaction.
      await recordReviewStatusOnCustodyTx(tx, {
        evidenceId: params.evidenceId,
        actorUserId: params.actorUserId,
        status: String(workflow.status),
        decision: "WORKFLOW_EDITOR",
      });
    }
    if (existing.priority !== workflow.priority) {
      await event(
        prismaPkg.EvidenceReviewWorkflowEventType.PRIORITY_CHANGED,
        { priority: existing.priority } as Prisma.InputJsonValue,
        { priority: workflow.priority } as Prisma.InputJsonValue,
      );
    }
    const existingDueAt = existing.dueAt?.toISOString() ?? null;
    const nextDueAt = workflow.dueAt?.toISOString() ?? null;
    if (existingDueAt !== nextDueAt) {
      await event(
        prismaPkg.EvidenceReviewWorkflowEventType.DUE_DATE_CHANGED,
        { dueAt: existingDueAt } as Prisma.InputJsonValue,
        { dueAt: nextDueAt } as Prisma.InputJsonValue,
      );
    }
    return { workflow, existing };
  });

  // Phase T — emit a bounded audit event when the caller opted in AND a
  // slug actually exists on the trio. We never emit on the pure-NULL
  // legacy path (it would be noise). Emission is fire-and-forget; failure
  // here MUST NOT break the upsert lifecycle (which is the canonical
  // reviewer-queue init path on capture finalize).
  if (trioProvided && trio?.templateSlug) {
    void emitTenantAudit({
      action: "reviewer_workflow.template_identity.stamped",
      outcome: "success",
      sourceApp: "API",
      actorUserId: params.actorUserId,
      workspaceId: params.teamId ?? null,
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

  return getEvidenceReviewerWorkflowSummary(params.evidenceId);
}
