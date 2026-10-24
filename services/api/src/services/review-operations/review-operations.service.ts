/**
 * Phase 13 — Enterprise review operations service.
 *
 * Centralized assignment / stage-transition / decision / SLA helpers
 * that wrap the existing `EvidenceReviewWorkflow` row. ALL stage
 * transitions go through this service so the canonical matrix in
 * `@proovra/shared/review-operations` is enforced in one place.
 *
 * Wording: never claim "authentic / legally admissible / proven". An
 * APPROVED_INTERNAL decision means an authorised operator marked the
 * record as internally approved for governance purposes — nothing
 * more.
 */

import { legacyReviewDecisionFromStatus, presentReviewOutcome, type ReviewDecision } from "@proovra/shared";
import type {
  EvidenceReviewWorkflow as DbWorkflow,
  EvidenceReviewWorkflowEvent as DbEvent,
  EvidenceReviewWorkflowStatus,
  EvidenceReviewSlaStatus,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import {
  computeReviewSlaStatus,
  decisionRequiresNote,
  decisionTargetStage,
  isAllowedReviewStageTransition,
  mapDbStatusToReviewStage,
  mapReviewStageToDbStatus,
  reviewStageSatisfiesGovernanceGate,
  type ReviewDecisionType,
  type ReviewSlaStatus,
  type ReviewStage,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { triggerReviewAssigned } from "../automation/automation-triggers.js";
import {
  notifyReviewAssigned,
  notifyReviewEscalated,
  notifyReviewSlaBreached,
} from "./review-notifications.service.js";
// Track 1C — canonical review-decision authority. Reviewer VERDICTS
// (approve / reject / request-info) are recorded ONLY through this
// service, which appends the immutable WorkflowReviewDecision row and
// derives the workflow.status projection in one transaction. This file
// retains only NON-decision lifecycle transitions.
import {
  ReviewDecisionAuthorityError,
  recordReviewDecision as recordCanonicalReviewDecision,
} from "../reviewer-ops/review-decision.service.js";
import {
  createEscalation,
  resolveOpenReviewEscalation,
} from "../reviewer-ops/escalation-engine.service.js";
import { recordReviewActivityTx } from "../evidence-review/reviewer-audit.service.js";

// -----------------------------------------------------------------------------
// Error
// -----------------------------------------------------------------------------

export class ReviewOperationError extends Error {
  constructor(
    public readonly code:
      | "workflow_not_found"
      | "invalid_stage_transition"
      | "note_required"
      | "permission_denied"
      | "already_assigned_elsewhere"
      | "already_in_stage"
      | "evidence_not_in_workspace",
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "ReviewOperationError";
  }
}

// -----------------------------------------------------------------------------
// Internal: stage → DB status mapping
// -----------------------------------------------------------------------------

function stageToDbStatus(stage: ReviewStage): EvidenceReviewWorkflowStatus {
  // NOT a cast. Nine of the ten stage names are also enum members and one is
  // not: the stage is NEEDS_MORE_INFO and the column stores NEEDS_INFO —
  // so the blanket cast that used to live here handed Postgres a value its
  // enum does not contain and turned a valid request-more-info decision into a
  // 500. The mapping is canonical and shared with its inverse.
  return mapReviewStageToDbStatus(stage) as EvidenceReviewWorkflowStatus;
}

function slaStatusToDb(s: ReviewSlaStatus): EvidenceReviewSlaStatus {
  return s as unknown as EvidenceReviewSlaStatus;
}

// -----------------------------------------------------------------------------
// Ensure workflow row exists
// -----------------------------------------------------------------------------

export async function ensureReviewWorkflow(
  // ARCH-001 — `workspaceType` here is the PERSISTED column on
  // EvidenceReviewWorkflow, classified PERSISTENCE and deliberately not
  // renamed. It is written once and read back as a display label; it
  // authorizes nothing.
  input: { evidenceId: string; teamId: string | null; workspaceType?: string },
  client: PrismaClient = defaultPrisma,
): Promise<DbWorkflow> {
  const existing = await client.evidenceReviewWorkflow.findUnique({
    where: { evidenceId: input.evidenceId },
  });
  if (existing) return existing;

  // Phase 13.5 — apply workspace policy SLA defaults if configured.
  // Null defaults preserve pre-13.5 behavior exactly (no SLA applied).
  const defaults = await loadWorkspaceSlaDefaults(input.teamId, client);
  const now = new Date();
  const dueAt = defaults.defaultReviewDueHours
    ? new Date(now.getTime() + defaults.defaultReviewDueHours * 3_600_000)
    : null;
  const firstResponseDueAtUtc = defaults.defaultFirstResponseDueHours
    ? new Date(
        now.getTime() + defaults.defaultFirstResponseDueHours * 3_600_000,
      )
    : null;
  const escalationDueAtUtc = defaults.defaultEscalationDueHours
    ? new Date(
        now.getTime() + defaults.defaultEscalationDueHours * 3_600_000,
      )
    : null;
  const initialSla = computeReviewSlaStatus({
    dueAtUtc: dueAt,
    firstResponseDueAtUtc,
  });

  const created = await client.evidenceReviewWorkflow.create({
    data: {
      evidenceId: input.evidenceId,
      teamId: input.teamId,
      workspaceType: input.workspaceType ?? "TEAM",
      status: stageToDbStatus("QUEUED"),
      dueAt,
      firstResponseDueAtUtc,
      escalationDueAtUtc,
      slaStatus: initialSla ? slaStatusToDb(initialSla) : null,
    },
  });

  // Audit the default-application so operators can trace why the SLA
  // is set. No-op when no defaults configured.
  if (dueAt || firstResponseDueAtUtc || escalationDueAtUtc) {
    await recordEvent(
      created,
      "SLA_UPDATED",
      null,
      null,
      { source: "template_default", reason: "workspace_policy_defaults" },
      {
        dueAt,
        firstResponseDueAtUtc,
        escalationDueAtUtc,
        slaStatus: initialSla,
      },
      client,
    );
  }
  return created;
}

export type ReviewSlaDefaults = {
  defaultReviewDueHours: number | null;
  defaultFirstResponseDueHours: number | null;
  defaultEscalationDueHours: number | null;
};

/**
 * Read the workspace-level review SLA defaults. Returns all-null when
 * no policy row exists or no defaults are configured.
 */
export async function loadWorkspaceSlaDefaults(
  teamId: string | null,
  client: PrismaClient = defaultPrisma,
): Promise<ReviewSlaDefaults> {
  const empty: ReviewSlaDefaults = {
    defaultReviewDueHours: null,
    defaultFirstResponseDueHours: null,
    defaultEscalationDueHours: null,
  };
  if (!teamId) return empty;
  try {
    const policy = await client.workspaceGovernancePolicy.findUnique({
      where: { teamId },
      select: {
        defaultReviewDueHours: true,
        defaultFirstResponseDueHours: true,
        defaultEscalationDueHours: true,
      },
    });
    if (!policy) return empty;
    return {
      defaultReviewDueHours: policy.defaultReviewDueHours,
      defaultFirstResponseDueHours: policy.defaultFirstResponseDueHours,
      defaultEscalationDueHours: policy.defaultEscalationDueHours,
    };
  } catch {
    return empty;
  }
}

// -----------------------------------------------------------------------------
// Internal transition helper — atomic where-status guard.
// -----------------------------------------------------------------------------

type TransitionPatch = {
  status?: ReviewStage;
  decisionRound?: number;
  assignedToUserId?: string | null;
  assignedByUserId?: string | null;
  assignedAtUtc?: Date | null;
  reassignedAtUtc?: Date | null;
  dueAt?: Date | null;
  firstResponseDueAtUtc?: Date | null;
  escalationDueAtUtc?: Date | null;
  completedAtUtc?: Date | null;
  slaStatus?: ReviewSlaStatus | null;
  slaPausedAtUtc?: Date | null;
  escalationLevel?: number;
  escalatedAtUtc?: Date | null;
  escalatedByUserId?: string | null;
  escalationReason?: string | null;
  rejectionReason?: string | null;
  reopenCount?: number;
  reopenedAtUtc?: Date | null;
  reopenedByUserId?: string | null;
  lastReviewedAt?: Date | null;
  closedAt?: Date | null;
  priority?: DbWorkflow["priority"];
};

async function applyTransition(
  workflow: DbWorkflow,
  toStage: ReviewStage,
  patch: TransitionPatch,
  client: PrismaClient,
  /**
   * STRICT (2026-10-23): a lost race is a refusal, not a quiet success. The
   * lifecycle decisions use it — a caller that lost must not go on to write
   * an event, open an escalation or send a notification for a move that did
   * not happen.
   */
  options: { strict?: boolean } = {},
): Promise<DbWorkflow> {
  const fromStage = mapDbStatusToReviewStage(workflow.status as string);
  if (!isAllowedReviewStageTransition(fromStage, toStage)) {
    throw new ReviewOperationError("invalid_stage_transition", {
      from: fromStage,
      to: toStage,
    });
  }
  const data: Prisma.EvidenceReviewWorkflowUncheckedUpdateManyInput = {
    status: stageToDbStatus(toStage),
  };
  if (patch.assignedToUserId !== undefined)
    data.assignedToUserId = patch.assignedToUserId;
  if (patch.assignedByUserId !== undefined)
    data.assignedByUserId = patch.assignedByUserId;
  if (patch.assignedAtUtc !== undefined)
    data.assignedAtUtc = patch.assignedAtUtc;
  if (patch.reassignedAtUtc !== undefined)
    data.reassignedAtUtc = patch.reassignedAtUtc;
  if (patch.dueAt !== undefined) data.dueAt = patch.dueAt;
  if (patch.firstResponseDueAtUtc !== undefined)
    data.firstResponseDueAtUtc = patch.firstResponseDueAtUtc;
  if (patch.escalationDueAtUtc !== undefined)
    data.escalationDueAtUtc = patch.escalationDueAtUtc;
  if (patch.completedAtUtc !== undefined)
    data.completedAtUtc = patch.completedAtUtc;
  if (patch.slaStatus !== undefined)
    data.slaStatus = patch.slaStatus ? slaStatusToDb(patch.slaStatus) : null;
  if (patch.slaPausedAtUtc !== undefined)
    data.slaPausedAtUtc = patch.slaPausedAtUtc;
  if (typeof patch.escalationLevel === "number")
    data.escalationLevel = patch.escalationLevel;
  if (patch.escalatedAtUtc !== undefined)
    data.escalatedAtUtc = patch.escalatedAtUtc;
  if (patch.escalatedByUserId !== undefined)
    data.escalatedByUserId = patch.escalatedByUserId;
  if (patch.escalationReason !== undefined)
    data.escalationReason = patch.escalationReason?.slice(0, 400) ?? null;
  if (patch.rejectionReason !== undefined)
    data.rejectionReason = patch.rejectionReason?.slice(0, 400) ?? null;
  if (typeof patch.reopenCount === "number")
    data.reopenCount = patch.reopenCount;
  if (typeof patch.decisionRound === "number")
    data.decisionRound = patch.decisionRound;
  if (patch.reopenedAtUtc !== undefined)
    data.reopenedAtUtc = patch.reopenedAtUtc;
  if (patch.reopenedByUserId !== undefined)
    data.reopenedByUserId = patch.reopenedByUserId;
  if (patch.lastReviewedAt !== undefined)
    data.lastReviewedAt = patch.lastReviewedAt;
  if (patch.closedAt !== undefined) data.closedAt = patch.closedAt;
  if (patch.priority !== undefined) data.priority = patch.priority;

  const claim = await client.evidenceReviewWorkflow.updateMany({
    where: { id: workflow.id, status: workflow.status },
    data,
  });
  if (claim.count !== 1) {
    if (options.strict) {
      throw new ReviewOperationError("invalid_stage_transition", {
        from: mapDbStatusToReviewStage(workflow.status as string),
        to: toStage,
        reason: "concurrent_change",
      });
    }
    // Lost the race; surface the canonical state to the caller.
    const fresh = await client.evidenceReviewWorkflow.findUniqueOrThrow({
      where: { id: workflow.id },
    });
    return fresh;
  }
  return client.evidenceReviewWorkflow.findUniqueOrThrow({
    where: { id: workflow.id },
  });
}

async function recordEvent(
  workflow: DbWorkflow,
  eventType: DbEvent["eventType"],
  actorUserId: string | null,
  note: string | null | undefined,
  previousValue: unknown,
  nextValue: unknown,
  client: PrismaClient,
): Promise<void> {
  try {
    await client.evidenceReviewWorkflowEvent.create({
      data: {
        workflowId: workflow.id,
        evidenceId: workflow.evidenceId,
        actorUserId: actorUserId ?? null,
        eventType,
        previousValue: (previousValue ?? null) as Prisma.InputJsonValue,
        nextValue: (nextValue ?? null) as Prisma.InputJsonValue,
        note: note?.slice(0, 1000) ?? null,
      },
    });
  } catch {
    /* never fail the caller on event-history write */
  }
}

// -----------------------------------------------------------------------------
// Assignment
// -----------------------------------------------------------------------------

export type AssignReviewerInput = {
  evidenceId: string;
  assignedToUserId: string;
  actorUserId: string;
  note?: string | null;
};

/**
 * OWNER/ADMIN-driven assignment. If the workflow is already assigned
 * to a different user, the existing assignment is replaced and a
 * REASSIGNED event is emitted. Setting the same assignee is a no-op
 * heartbeat (no event, no timestamp bump).
 */
export async function assignReviewer(
  input: AssignReviewerInput,
  client: PrismaClient = defaultPrisma,
): Promise<DbWorkflow> {
  const workflow = await client.evidenceReviewWorkflow.findUnique({
    where: { evidenceId: input.evidenceId },
  });
  if (!workflow) throw new ReviewOperationError("workflow_not_found");

  if (workflow.assignedToUserId === input.assignedToUserId) {
    return workflow; // no-op
  }

  const now = new Date();
  const isReassignment = !!workflow.assignedToUserId;
  const fromStage = mapDbStatusToReviewStage(workflow.status as string);

  // Assignment alone does not change stage unless we're still in QUEUED.
  const targetStage: ReviewStage =
    fromStage === "QUEUED" ? "ASSIGNED" : fromStage;

  const updated = await applyTransition(
    workflow,
    targetStage,
    {
      assignedToUserId: input.assignedToUserId,
      assignedByUserId: input.actorUserId,
      assignedAtUtc: workflow.assignedAtUtc ?? now,
      reassignedAtUtc: isReassignment ? now : workflow.reassignedAtUtc,
    },
    client,
  );

  await recordEvent(
    workflow,
    isReassignment ? "REASSIGNED" : "ASSIGNED",
    input.actorUserId,
    input.note,
    { assignedToUserId: workflow.assignedToUserId, stage: fromStage },
    { assignedToUserId: input.assignedToUserId, stage: targetStage },
    client,
  );
  await recordReviewActivityTx(client as never, {
    evidenceId: workflow.evidenceId,
    workflowId: workflow.id,
    teamId: workflow.teamId ?? null,
    actorUserId: input.actorUserId,
    code: "REVIEW_ASSIGNMENT_CHANGED",
    previousState: String(workflow.status),
    resultingState: String(updated.status),
  });
  /**
   * ARCH-005 (2026-08-07) — REVIEW_ASSIGNED.
   *
   * The source identity carries the assignment timestamp, so a REASSIGNMENT is
   * a new occurrence (a rule that notifies the assignee must fire for the new
   * one) while a repeated dispatch of the same assignment is not. The no-op
   * guard above already returns early when the assignee is unchanged, so this
   * line is only reached when something actually moved.
   */
  await triggerReviewAssigned(client, {
    teamId: updated.teamId ?? workflow.teamId ?? "",
    workflowId: updated.id,
    assignedAtUtc: isReassignment ? now : (updated.assignedAtUtc ?? now),
    context: {
      stage: targetStage,
      isReassignment: String(isReassignment),
      priority: String(updated.priority),
    },
  });

  // Phase 13.5 — notify the new assignee. Safe wrapper: failure of
  // notification dispatch MUST NOT undo the assignment.
  notifyReviewAssigned(
    { workflow: updated, actorUserId: input.actorUserId, isReassignment },
    client,
  ).catch(() => null);
  return updated;
}

/**
 * REVIEWER-driven self-claim. Only succeeds when the workflow is
 * unassigned. Reassignment of an already-claimed workflow has to go
 * through `assignReviewer` (admin path).
 */
export async function claimReviewerWorkflow(
  input: { evidenceId: string; actorUserId: string },
  client: PrismaClient = defaultPrisma,
): Promise<DbWorkflow> {
  const workflow = await client.evidenceReviewWorkflow.findUnique({
    where: { evidenceId: input.evidenceId },
  });
  if (!workflow) throw new ReviewOperationError("workflow_not_found");

  if (
    workflow.assignedToUserId &&
    workflow.assignedToUserId !== input.actorUserId
  ) {
    throw new ReviewOperationError("already_assigned_elsewhere");
  }

  const fromStage = mapDbStatusToReviewStage(workflow.status as string);
  // IDEMPOTENT (2026-10-23). A claim by the reviewer who already owns the
  // workflow changes nothing, so it writes nothing: every repeated click used
  // to append another CLAIMED event to the history.
  if (
    workflow.assignedToUserId === input.actorUserId &&
    fromStage !== "QUEUED"
  ) {
    return workflow;
  }

  const now = new Date();
  const targetStage: ReviewStage =
    fromStage === "QUEUED" ? "ASSIGNED" : fromStage;

  const updated = await applyTransition(
    workflow,
    targetStage,
    {
      assignedToUserId: input.actorUserId,
      assignedByUserId: input.actorUserId,
      assignedAtUtc: workflow.assignedAtUtc ?? now,
    },
    client,
  );
  await recordEvent(
    workflow,
    "CLAIMED",
    input.actorUserId,
    null,
    { assignedToUserId: workflow.assignedToUserId, stage: fromStage },
    { assignedToUserId: input.actorUserId, stage: targetStage },
    client,
  );
  await recordReviewActivityTx(client as never, {
    evidenceId: workflow.evidenceId,
    workflowId: workflow.id,
    teamId: workflow.teamId ?? null,
    actorUserId: input.actorUserId,
    code: "REVIEW_CLAIMED",
    previousState: String(workflow.status),
    resultingState: String(updated.status),
  });
  return updated;
}

// -----------------------------------------------------------------------------
// Non-decision lifecycle transitions.
//
// Track 1C — reviewer VERDICTS (APPROVE_INTERNAL / REJECT_INSUFFICIENT /
// REQUEST_MORE_INFO) are NO LONGER recorded here. They go through the
// canonical decision authority (reviewer-ops/review-decision.service.ts),
// which appends the immutable WorkflowReviewDecision row and derives the
// workflow.status projection atomically. This function retains only the
// lifecycle ROUTING transitions (escalate / reopen / close) which are
// administrative, not verdicts about the evidence.
// -----------------------------------------------------------------------------

export type ReviewLifecycleTransitionType = Extract<
  ReviewDecisionType,
  "ESCALATE" | "REOPEN" | "CLOSE"
>;

export type RecordLifecycleTransitionInput = {
  evidenceId: string;
  decision: ReviewLifecycleTransitionType;
  actorUserId: string;
  note?: string | null;
  /** Optional explicit closed timestamp for CLOSE. */
  closedAt?: Date;
  /** For ESCALATE — operator-supplied reason (required, mirrored from note). */
  escalationReason?: string | null;
};

export async function recordLifecycleTransition(
  input: RecordLifecycleTransitionInput,
  client: PrismaClient = defaultPrisma,
): Promise<DbWorkflow> {
  const workflow = await client.evidenceReviewWorkflow.findUnique({
    where: { evidenceId: input.evidenceId },
  });
  if (!workflow) throw new ReviewOperationError("workflow_not_found");

  if (decisionRequiresNote(input.decision)) {
    const noteText = (input.note ?? input.escalationReason ?? "").trim();
    if (!noteText) {
      throw new ReviewOperationError("note_required", {
        decision: input.decision,
      });
    }
  }

  const fromStage = mapDbStatusToReviewStage(workflow.status as string);
  const toStage = decisionTargetStage(input.decision);
  // NOT A HEARTBEAT (2026-10-23). The shared matrix allows a stage to
  // "transition" to itself, so a second Escalate raised the escalation level
  // and emailed the assignee again, and a second Reopen bumped the reopen
  // count — each with a new event — while the screen showed nothing new. An
  // explicit lifecycle decision into the stage the workflow is already in is
  // refused, so a repeated click has one visible, explained outcome.
  if (fromStage === toStage) {
    throw new ReviewOperationError("already_in_stage", { stage: fromStage });
  }
  const now = new Date();

  const patch: TransitionPatch = {};
  let eventType: DbEvent["eventType"] = "DECISION_LOGGED";

  switch (input.decision) {
    case "ESCALATE":
      // The escalation opened below already counted this level.
      patch.escalationLevel = workflow.escalationLevel + 1;
      patch.escalatedAtUtc = now;
      patch.escalatedByUserId = input.actorUserId;
      patch.escalationReason = input.escalationReason ?? input.note ?? null;
      eventType = "ESCALATED";
      break;
    case "REOPEN":
      patch.reopenCount = workflow.reopenCount + 1;
      // A reopened review decides in a NEW round (2026-10-23): the verdict
      // that closed the last round stays on the log and no longer blocks one.
      patch.decisionRound = workflow.decisionRound + 1;
      patch.reopenedAtUtc = now;
      patch.reopenedByUserId = input.actorUserId;
      // Clear terminal markers so subsequent transitions are valid.
      patch.completedAtUtc = null;
      patch.closedAt = null;
      eventType = "REOPENED";
      break;
    case "CLOSE":
      patch.closedAt = input.closedAt ?? now;
      eventType = "CLOSED";
      break;
  }

  // ESCALATE OPENS A REAL ESCALATION (2026-10-23). It used to change the
  // status and email the current assignee — usually the escalator — and
  // nothing else: no owner, no inbox item, no way to resolve it. It now
  // opens a ReviewEscalation routed to the workspace's owners and admins
  // (their inbox shows it), and the review appears under Escalated in the
  // team review queue. A verdict that finishes the review, or Close,
  // resolves it.
  //
  // The MOVE is strict: of two concurrent Escalate clicks (or an Escalate
  // racing a Close) exactly one wins, and only the winner opens an escalation
  // (audit F4). The move, the escalation, its outbox row and the event are
  // ONE transaction (audit 2026-10-23 #1): a failure leaves neither an
  // Escalated review with no escalation nor an escalation on a review that
  // is not Escalated.
  if (input.decision === "ESCALATE" && workflow.teamId) {
    const teamId = workflow.teamId;
    let afterCommit: (() => Promise<void>) | undefined;
    const updated = await client.$transaction(async (txc) => {
      const tx = txc as unknown as PrismaClient;
      const moved = await applyTransition(workflow, toStage, patch, tx, { strict: true });
      const opened = await createEscalation(
        {
          teamId,
          workflowId: workflow.id,
          reason: "REVIEWER_ESCALATED",
          safeSummary: (input.escalationReason ?? input.note ?? "").trim(),
          severity: "WARNING",
          evidenceId: workflow.evidenceId,
          createdByUserId: input.actorUserId,
          routeToWorkspaceAdmins: true,
          bypassDedup: true,
          // The transition above already counted the level and kept the note.
          workflowCountersAlreadySet: true,
          deferAuditToCaller: true,
        },
        tx,
      );
      if (!opened.ok) throw new ReviewOperationError("workflow_not_found");
      afterCommit = opened.afterCommit;
      // Written directly, not through recordEvent: a swallowed failure would
      // abort this transaction without the caller hearing of it.
      await tx.evidenceReviewWorkflowEvent.create({
        data: {
          workflowId: workflow.id,
          evidenceId: workflow.evidenceId,
          actorUserId: input.actorUserId,
          eventType,
          previousValue: { stage: fromStage } as Prisma.InputJsonValue,
          nextValue: { stage: toStage, decision: input.decision, escalationId: opened.escalation.id } as Prisma.InputJsonValue,
          note: input.note?.slice(0, 1000) ?? null,
        },
      });
      await recordReviewActivityTx(txc, {
        evidenceId: workflow.evidenceId,
        workflowId: workflow.id,
        teamId,
        actorUserId: input.actorUserId,
        code: "REVIEW_ESCALATION_CREATED",
        previousState: String(workflow.status),
        resultingState: String(moved.status),
      });
      return moved;
    });
    // The escalation's security event and audit entry, then the operational
    // notification — after commit, best-effort.
    await afterCommit?.().catch(() => null);
    notifyReviewEscalated({ workflow: updated, actorUserId: input.actorUserId }, client).catch(() => null);
    return updated;
  }

  // Reopen / Close: the move, its event and its custody entry are one
  // transaction (ET-CUS-12, 2026-10-23).
  const updated = await client.$transaction(async (txc) => {
    const tx = txc as unknown as PrismaClient;
    const moved = await applyTransition(workflow, toStage, patch, tx, { strict: true });
    await txc.evidenceReviewWorkflowEvent.create({
      data: {
        workflowId: workflow.id,
        evidenceId: workflow.evidenceId,
        actorUserId: input.actorUserId,
        eventType,
        previousValue: { stage: fromStage } as Prisma.InputJsonValue,
        nextValue: { stage: toStage, decision: input.decision } as Prisma.InputJsonValue,
        note: input.note?.slice(0, 1000) ?? null,
      },
    });
    await recordReviewActivityTx(txc, {
      evidenceId: workflow.evidenceId,
      workflowId: workflow.id,
      teamId: workflow.teamId ?? null,
      actorUserId: input.actorUserId,
      code: input.decision === "REOPEN" ? "REVIEW_REOPENED" : "REVIEW_CLOSED",
      previousState: String(workflow.status),
      resultingState: String(moved.status),
    });
    return moved;
  });
  // Close resolves the escalations raised about the review. Reopen resolves
  // any a failed Close left behind: they belong to the closed review, and an
  // open one would demand a second reviewer in every new round (third audit).
  if (input.decision === "CLOSE" || input.decision === "REOPEN") {
    await resolveOpenReviewEscalation(
      {
        workflow,
        actorUserId: input.actorUserId,
        note: input.decision === "CLOSE" ? "Review closed." : "Review reopened; the closed review's escalation is resolved.",
      },
      client,
    );
  }

  return updated;
}

// -----------------------------------------------------------------------------
// SLA + escalation
// -----------------------------------------------------------------------------

export type UpdateSlaInput = {
  evidenceId: string;
  actorUserId: string;
  dueAt?: Date | null;
  firstResponseDueAtUtc?: Date | null;
  escalationDueAtUtc?: Date | null;
  paused?: boolean;
  note?: string | null;
};

export async function updateReviewSla(
  input: UpdateSlaInput,
  client: PrismaClient = defaultPrisma,
): Promise<DbWorkflow> {
  const workflow = await client.evidenceReviewWorkflow.findUnique({
    where: { evidenceId: input.evidenceId },
  });
  if (!workflow) throw new ReviewOperationError("workflow_not_found");

  const patch: TransitionPatch = {};
  if (input.dueAt !== undefined) patch.dueAt = input.dueAt;
  if (input.firstResponseDueAtUtc !== undefined)
    patch.firstResponseDueAtUtc = input.firstResponseDueAtUtc;
  if (input.escalationDueAtUtc !== undefined)
    patch.escalationDueAtUtc = input.escalationDueAtUtc;
  if (typeof input.paused === "boolean") {
    patch.slaPausedAtUtc = input.paused ? new Date() : null;
  }

  // Recompute SLA status with the effective due dates.
  const effectiveDue =
    input.dueAt !== undefined ? input.dueAt : workflow.dueAt;
  const effectiveFirstResponse =
    input.firstResponseDueAtUtc !== undefined
      ? input.firstResponseDueAtUtc
      : workflow.firstResponseDueAtUtc;
  const computed = computeReviewSlaStatus({
    dueAtUtc: effectiveDue,
    firstResponseDueAtUtc: effectiveFirstResponse,
    completedAtUtc: workflow.completedAtUtc,
    paused: input.paused ?? !!workflow.slaPausedAtUtc,
  });
  patch.slaStatus = computed;

  const stage = mapDbStatusToReviewStage(workflow.status as string);
  const updated = await applyTransition(workflow, stage, patch, client);
  await recordEvent(
    workflow,
    "SLA_UPDATED",
    input.actorUserId,
    input.note,
    {
      dueAt: workflow.dueAt,
      firstResponseDueAtUtc: workflow.firstResponseDueAtUtc,
      slaStatus: workflow.slaStatus,
    },
    {
      dueAt: patch.dueAt ?? workflow.dueAt,
      firstResponseDueAtUtc:
        patch.firstResponseDueAtUtc ?? workflow.firstResponseDueAtUtc,
      slaStatus: computed,
    },
    client,
  );
  return updated;
}

/**
 * Recompute SLA status for a list of workflows and flip BREACHED rows.
 * Best-effort; used by the reconciliation route. Emits SLA_BREACHED
 * events when a row crosses the threshold.
 *
 * Phase 13.5 guarantees:
 *   - completed workflows are skipped (completedAtUtc set)
 *   - paused workflows are skipped
 *   - SLA_BREACHED event + notification fire ONCE per workflow per
 *     transition into BREACHED. Subsequent sweeps see slaStatus =
 *     BREACHED already and emit nothing.
 */
export async function reconcileReviewSlas(
  input: { teamId?: string; batchSize?: number } = {},
  client: PrismaClient = defaultPrisma,
): Promise<{
  scanned: number;
  flippedBreached: number;
  flippedOverdue: number;
  flippedDueSoon: number;
  skippedCompleted: number;
  skippedPaused: number;
}> {
  const batchSize = Math.min(Math.max(input.batchSize ?? 200, 1), 2000);
  const candidates = await client.evidenceReviewWorkflow.findMany({
    where: {
      ...(input.teamId ? { teamId: input.teamId } : {}),
      dueAt: { not: null },
      // Skip completed + already-breached rows so the sweep is
      // idempotent. Already-BREACHED rows do NOT re-emit events.
      //
      // PHASE 12 FIX — a NEVER-INITIALIZED slaStatus (null) must be a
      // candidate too: `in: [...]` silently excluded NULL, so a breached
      // workflow whose status was never stamped could NEVER be flipped and
      // never surfaced in the OVERDUE queue or breach notifications
      // (caught live by the phase-37-98 lifecycle proof).
      OR: [
        { slaStatus: { in: ["ON_TRACK", "DUE_SOON", "OVERDUE"] } },
        { slaStatus: null },
      ],
      // Skip closed/terminal workflows; their review is over.
      status: { notIn: ["CLOSED", "REJECTED_INSUFFICIENT", "APPROVED_INTERNAL"] },
    },
    take: batchSize,
  });
  let flippedBreached = 0;
  let flippedOverdue = 0;
  let flippedDueSoon = 0;
  let skippedCompleted = 0;
  let skippedPaused = 0;
  for (const wf of candidates) {
    if (wf.completedAtUtc) {
      skippedCompleted += 1;
      continue;
    }
    if (wf.slaPausedAtUtc) {
      skippedPaused += 1;
      continue;
    }
    const computed = computeReviewSlaStatus({
      dueAtUtc: wf.dueAt,
      firstResponseDueAtUtc: wf.firstResponseDueAtUtc,
      completedAtUtc: wf.completedAtUtc,
      paused: false,
    });
    if (!computed || computed === wf.slaStatus) continue;
    const stage = mapDbStatusToReviewStage(wf.status as string);
    try {
      await applyTransition(wf, stage, { slaStatus: computed }, client);
      if (computed === "BREACHED" && wf.slaStatus !== "BREACHED") {
        flippedBreached += 1;
        await recordEvent(
          wf,
          "SLA_BREACHED",
          null,
          null,
          { slaStatus: wf.slaStatus },
          { slaStatus: computed },
          client,
        );
        // One overdue-reminder email per BREACHED transition. Safe.
        notifyReviewSlaBreached({ workflow: wf }, client).catch(() => null);
      } else if (computed === "OVERDUE") {
        flippedOverdue += 1;
      } else if (computed === "DUE_SOON") {
        flippedDueSoon += 1;
      }
    } catch {
      /* ignore; sweeper is best-effort */
    }
  }
  return {
    scanned: candidates.length,
    flippedBreached,
    flippedOverdue,
    flippedDueSoon,
    skippedCompleted,
    skippedPaused,
  };
}

// -----------------------------------------------------------------------------
// Bulk operations
// -----------------------------------------------------------------------------

export type BulkActionInput = {
  evidenceIds: string[];
  teamId: string;
  actorUserId: string;
  /**
   * Bulk action surface; mirrors single-item decisions but adds the
   * ASSIGN action for changing ownership of many rows at once.
   */
  action:
    | "ASSIGN"
    | "MARK_IN_REVIEW"
    | "ESCALATE"
    | "CLOSE"
    | "REQUEST_MORE_INFO";
  /** Required for ASSIGN. */
  assignedToUserId?: string;
  /** Required for ESCALATE / REQUEST_MORE_INFO. */
  note?: string | null;
};

export type BulkActionItemResult = {
  evidenceId: string;
  ok: boolean;
  reason?: string;
  toStage?: ReviewStage;
};

export type BulkActionResult = {
  total: number;
  succeeded: number;
  failed: number;
  items: BulkActionItemResult[];
};

const SENSITIVE_BULK_ACTIONS: ReadonlySet<BulkActionInput["action"]> = new Set([
  "ESCALATE",
  "REQUEST_MORE_INFO",
]);

export async function bulkReviewAction(
  input: BulkActionInput,
  client: PrismaClient = defaultPrisma,
): Promise<BulkActionResult> {
  if (SENSITIVE_BULK_ACTIONS.has(input.action)) {
    const noteText = (input.note ?? "").trim();
    if (!noteText) {
      throw new ReviewOperationError("note_required", {
        action: input.action,
      });
    }
  }
  if (input.action === "ASSIGN" && !input.assignedToUserId) {
    throw new ReviewOperationError("permission_denied", {
      reason: "assignedToUserId_required",
    });
  }

  const items: BulkActionItemResult[] = [];
  let succeeded = 0;
  let failed = 0;
  const uniqueIds = Array.from(new Set(input.evidenceIds)).slice(0, 200);

  for (const evidenceId of uniqueIds) {
    try {
      // Verify the evidence is in the caller's workspace before doing
      // anything — bulk cannot leak workflows from another workspace.
      const workflow = await client.evidenceReviewWorkflow.findUnique({
        where: { evidenceId },
        select: { id: true, teamId: true, status: true },
      });
      if (!workflow || workflow.teamId !== input.teamId) {
        items.push({
          evidenceId,
          ok: false,
          reason: "not_in_workspace",
        });
        failed += 1;
        continue;
      }

      let toStage: ReviewStage | null = null;
      switch (input.action) {
        case "ASSIGN":
          await assignReviewer(
            {
              evidenceId,
              assignedToUserId: input.assignedToUserId as string,
              actorUserId: input.actorUserId,
              note: input.note ?? null,
            },
            client,
          );
          toStage = "ASSIGNED";
          break;
        case "MARK_IN_REVIEW":
          toStage = "IN_REVIEW";
          // The move and its audit entry together.
          await client.$transaction(async (txc) => {
            const tx = txc as unknown as PrismaClient;
            const current = await tx.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: workflow.id } });
            const moved = await applyTransition(
              current,
              "IN_REVIEW",
              { lastReviewedAt: new Date() },
              tx,
              { strict: true },
            );
            // Only a real change is recorded (a review already In review is
            // not moved).
            if (moved.status !== current.status) {
              await recordReviewActivityTx(txc, {
                evidenceId,
                workflowId: workflow.id,
                teamId: input.teamId,
                actorUserId: input.actorUserId,
                code: "REVIEW_WORKFLOW_STATE_CHANGED",
                previousState: String(current.status),
                resultingState: String(moved.status),
              });
            }
          });
          await recordEvent(
            (await client.evidenceReviewWorkflow.findUniqueOrThrow({
              where: { id: workflow.id },
            })),
            "STAGE_CHANGED",
            input.actorUserId,
            input.note,
            { stage: mapDbStatusToReviewStage(workflow.status as string) },
            { stage: "IN_REVIEW" },
            client,
          );
          break;
        case "ESCALATE":
          await recordLifecycleTransition(
            {
              evidenceId,
              decision: "ESCALATE",
              actorUserId: input.actorUserId,
              note: input.note,
              escalationReason: input.note,
            },
            client,
          );
          toStage = "ESCALATED";
          break;
        case "CLOSE":
          await recordLifecycleTransition(
            {
              evidenceId,
              decision: "CLOSE",
              actorUserId: input.actorUserId,
              note: input.note,
            },
            client,
          );
          toStage = "CLOSED";
          break;
        case "REQUEST_MORE_INFO":
          // Track 1C — REQUEST_MORE_INFO is a reviewer VERDICT; it goes
          // through the canonical decision authority so the immutable
          // decision row + status projection land atomically.
          await recordCanonicalReviewDecision(
            {
              workflowId: workflow.id,
              teamId: input.teamId,
              actorUserId: input.actorUserId,
              decision: "REQUEST_INFO",
              rationale: input.note,
            },
            client,
          );
          toStage = "NEEDS_MORE_INFO";
          break;
      }
      items.push({ evidenceId, ok: true, toStage: toStage ?? undefined });
      succeeded += 1;
    } catch (err) {
      const reason =
        err instanceof ReviewOperationError ||
        err instanceof ReviewDecisionAuthorityError
          ? err.code
          : "operation_failed";
      items.push({ evidenceId, ok: false, reason });
      failed += 1;
    }
  }

  // Record a single BULK_ACTION event on the first workflow (audit
  // breadcrumb only — individual events are recorded above per item).
  if (uniqueIds[0]) {
    const first = await client.evidenceReviewWorkflow.findUnique({
      where: { evidenceId: uniqueIds[0] },
    });
    if (first) {
      await recordEvent(
        first,
        "BULK_ACTION",
        input.actorUserId,
        input.note,
        null,
        { action: input.action, total: uniqueIds.length, succeeded, failed },
        client,
      );
    }
  }

  return { total: uniqueIds.length, succeeded, failed, items };
}

