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

import { escalationNoteForStorage, legacyReviewDecisionFromStatus, presentReviewOutcome, type ReviewDecision } from "@proovra/shared";
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
  REVIEW_FINISHED_DB_STATUSES,
  isReviewOpenDbStatus,
  storedReviewSlaStatus,
  reviewSlaBreachedSince,
  stageMoveRefusal,
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
import { escalatedReviewWhere } from "../reviewer-ops/review-count-definitions.js";
import { triggerReviewAssigned } from "../automation/automation-triggers.js";
import {
  notifyReviewAssigned,
  notifyReviewSlaBreached,
} from "./review-notifications.service.js";
// Track 1C — canonical review-decision authority. Reviewer VERDICTS
// (approve / reject / request-info) are recorded ONLY through this
// service, which appends the immutable WorkflowReviewDecision row and
// derives the workflow.status projection in one transaction. This file
// retains only NON-decision lifecycle transitions.
import {
  ReviewDecisionAuthorityError,
  loadCurrentRoundDecisionState,
  recordReviewDecision as recordCanonicalReviewDecision,
} from "../reviewer-ops/review-decision.service.js";
import {
  createEscalation,
  resolveOpenReviewEscalation,
} from "../reviewer-ops/escalation-engine.service.js";
import { recordReviewActivityTx } from "../evidence-review/reviewer-audit.service.js";
import {
  AssigneeEligibilityError,
  assertWorkAssigneeEligible,
} from "../assignment/assignee-eligibility.js";
import { evidenceVisibleThroughCasesWhere } from "../cases/case-visibility.js";
import { stampReviewDeadlines } from "../reviewer-ops/review-sla-stamp.service.js";
import { resolveEffectiveSlaPolicy } from "../reviewer-ops/sla-policy.service.js";
import { workspaceIncludesReviewCapability } from "../billing-enforcement.service.js";
import { advanceSweepCursor, afterCursor, readSweepCursor } from "../reviewer-ops/sweep-cursor.js";
import { withReadTimeSlaFacts } from "../reviewer-ops/review-sla-read-facts.js";

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
      | "evidence_not_in_workspace"
      | "assignee_not_eligible"
      | "assignee_not_placed",
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "ReviewOperationError";
  }
}

// -----------------------------------------------------------------------------
// Who may carry a review (members audit REV-02, 2026-10-25)
// -----------------------------------------------------------------------------

/**
 * A review is handed only to someone who can do it: an ACTIVE, unexpired
 * member of the record's workspace whose role holds the reviewer permission,
 * and who can reach the evidence itself (a restricted case keeps its own
 * access list). Before this the assignee was any user id at all — and the
 * assignment notification then mailed a stranger the workspace's name.
 *
 * Every assignment writer goes through `assignReviewer`, so stating it here
 * covers the single-item routes, the reviewer-ops console and bulk triage.
 * The refusal does not say WHICH condition failed: a would-be assigner learns
 * nothing about a person's access they could not already see.
 */