// -----------------------------------------------------------------------------
// Read helpers
// -----------------------------------------------------------------------------

export type QueueFilters = {
  teamId: string;
  stage?: ReviewStage;
  slaStatus?: ReviewSlaStatus;
  assignedToUserId?: string;
  unassigned?: boolean;
  priority?: DbWorkflow["priority"];
  escalated?: boolean;
  limit?: number;
};

export async function listReviewQueue(
  input: QueueFilters,
  client: PrismaClient = defaultPrisma,
): Promise<DbWorkflow[]> {
  return client.evidenceReviewWorkflow.findMany({
    where: {
      teamId: input.teamId,
      ...(input.stage ? { status: stageToDbStatus(input.stage) } : {}),
      ...(input.slaStatus
        ? { slaStatus: slaStatusToDb(input.slaStatus) }
        : {}),
      ...(input.assignedToUserId
        ? { assignedToUserId: input.assignedToUserId }
        : {}),
      ...(input.unassigned ? { assignedToUserId: null } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.escalated ? { escalationLevel: { gt: 0 } } : {}),
    },
    orderBy: [
      { priority: "desc" },
      { dueAt: "asc" },
      { updatedAt: "desc" },
    ],
    take: Math.min(Math.max(input.limit ?? 50, 1), 200),
  });
}

export type ReviewQueueCounts = {
  byStage: Record<ReviewStage, number>;
  overdue: number;
  dueSoon: number;
  unassigned: number;
  assignedToMe: number;
};

export async function getReviewQueueCounts(
  input: { teamId: string; meUserId?: string },
  client: PrismaClient = defaultPrisma,
): Promise<ReviewQueueCounts> {
  const stageRows = await client.evidenceReviewWorkflow.groupBy({
    by: ["status"],
    where: { teamId: input.teamId },
    _count: { _all: true },
  });
  const byStage: Record<ReviewStage, number> = {
    QUEUED: 0,
    ASSIGNED: 0,
    IN_REVIEW: 0,
    NEEDS_MORE_INFO: 0,
    RESPONSE_RECEIVED: 0,
    APPROVED_INTERNAL: 0,
    REJECTED_INSUFFICIENT: 0,
    ESCALATED: 0,
    REOPENED: 0,
    CLOSED: 0,
  };
  for (const r of stageRows) {
    const mapped = mapDbStatusToReviewStage(r.status as string);
    byStage[mapped] += r._count._all;
  }
  const [overdue, dueSoon, unassigned, mine] = await Promise.all([
    client.evidenceReviewWorkflow.count({
      where: {
        teamId: input.teamId,
        slaStatus: { in: ["OVERDUE", "BREACHED"] },
      },
    }),
    client.evidenceReviewWorkflow.count({
      where: { teamId: input.teamId, slaStatus: "DUE_SOON" },
    }),
    client.evidenceReviewWorkflow.count({
      where: {
        teamId: input.teamId,
        assignedToUserId: null,
        status: { notIn: ["CLOSED", "REJECTED_INSUFFICIENT"] },
      },
    }),
    input.meUserId
      ? client.evidenceReviewWorkflow.count({
          where: {
            teamId: input.teamId,
            assignedToUserId: input.meUserId,
            status: { notIn: ["CLOSED", "REJECTED_INSUFFICIENT"] },
          },
        })
      : Promise.resolve(0),
  ]);
  return {
    byStage,
    overdue,
    dueSoon,
    unassigned,
    assignedToMe: mine,
  };
}