export async function assertReviewAssigneeEligible(
  workflow: { teamId: string | null; evidenceId: string },
  assigneeUserId: string,
  client: PrismaClient,
  options: { inTransaction?: boolean } = {},
): Promise<void> {
  if (!workflow.teamId) throw new ReviewOperationError("assignee_not_eligible");
  // THE ONE assignee authority (capability + reach + Collaboration Team
  // placement on PRO/TEAM; Enterprise per contract). See assignee-eligibility.
  try {
    await assertWorkAssigneeEligible(
      {
        workspaceId: workflow.teamId,
        assigneeUserId,
        permission: "evidence_request.review",
        evidenceId: workflow.evidenceId,
      },
      client,
      { ...options, placementRule: "review" },
    );
  } catch (err) {
    if (err instanceof AssigneeEligibilityError) {
      throw new ReviewOperationError(
        err.reason === "NOT_PLACED" ? "assignee_not_placed" : "assignee_not_eligible",
      );
    }
    throw err;
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
  options: {
    strict?: boolean;
    /**
     * ASSIGNMENT RACES (2026-10-24): also require the assignee this call
     * read. A claim or assignment that keeps the stage (any stage but Queued)
     * changes only the assignee, so a status-only guard let two concurrent
     * claims both "win" — the last write silently replacing the first.
     */
    guardAssignee?: boolean;
    /**
     * WS-SCHED / PRO-R2Z-02 — also require the SLA status this call read. Two
     * SLA sweeps (different locks and cursors) could both read DUE_SOON and
     * both "win" a status-only CAS, each then writing SLA_BREACHED and sending
     * the overdue email.
     */
    guardSlaStatus?: boolean;
  } = {},
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
    // Free text: never the disagreement marker the second-review rule reads.
    data.escalationReason = escalationNoteForStorage(patch.escalationReason)?.slice(0, 400) ?? null;
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
    where: {
      id: workflow.id,
      status: workflow.status,
      ...(options.guardAssignee ? { assignedToUserId: workflow.assignedToUserId } : {}),
      ...(options.guardSlaStatus ? { slaStatus: workflow.slaStatus } : {}),
    },
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

  // ONE TRANSACTION (2026-10-24, audit P2-3): the move, its history event
  // and its reviewer + tenant audit commit together. They were four separate
  // writes, so a failed audit left a committed assignment with no audit, and
  // the retry was the no-op above. A lost race is a refusal (strict).
  const updated = await client.$transaction(async (txc) => {
    // Members audit defect 5 — the assignee rule is decided INSIDE the write's
    // transaction, with the placement it relies on share-locked until commit.
    await assertReviewAssigneeEligible(workflow, input.assignedToUserId, txc as unknown as PrismaClient, {
      inTransaction: true,
    });
    const moved = await stampReviewDeadlines(
      await applyTransition(
        workflow,
        targetStage,
        {
          assignedToUserId: input.assignedToUserId,
          assignedByUserId: input.actorUserId,
          assignedAtUtc: workflow.assignedAtUtc ?? now,
          reassignedAtUtc: isReassignment ? now : workflow.reassignedAtUtc,
        },
        txc as unknown as PrismaClient,
        { strict: true, guardAssignee: true },
      ),
      { requireStatedPolicy: false, source: "assignment", actorUserId: input.actorUserId, now },
      txc as unknown as PrismaClient,
    );
    await txc.evidenceReviewWorkflowEvent.create({
      data: {
        workflowId: workflow.id,
        evidenceId: workflow.evidenceId,
        actorUserId: input.actorUserId,
        eventType: isReassignment ? "REASSIGNED" : "ASSIGNED",
        previousValue: { assignedToUserId: workflow.assignedToUserId, stage: fromStage } as Prisma.InputJsonValue,
        nextValue: { assignedToUserId: input.assignedToUserId, stage: targetStage } as Prisma.InputJsonValue,
        note: input.note?.slice(0, 1000) ?? null,
      },
    });
    await recordReviewActivityTx(txc, {
      evidenceId: workflow.evidenceId,
      workflowId: workflow.id,
      teamId: workflow.teamId ?? null,
      actorUserId: input.actorUserId,
      code: "REVIEW_ASSIGNMENT_CHANGED",
      previousState: String(workflow.status),
      resultingState: String(moved.status),
    });
    return moved;
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

  // ONE TRANSACTION (2026-10-24, audit P2-3) — as assignment above. Of two
  // concurrent claims exactly one wins; the other is refused (strict, with
  // the assignee it read guarded).
  return client.$transaction(async (txc) => {
    // Claiming queue work is RECEIVING work: the same assignee rule applies to
    // the claimant (members audit, unassigned-member decision) — decided inside
    // the claim's transaction (defect 5), as assignment above.
    if (workflow.assignedToUserId !== input.actorUserId) {
      await assertReviewAssigneeEligible(workflow, input.actorUserId, txc as unknown as PrismaClient, {
        inTransaction: true,
      });
    }
    const moved = await stampReviewDeadlines(
      await applyTransition(
        workflow,
        targetStage,
        {
          assignedToUserId: input.actorUserId,
          assignedByUserId: input.actorUserId,
          assignedAtUtc: workflow.assignedAtUtc ?? now,
        },
        txc as unknown as PrismaClient,
        { strict: true, guardAssignee: true },
      ),
      { requireStatedPolicy: false, source: "assignment", actorUserId: input.actorUserId, now },
      txc as unknown as PrismaClient,
    );
    await txc.evidenceReviewWorkflowEvent.create({
      data: {
        workflowId: workflow.id,
        evidenceId: workflow.evidenceId,
        actorUserId: input.actorUserId,
        eventType: "CLAIMED",
        previousValue: { assignedToUserId: workflow.assignedToUserId, stage: fromStage } as Prisma.InputJsonValue,
        nextValue: { assignedToUserId: input.actorUserId, stage: targetStage } as Prisma.InputJsonValue,
        note: null,
      },
    });
    await recordReviewActivityTx(txc, {
      evidenceId: workflow.evidenceId,
      workflowId: workflow.id,
      teamId: workflow.teamId ?? null,
      actorUserId: input.actorUserId,
      code: "REVIEW_CLAIMED",
      previousState: String(workflow.status),
      resultingState: String(moved.status),
    });
    return moved;
  });
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

/**
 * Round 2 (2026-11-25) — authorization BEFORE step-up for Close and Reopen.
 * Every refusal recordLifecycleTransition can give before it writes, asked
 * without writing: note, same stage, the stage matrix and (Close) the pending
 * second review / unresolved disagreement. Throws the SAME errors; resolves
 * when the move would be accepted. The real call re-checks under the row lock.
 */
export async function precheckLifecycleTransition(
  input: Pick<RecordLifecycleTransitionInput, "evidenceId" | "decision" | "note" | "escalationReason">,
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  const workflow = await client.evidenceReviewWorkflow.findUnique({ where: { evidenceId: input.evidenceId } });
  if (!workflow) throw new ReviewOperationError("workflow_not_found");
  if (decisionRequiresNote(input.decision)) {
    const noteText = (input.note ?? input.escalationReason ?? "").trim();
    if (!noteText) throw new ReviewOperationError("note_required", { decision: input.decision });
  }
  const fromStage = mapDbStatusToReviewStage(workflow.status as string);
  const toStage = decisionTargetStage(input.decision);
  // The canonical stage rule (shared with the action projections).
  const move = stageMoveRefusal(fromStage, toStage);
  if (move === "already_in_stage") throw new ReviewOperationError("already_in_stage", { stage: fromStage });
  if (input.decision === "CLOSE" && workflow.teamId) {
    const round = await loadCurrentRoundDecisionState(
      {
        id: workflow.id,
        teamId: workflow.teamId,
        evidenceId: workflow.evidenceId,
        status: String(workflow.status),
        decisionRound: workflow.decisionRound,
      },
      client,
    );
    if (round.state === "second_required" || round.state === "conflict_detected") {
      throw new ReviewDecisionAuthorityError("second_review_pending", {
        reason: "second_review_pending",
        reviewState: round.state,
      });
    }
  }
  if (move === "invalid_stage_transition") {
    throw new ReviewOperationError("invalid_stage_transition", { from: fromStage, to: toStage });
  }
}

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
    // The escalation engine notifies whoever holds it (T-170), once.
    await afterCommit?.().catch(() => null);
    return updated;
  }

  // Reopen / Close: the move, its event and its audit entry are one
  // transaction (ET-CUS-12, 2026-10-23).
  const updated = await client.$transaction(async (txc) => {
    const tx = txc as unknown as PrismaClient;
    // TEAM-SPEC §2.2 — Close never skips a pending second review or an
    // unresolved disagreement (every Close door funnels through here: the
    // single-item route, both bulk paths). Decided ATOMICALLY: the workflow row
    // is locked first, so a decision that committed before is read here, and
    // a decision still in flight cannot land after — its own write is
    // conditional on the status this Close is about to change, and is refused.
    if (input.decision === "CLOSE" && workflow.teamId) {
      await txc.$queryRaw`SELECT "id" FROM "evidence_review_workflows" WHERE "id" = ${workflow.id}::uuid FOR UPDATE`;
      const locked = await txc.evidenceReviewWorkflow.findUniqueOrThrow({
        where: { id: workflow.id },
        select: { status: true, decisionRound: true },
      });
      const round = await loadCurrentRoundDecisionState(
        {
          id: workflow.id,
          teamId: workflow.teamId,
          evidenceId: workflow.evidenceId,
          status: String(locked.status),
          decisionRound: locked.decisionRound,
        },
        txc,
      );
      if (round.state === "second_required" || round.state === "conflict_detected") {
        throw new ReviewDecisionAuthorityError("second_review_pending", {
          reason: "second_review_pending",
          reviewState: round.state,
        });
      }
    }
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
  // The same facts the Review header reads (a pre-column first decision comes
  // from the decision log); only used to compute, the write fences on `workflow`.
  const [facts] = await withReadTimeSlaFacts([workflow], client);
  const computed = storedReviewSlaStatus({
    ...(facts ?? workflow),
    dueAt: effectiveDue,
    firstResponseDueAtUtc: effectiveFirstResponse,
    slaPausedAtUtc: (input.paused ?? !!workflow.slaPausedAtUtc) ? new Date() : null,
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
 * Moves each open review's stored SLA status to what its deadlines now say, one
 * calculation shared with the badge (WORKFLOW-007).
 *
 *   - Every deadline counts, not only `dueAt` (WORKFLOW-006). A breach is a missed
 *     deadline: the policy states the hours, so nothing is added behind them.
 *   - Finished and paused rows are skipped.
 *   - The breach event and email fire once, on the move into BREACHED.
 *   - The read resumes where the last one stopped (WORKFLOW-012). A stable row
 *     stays eligible, so a first-N read would never get past those N.
 */
export async function reconcileReviewSlas(
  input: {
    teamId?: string;
    batchSize?: number;
    /** Pages per call. The engine reads a whole workspace; the default reads one. */
    maxPages?: number;
    now?: Date;
  } = {},
  client: PrismaClient = defaultPrisma,
): Promise<{
  scanned: number;
  flippedBreached: number;
  flippedDueSoon: number;
  skippedCompleted: number;
  skippedPaused: number;
  /** Rows in workspaces without reviewer-operations entitlement (left untouched). */
  skippedNotEntitled: number;
  /** The rows that moved into BREACHED, for the caller to escalate. */
  breachedWorkflowIds: string[];
  /**
   * Of those, the HISTORICAL BACKLOG at rollout: breaches whose deadline passed
   * before the presented SLA rules first swept this workspace, found inside the
   * bounded rollout window. Status, SLA_BREACHED event and escalation as usual;
   * no overdue e-mail. Every breach occurring after rollout is e-mailed.
   */
  breachedStale: number;
  /** True when this call reached the last row. */
  wrapped: boolean;
}> {
  const batchSize = Math.min(Math.max(input.batchSize ?? 200, 1), 2000);
  const maxPages = Math.min(Math.max(input.maxPages ?? 1, 1), 50);
  const now = input.now ?? new Date();
  const cursorKey = `reviewer_sla:${input.teamId ?? "all"}`;
  const windows = new Map<string, number>();
  const dueSoonFor = async (teamId: string | null): Promise<number | undefined> => {
    if (!teamId) return undefined;
    if (!windows.has(teamId)) {
      const { policy } = await resolveEffectiveSlaPolicy({ teamId }, client);
      windows.set(teamId, policy.dueSoonHours);
    }
    return windows.get(teamId);
  };
  // TEAM-SPEC (2026-11-23, D-ESC-1) — SLA automation runs only where the
  // workspace is still entitled to reviewer operations, the same answer the
  // reconcile engine and every reviewer-ops route apply. The cron sweep
  // (POST /v1/review-operations/reconcile-slas, every workspace) used to flip
  // and email workspaces downgraded from TEAM. Skipped rows are left exactly as
  // they are: nothing is deleted or rewritten.
  const entitled = new Map<string, boolean>();
  const automationEntitled = async (teamId: string | null): Promise<boolean> => {
    if (!teamId) return false;
    if (!entitled.has(teamId)) {
      entitled.set(teamId, await workspaceIncludesReviewCapability(teamId, "REVIEW_ESCALATION").catch(() => false));
    }
    return entitled.get(teamId)!;
  };
  let skippedNotEntitled = 0;

  let scanned = 0;
  let flippedBreached = 0;
  let flippedDueSoon = 0;
  let skippedCompleted = 0;
  let skippedPaused = 0;
  let wrapped = false;
  const breachedWorkflowIds: string[] = [];
  let breachedStale = 0;
  const rolloutAt = new Map<string, Date>();
  const rolloutFor = async (teamId: string): Promise<Date> => {
    if (!rolloutAt.has(teamId)) rolloutAt.set(teamId, await presentedSlaRolloutAt(teamId, now, client));
    return rolloutAt.get(teamId)!;
  };

  for (let page = 0; page < maxPages && !wrapped; page += 1) {
    const cursor = await readSweepCursor(client, cursorKey);
    const candidates = await client.evidenceReviewWorkflow.findMany({
      where: {
        ...(input.teamId ? { teamId: input.teamId } : {}),
        ...afterCursor(cursor),
        status: { notIn: [...REVIEW_FINISHED_DB_STATUSES] },
        OR: [
          { assignmentDueAtUtc: { not: null } },
          { firstResponseDueAtUtc: { not: null } },
          { dueAt: { not: null } },
          { completionDueAtUtc: { not: null } },
          { escalationDueAtUtc: { not: null } },
        ],
      },
      orderBy: { id: "asc" },
      take: batchSize,
    });
    scanned += candidates.length;
    // The SAME facts the Review header reads: a first decision recorded before
    // first_decided_at_utc existed is filled from the decision log, and a
    // deadline the open-review sweep stamped after its fact does not count.
    // Used only to COMPUTE the status; the write below fences on the row read.
    const facts = new Map((await withReadTimeSlaFacts(candidates, client)).map((r) => [r.id, r]));
    for (const wf of candidates) {
      if (wf.completedAtUtc) {
        skippedCompleted += 1;
        continue;
      }
      if (wf.slaPausedAtUtc) {
        skippedPaused += 1;
        continue;
      }
      if (!(await automationEntitled(wf.teamId))) {
        skippedNotEntitled += 1;
        continue;
      }
      const dueSoonHours = wf.slaDueSoonHours ?? (await dueSoonFor(wf.teamId));
      const read = facts.get(wf.id) ?? wf;
      const computed = storedReviewSlaStatus(read, { nowUtc: now, dueSoonHours });
      if (!computed || computed === wf.slaStatus) continue;
      const stage = mapDbStatusToReviewStage(wf.status as string);
      try {
        // PRO-R2Z-02 — the move into BREACHED is STRICT and fenced on the SLA
        // status read: only the call that performed it records the event and
        // sends the email (a lost race throws and is skipped below).
        await applyTransition(
          wf,
          stage,
          { slaStatus: computed },
          client,
          computed === "BREACHED" ? { strict: true, guardSlaStatus: true } : {},
        );
        if (computed === "BREACHED") {
          flippedBreached += 1;
          const since = reviewSlaBreachedSince(read, { nowUtc: now, dueSoonHours });
          const stale = isHistoricalBacklogBreach({ since, now, rolloutAt: await rolloutFor(wf.teamId!) });
          await recordEvent(
            wf,
            "SLA_BREACHED",
            null,
            null,
            { slaStatus: wf.slaStatus },
            {
              slaStatus: computed,
              ...(since ? { breachedSinceUtc: since.toISOString() } : {}),
              ...(stale ? { notified: false, reason: "historical_backlog_at_rollout" } : {}),
            },
            client,
          );
          breachedWorkflowIds.push(wf.id);
          if (stale) {
            breachedStale += 1;
          } else {
            // One overdue-reminder email per BREACHED transition. Safe.
            notifyReviewSlaBreached({ workflow: wf }, client).catch(() => null);
          }
        } else if (computed === "DUE_SOON") {
          flippedDueSoon += 1;
        }
      } catch {
        /* ignore; sweeper is best-effort */
      }
    }
    const advanced = await advanceSweepCursor(client, cursorKey, cursor, {
      lastId: candidates.at(-1)?.id ?? null,
      pageSize: candidates.length,
      limit: batchSize,
    });
    wrapped = advanced.wrapped;
  }
  return {
    scanned,
    flippedBreached,
    breachedStale,
    flippedDueSoon,
    skippedCompleted,
    skippedPaused,
    skippedNotEntitled,
    breachedWorkflowIds,
    wrapped,
  };
}

/**
 * Gives open reviews that have no stamped policy their deadlines (WORKFLOW-006):
 * rows written before deadlines existed, and rows whose workspace has since stated
 * hours. Each window counts from this sweep. A stamped row leaves the set, so this
 * read cannot stick on its first N.
 */
export async function stampOpenReviewDeadlines(
  input: { teamId: string; batchSize?: number; now?: Date },
  client: PrismaClient = defaultPrisma,
): Promise<{ stamped: number }> {
  const { sources } = await resolveEffectiveSlaPolicy({ teamId: input.teamId }, client);
  const workspaceStated = Object.keys(sources.workspace).length > 0;
  const rows = await client.evidenceReviewWorkflow.findMany({
    where: {
      teamId: input.teamId,
      slaDueSoonHours: null,
      slaPausedAtUtc: null,
      completedAtUtc: null,
      closedAt: null,
      status: { notIn: [...REVIEW_FINISHED_DB_STATUSES] },
      ...(workspaceStated
        ? {}
        : {
            OR: [
              { assignedToUserId: { not: null } },
              { dueAt: { not: null } },
              { firstResponseDueAtUtc: { not: null } },
              { completionDueAtUtc: { not: null } },
              { escalationDueAtUtc: { not: null } },
            ],
          }),
    },
    orderBy: { id: "asc" },
    take: Math.min(Math.max(input.batchSize ?? 200, 1), 2000),
  });
  let stamped = 0;
  for (const row of rows) {
    const next = await stampReviewDeadlines(
      row,
      { requireStatedPolicy: false, source: "open_review_sweep", now: input.now },
      client,
    ).catch(() => row);
    if (next !== row) stamped += 1;
  }
  return { stamped };
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
      // A record closed to the actor by a restricted case gets the same row.
      const workflow = await client.evidenceReviewWorkflow.findFirst({
        where: { evidenceId, evidence: evidenceVisibleThroughCasesWhere(input.actorUserId) },
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
              source: "bulk",
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
  // On the first item that was acted on: the first id of the request can be anyone's.
  const firstActedOn = items.find((item) => item.ok)?.evidenceId;
  if (firstActedOn) {
    const first = await client.evidenceReviewWorkflow.findFirst({
      where: { evidenceId: firstActedOn, teamId: input.teamId },
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
  /**
   * Members audit REV-03 — the caller whose queue this is. The queue then
   * follows the restricted-case rule every evidence read applies.
   */
  viewerUserId: string;
};

export async function listReviewQueue(
  input: QueueFilters,
  client: PrismaClient = defaultPrisma,
): Promise<DbWorkflow[]> {
  return client.evidenceReviewWorkflow.findMany({
    where: {
      teamId: input.teamId,
      ...(input.stage ? { status: stageToDbStatus(input.stage) } : {}),
      // A deadline only describes work still open (WORKFLOW-013).
      ...(input.slaStatus
        ? {
            slaStatus: slaStatusToDb(input.slaStatus),
            status: input.stage
              ? stageToDbStatus(input.stage)
              : { notIn: [...REVIEW_FINISHED_DB_STATUSES] },
          }
        : {}),
      ...(input.assignedToUserId
        ? { assignedToUserId: input.assignedToUserId }
        : {}),
      ...(input.unassigned ? { assignedToUserId: null } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.escalated ? { escalationLevel: { gt: 0 } } : {}),
      evidence: evidenceVisibleThroughCasesWhere(input.viewerUserId),
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
  /** Every status, closed included (kept for older clients; T-057). */
  byStage: Record<ReviewStage, number>;
  /** T-057 (stage C) — open reviews by stage (unit: reviews). */
  openByStage: Partial<Record<ReviewStage, number>>;
  /** T-057 (stage C) — finished reviews by outcome stage (unit: reviews). */
  closedByStage: Partial<Record<ReviewStage, number>>;
  overdue: number;
  dueSoon: number;
  unassigned: number;
  assignedToMe: number;
  /** T-052 (stage C) — open reviews that are escalated (unit: reviews). */
  escalatedReviews: number;
  /** Every figure above counts reviews. */
  unit: "reviews";
};

export async function getReviewQueueCounts(
  input: { teamId: string; meUserId?: string },
  client: PrismaClient = defaultPrisma,
): Promise<ReviewQueueCounts> {
  // Members audit defect 10 — the counts are the queue's, so they obey the
  // queue's reach: a workflow whose evidence sits on a restricted case the
  // caller is not on is not counted (the canonical case-visibility rule,
  // restriction flag included — the same narrowing listReviewQueue applies).
  // Counting it disclosed how much review work the caller cannot see.
  const scope: Prisma.EvidenceReviewWorkflowWhereInput = {
    teamId: input.teamId,
    evidence: evidenceVisibleThroughCasesWhere(input.meUserId ?? null),
  };
  const stageRows = await client.evidenceReviewWorkflow.groupBy({
    by: ["status"],
    where: scope,
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
  const openByStage: Partial<Record<ReviewStage, number>> = {};
  const closedByStage: Partial<Record<ReviewStage, number>> = {};
  for (const r of stageRows) {
    const mapped = mapDbStatusToReviewStage(r.status as string);
    byStage[mapped] += r._count._all;
    const bucket = isReviewOpenDbStatus(String(r.status)) ? openByStage : closedByStage;
    bucket[mapped] = (bucket[mapped] ?? 0) + r._count._all;
  }
  // WORKFLOW-013 — every count below is OPEN work, the same set the queues show.
  // A review breached and then approved stays BREACHED on its row as history, and
  // is no longer overdue.
  const open: Prisma.EvidenceReviewWorkflowWhereInput = {
    ...scope,
    status: { notIn: [...REVIEW_FINISHED_DB_STATUSES] },
  };
  const [overdue, dueSoon, unassigned, mine, escalatedReviews] = await Promise.all([
    client.evidenceReviewWorkflow.count({
      where: { ...open, slaStatus: { in: ["OVERDUE", "BREACHED"] } },
    }),
    client.evidenceReviewWorkflow.count({
      where: { ...open, slaStatus: "DUE_SOON" },
    }),
    client.evidenceReviewWorkflow.count({
      where: { ...open, assignedToUserId: null },
    }),
    input.meUserId
      ? client.evidenceReviewWorkflow.count({
          where: { ...open, assignedToUserId: input.meUserId },
        })
      : Promise.resolve(0),
    client.evidenceReviewWorkflow.count({ where: { AND: [scope, escalatedReviewWhere()] } }),
  ]);
  return {
    byStage,
    openByStage,
    closedByStage,
    overdue,
    dueSoon,
    unassigned,
    assignedToMe: mine,
    escalatedReviews,
    unit: "reviews",
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

/**
 * OWNER DECISION 2026-11-25 — bounded, rollout-only suppression of HISTORICAL
 * backlog overdue e-mails. Not a standing cutoff.
 *
 * When the presented SLA rules (round 2) first sweep a workspace, reviews whose
 * deadline passed long ago under the old reading flip to BREACHED all at once.
 * Those — and only those — are recorded and escalated as usual (status,
 * SLA_BREACHED event with `notified: false`, escalation, audit) without an
 * overdue e-mail. A breach is backlog when its missed deadline is EARLIER than
 * the workspace's rollout instant and it is found within
 * REVIEW_SLA_ROLLOUT_BACKLOG_WINDOW_MS of that instant. Every breach whose
 * deadline passes after rollout is e-mailed normally, at any age, forever.
 */
export const REVIEW_SLA_ROLLOUT_BACKLOG_WINDOW_MS = 7 * 86_400_000;

export function isHistoricalBacklogBreach(input: { since: Date | null; now: Date; rolloutAt: Date }): boolean {
  if (!input.since) return false;
  if (input.now.getTime() - input.rolloutAt.getTime() > REVIEW_SLA_ROLLOUT_BACKLOG_WINDOW_MS) return false;
  return input.since.getTime() < input.rolloutAt.getTime();
}

/**
 * The workspace's rollout instant: written ONCE, by the first sweep that runs
 * the presented rules for it (insert-if-absent, so concurrent sweeps and
 * retries agree on one value), then only read. Stored in worker_sweep_cursors
 * (key `sla_presented_rollout:<teamId>`, cursor_at).
 */
export async function presentedSlaRolloutAt(teamId: string, now: Date, client: PrismaClient): Promise<Date> {
  const key = `sla_presented_rollout:${teamId}`;
  await client.workerSweepCursor.createMany({ data: [{ key, cursorAt: now }], skipDuplicates: true });
  const row = await client.workerSweepCursor.findUnique({ where: { key }, select: { cursorAt: true } });
  return row?.cursorAt ?? now;
}