export function projectReviewWorkflow(row: DbWorkflow, decision?: ReviewDecision): {
  id: string;
  evidenceId: string;
  teamId: string | null;
  stage: ReviewStage;
  /** The workflow state, as a person reads it — never a verdict. */
  workflowStateLabel: string;
  /** The CURRENT round's decision, independent of the stage (2026-10-24). */
  decision: ReviewDecision;
  decisionLabel: string;
  approvedForGovernanceGate: boolean;
  priority: string;
  assignedToUserId: string | null;
  assignedByUserId: string | null;
  assignedAtUtc: string | null;
  reassignedAtUtc: string | null;
  dueAt: string | null;
  firstResponseDueAtUtc: string | null;
  escalationDueAtUtc: string | null;
  completedAtUtc: string | null;
  closedAt: string | null;
  slaStatus: string | null;
  escalationLevel: number;
  escalatedAtUtc: string | null;
  escalatedByUserId: string | null;
  escalationReason: string | null;
  reopenCount: number;
  reopenedAtUtc: string | null;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
} {
  const stage = mapDbStatusToReviewStage(row.status as string);
  const outcome = presentReviewOutcome({ dbStatus: row.status as string, decision: decision ?? legacyReviewDecisionFromStatus(row.status as string) });
  return {
    id: row.id,
    evidenceId: row.evidenceId,
    teamId: row.teamId,
    stage,
    workflowStateLabel: outcome.workflowStateLabel,
    decision: outcome.decision,
    decisionLabel: outcome.decisionLabel,
    // The export gate reads the DECISION (an approved review stays approved
    // when it is closed); the stage alone only when no decision was loaded.
    approvedForGovernanceGate: decision !== undefined ? decision === "APPROVED" : reviewStageSatisfiesGovernanceGate(stage),
    priority: row.priority,
    assignedToUserId: row.assignedToUserId,
    assignedByUserId: row.assignedByUserId,
    assignedAtUtc: row.assignedAtUtc?.toISOString() ?? null,
    reassignedAtUtc: row.reassignedAtUtc?.toISOString() ?? null,
    dueAt: row.dueAt?.toISOString() ?? null,
    firstResponseDueAtUtc: row.firstResponseDueAtUtc?.toISOString() ?? null,
    escalationDueAtUtc: row.escalationDueAtUtc?.toISOString() ?? null,
    completedAtUtc: row.completedAtUtc?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    slaStatus: row.slaStatus,
    escalationLevel: row.escalationLevel,
    escalatedAtUtc: row.escalatedAtUtc?.toISOString() ?? null,
    escalatedByUserId: row.escalatedByUserId,
    escalationReason: row.escalationReason,
    reopenCount: row.reopenCount,
    reopenedAtUtc: row.reopenedAtUtc?.toISOString() ?? null,
    rejectionReason: row.rejectionReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    // Deliberately NOT projected: internal `billingShape`, raw `status`
    // (use `stage` instead).
  };
}
