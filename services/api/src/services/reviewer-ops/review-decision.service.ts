/**
 * Track 1C — Canonical review-decision authority.
 *
 * ONE authority for review decisions. Before this module existed there
 * were two mutually-invisible writers over the same review lifecycle:
 *
 *   (a) the reviewer-ops multi-stage decisions route appended immutable
 *       `WorkflowReviewDecision` rows but never updated
 *       `EvidenceReviewWorkflow.status`;
 *   (b) the Phase 13 review-operations service wrote
 *       `EvidenceReviewWorkflow.status` for approve / reject /
 *       request-info decisions but never appended a decision row.
 *
 * Convergence contract (enforced here + by the authority guard test in
 * test/phase-12b-review-authority.test.ts):
 *
 *   - The immutable `WorkflowReviewDecision` log is THE decision
 *     authority. Rows are append-only — never updated, never deleted.
 *   - `workflow.status` is a DERIVED lifecycle projection, updated in
 *     the SAME transaction as the decision-row append.
 *   - Non-decision lifecycle transitions (assign / claim / start /
 *     pause / SLA sweeps / escalate / reopen / close) still go through
 *     the Phase 13 lifecycle service — they are lifecycle routing, not
 *     reviewer verdicts, and they never masquerade as decisions.
 *
 * Behaviours:
 *   - Workspace isolation: the workflow must belong to the caller's
 *     team; cross-workspace probes are indistinguishable from missing
 *     workflows (anti-enumeration `workflow_not_found`).
 *   - Stale-decision denial: a terminal / already-resolved workflow, or
 *     an optimistic `expectedStatus` mismatch, is a conflict with ZERO
 *     mutation.
 *   - Idempotency: an identical decision (same workflow + same actor +
 *     same decision kind) that is already on the immutable log returns
 *     the existing row — no duplicate append, no projection churn.
 *   - Audit: a workspace-scoped TeamActivity row + an
 *     EvidenceReviewWorkflowEvent history row are written inside the
 *     decision transaction.
 *
 * Wording rule: an APPROVE decision means an authorised operator marked
 * the record as internally approved for governance purposes — never
 * "authentic / legally admissible / proven".
 */

import type {
  EvidenceReviewWorkflow as DbWorkflow,
  EvidenceReviewWorkflowStatus,
  Prisma,
  PrismaClient,
  WorkflowReviewDecision as DbDecision,
  WorkflowReviewDecisionKind,
  WorkflowReviewReasonCode,
  WorkflowReviewStage,
} from "@prisma/client";
import {
  mapDbStatusToReviewStage,
  mapReviewStageToDbStatus,
  type ReviewStage,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { notifyReviewNeedsMoreInfo } from "../review-operations/review-notifications.service.js";

// -----------------------------------------------------------------------------
// Types + error surface
// -----------------------------------------------------------------------------

/** Any client that can run the reads/writes this service needs. */
type Db = PrismaClient | Prisma.TransactionClient;

export class ReviewDecisionAuthorityError extends Error {
  constructor(
    public readonly code:
      | "workflow_not_found"
      | "stale_decision"
      | "review_already_resolved"
      | "duplicate_stage_decision"
      | "same_reviewer_blocked"
      | "adjudicator_role_required"
      | "decision_kind_not_allowed"
      | "rationale_required",
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "ReviewDecisionAuthorityError";
  }
}

export type ReviewDecisionState =
  | "first_required"
  | "second_required"
  | "conflict_detected"
  | "adjudication_required"
  | "resolved";

export type DecisionLogRow = {
  stage: WorkflowReviewStage | string;
  decision: WorkflowReviewDecisionKind | string;
  reviewerUserId: string;
};

/** Decision kinds only valid at the ADJUDICATION stage. */
const ADJUDICATION_ONLY_KINDS: ReadonlySet<string> = new Set([
  "UPHOLD_FIRST",
  "UPHOLD_SECOND",
  "UNRESOLVED",
]);

/**
 * Workflow stages that are terminal for DECISION purposes. Recording a
 * new verdict on a workflow in one of these stages is a stale decision
 * (the operator acted on out-of-date state) → conflict, zero mutation.
 * REOPEN / CLOSE remain lifecycle transitions owned by the Phase 13
 * lifecycle service.
 */
const DECISION_TERMINAL_STAGES: ReadonlySet<ReviewStage> = new Set([
  "APPROVED_INTERNAL",
  "REJECTED_INSUFFICIENT",
  "CLOSED",
]);

/**
 * PHASE 12 POINT 4 PASS C1 — the statuses this authority projects, and which
 * therefore may be written by NOBODY else. The classification itself lives in
 * a dependency-free vocabulary module so the evidence surface can consult it
 * without importing this runtime; re-exported here because this service is
 * the authority that gives it meaning.
 */
export {
  DECISION_DERIVED_WORKFLOW_STATUSES,
  isDecisionDerivedWorkflowStatus,
} from "../evidence-review/review-status-vocabulary.js";

// -----------------------------------------------------------------------------
// Derivation — pure functions over the immutable decision log.
// -----------------------------------------------------------------------------

/**
 * Derive the multi-stage review state from the immutable decision log.
 * (Moved from reviewer-ops.routes.ts so route + authority + reconcile
 * all share ONE derivation.)
 */
export function deriveReviewState(input: {
  decisions: ReadonlyArray<DecisionLogRow>;
  requiresSecond: boolean;
}): ReviewDecisionState {
  const first = input.decisions.find((d) => d.stage === "FIRST");
  const second = input.decisions.find((d) => d.stage === "SECOND");
  const adj = input.decisions.find((d) => d.stage === "ADJUDICATION");
  if (adj) return "resolved";
  if (first && second) {
    if (first.decision !== second.decision) return "conflict_detected";
    return "resolved";
  }
  if (first) {
    return input.requiresSecond ? "second_required" : "resolved";
  }
  return "first_required";
}

/** Map a final decision kind to the projected workflow stage. */
function kindToProjectedStage(
  kind: string | null,
): ReviewStage | null {
  switch (kind) {
    case "APPROVE":
      return "APPROVED_INTERNAL";
    case "REJECT":
      return "REJECTED_INSUFFICIENT";
    case "REQUEST_INFO":
    case "NEEDS_MORE_INFO":
      return "NEEDS_MORE_INFO";
    default:
      return null;
  }
}

export type DecisionProjection = {
  state: ReviewDecisionState;
  /** Resolved outcome kind, when the log resolves to one. */
  finalKind: string | null;
  /**
   * Workflow stage the projection derives from the log. `null` means
   * "the log does not (yet) determine a stage" — the current lifecycle
   * status stands (e.g. awaiting a second review).
   */
  projectedStage: ReviewStage | null;
};

/**
 * Deterministically project the workflow stage from the immutable
 * decision log. This is the ONE place decision → status derivation
 * lives; recordReviewDecision and reconcileWorkflowProjection both use
 * it.
 */
export function deriveDecisionProjection(
  decisions: ReadonlyArray<DecisionLogRow>,
  requiresSecond: boolean,
): DecisionProjection {
  const first = decisions.find((d) => d.stage === "FIRST") ?? null;
  const second = decisions.find((d) => d.stage === "SECOND") ?? null;
  const adj = decisions.find((d) => d.stage === "ADJUDICATION") ?? null;

  if (adj) {
    if (adj.decision === "UNRESOLVED") {
      return { state: "resolved", finalKind: null, projectedStage: "ESCALATED" };
    }
    const finalKind =
      adj.decision === "UPHOLD_FIRST"
        ? (first?.decision as string | undefined) ?? null
        : adj.decision === "UPHOLD_SECOND"
          ? (second?.decision as string | undefined) ?? null
          : (adj.decision as string);
    return {
      state: "resolved",
      finalKind,
      projectedStage: kindToProjectedStage(finalKind),
    };
  }
  if (first && second) {
    if (first.decision !== second.decision) {
      return {
        state: "conflict_detected",
        finalKind: null,
        projectedStage: "ESCALATED",
      };
    }
    return {
      state: "resolved",
      finalKind: first.decision as string,
      projectedStage: kindToProjectedStage(first.decision as string),
    };
  }
  if (first) {
    if (requiresSecond) {
      return { state: "second_required", finalKind: null, projectedStage: null };
    }
    return {
      state: "resolved",
      finalKind: first.decision as string,
      projectedStage: kindToProjectedStage(first.decision as string),
    };
  }
  return { state: "first_required", finalKind: null, projectedStage: null };
}

// -----------------------------------------------------------------------------
// Second-review requirement (moved from reviewer-ops.routes.ts).
// -----------------------------------------------------------------------------

/**
 * Derive whether a workflow currently requires a second review.
 * Triggers (computed live — no stored column):
 *   - workflow.status === ESCALATED
 *   - an open escalation on the workflow
 *   - an ACTIVE legal hold on the underlying evidence
 *   - at least one redaction-required visibility decision
 */
export async function requiresSecondReview(
  input: { workflowId: string; teamId: string; evidenceId: string },
  client: Db = defaultPrisma,
): Promise<{ required: boolean; reason: string | null }> {
  const [wf, openEsc, holdCount, redactionCount] = await Promise.all([
    client.evidenceReviewWorkflow.findUnique({
      where: { id: input.workflowId },
      select: { status: true },
    }),
    client.reviewEscalation.findFirst({
      where: {
        teamId: input.teamId,
        workflowId: input.workflowId,
        status: { in: ["OPEN", "ACKNOWLEDGED", "REASSIGNED"] },
      },
      select: { id: true },
    }),
    client.evidenceLegalHold.count({
      where: {
        teamId: input.teamId,
        evidenceId: input.evidenceId,
        status: "ACTIVE",
      },
    }),
    client.evidenceWorkflowVisibilityDecision.count({
      where: { evidenceId: input.evidenceId, requiresRedaction: true },
    }),
  ]);
  if (wf?.status === "ESCALATED")
    return { required: true, reason: "workflow_escalated" };
  if (openEsc) return { required: true, reason: "open_escalation" };
  if (holdCount > 0) return { required: true, reason: "active_legal_hold" };
  if (redactionCount > 0)
    return { required: true, reason: "redaction_required" };
  return { required: false, reason: null };
}

// -----------------------------------------------------------------------------
// THE atomic decision command.
// -----------------------------------------------------------------------------

export type RecordReviewDecisionInput = {
  workflowId: string;
  teamId: string;
  actorUserId: string;
  /** Canonical decision-kind vocabulary (WorkflowReviewDecisionKind). */
  decision: WorkflowReviewDecisionKind;
  /**
   * Operator rationale. REQUIRED (non-empty) for every kind except
   * APPROVE. Stored verbatim (trimmed, bounded to the column width).
   */
  rationale?: string | null;
  reasonCode?: WorkflowReviewReasonCode | null;
  /**
   * Caller-asserted adjudicator authority (team OWNER/ADMIN). The
   * ROUTE resolves the role (authorization inputs are validated by
   * callers); the service enforces that ADJUDICATION-stage decisions
   * only land when this is true.
   */
  actorIsAdjudicator?: boolean;
  /**
   * Optional optimistic precondition: the raw DB `workflow.status` the
   * caller last observed. A mismatch is a stale decision → conflict,
   * ZERO mutation.
   */
  expectedStatus?: string | null;
};

export type RecordReviewDecisionResult = {
  workflow: DbWorkflow;
  decision: DbDecision;
  state: ReviewDecisionState;
  /** True when an identical decision was already on the immutable log. */
  idempotent: boolean;
};

function stageToDbStatus(stage: ReviewStage): EvidenceReviewWorkflowStatus {
  // NOT a cast. Nine of the ten stage names are also enum members and one is
  // not: the stage is NEEDS_MORE_INFO and the column stores NEEDS_INFO —
  // so the blanket cast that used to live here handed Postgres a value its
  // enum does not contain and turned a valid request-more-info decision into a
  // 500. The mapping is canonical and shared with its inverse.
  return mapReviewStageToDbStatus(stage) as EvidenceReviewWorkflowStatus;
}

export async function recordReviewDecision(
  input: RecordReviewDecisionInput,
  client: PrismaClient = defaultPrisma,
): Promise<RecordReviewDecisionResult> {
  const result = await client.$transaction(async (tx) => {
    // (i) Workspace isolation — cross-workspace probes are
    // indistinguishable from missing workflows.
    const wf = await tx.evidenceReviewWorkflow.findFirst({
      where: { id: input.workflowId, teamId: input.teamId },
    });
    if (!wf) throw new ReviewDecisionAuthorityError("workflow_not_found");

    // (ii) Optimistic precondition — stale decision denial.
    if (
      input.expectedStatus != null &&
      (wf.status as string) !== input.expectedStatus
    ) {
      throw new ReviewDecisionAuthorityError("stale_decision", {
        expectedStatus: input.expectedStatus,
        currentStatus: wf.status,
      });
    }

    const rows = await tx.workflowReviewDecision.findMany({
      where: { workflowId: input.workflowId, teamId: input.teamId },
      orderBy: { decidedAt: "asc" },
    });

    // Idempotent replay — the identical decision (same workflow + same
    // actor + same kind) is already the audit-of-record. Return it
    // without touching the log or the projection.
    const identical = rows.find(
      (r) =>
        r.reviewerUserId === input.actorUserId &&
        r.decision === input.decision,
    );
    if (identical) {
      const requiresSecondNow = await requiresSecondReview(
        {
          workflowId: input.workflowId,
          teamId: input.teamId,
          evidenceId: wf.evidenceId,
        },
        tx,
      );
      return {
        workflow: wf,
        decision: identical,
        state: deriveReviewState({
          decisions: rows,
          requiresSecond: requiresSecondNow.required,
        }),
        idempotent: true,
      };
    }

    // (iii) Terminal / resolved denial — conflict with zero mutation.
    const currentStage = mapDbStatusToReviewStage(wf.status as string);
    if (DECISION_TERMINAL_STAGES.has(currentStage)) {
      throw new ReviewDecisionAuthorityError("review_already_resolved", {
        currentStage,
      });
    }
    const secondReview = await requiresSecondReview(
      {
        workflowId: input.workflowId,
        teamId: input.teamId,
        evidenceId: wf.evidenceId,
      },
      tx,
    );
    const state = deriveReviewState({
      decisions: rows,
      requiresSecond: secondReview.required,
    });
    if (state === "resolved") {
      throw new ReviewDecisionAuthorityError("review_already_resolved", {
        currentState: state,
      });
    }

    // Which stage does this submission target?
    const targetStage: WorkflowReviewStage =
      state === "first_required"
        ? "FIRST"
        : state === "second_required"
          ? "SECOND"
          : "ADJUDICATION";

    // Same-reviewer independence guard (server-enforced).
    if (targetStage === "SECOND") {
      const first = rows.find((d) => d.stage === "FIRST");
      if (first && first.reviewerUserId === input.actorUserId) {
        throw new ReviewDecisionAuthorityError("same_reviewer_blocked", {
          firstReviewerUserId: first.reviewerUserId,
        });
      }
    }

    // Adjudication requires caller-asserted OWNER/ADMIN authority.
    if (targetStage === "ADJUDICATION" && !input.actorIsAdjudicator) {
      throw new ReviewDecisionAuthorityError("adjudicator_role_required");
    }

    // Kind constraints — UPHOLD_* / UNRESOLVED only at ADJUDICATION.
    if (
      targetStage !== "ADJUDICATION" &&
      ADJUDICATION_ONLY_KINDS.has(input.decision)
    ) {
      throw new ReviewDecisionAuthorityError("decision_kind_not_allowed", {
        decision: input.decision,
        stage: targetStage,
      });
    }

    // Rationale — required for every kind except APPROVE.
    const rationale = (input.rationale ?? "").trim().slice(0, 4000);
    if (rationale.length === 0 && input.decision !== "APPROVE") {
      throw new ReviewDecisionAuthorityError("rationale_required", {
        decision: input.decision,
      });
    }

    // (iv) Append the IMMUTABLE decision row. The DB unique
    // (workflow_id, stage) constraint is the concurrency backstop — a
    // concurrent duplicate surfaces as P2002 → conflict.
    let created: DbDecision;
    try {
      created = await tx.workflowReviewDecision.create({
        data: {
          workflowId: input.workflowId,
          teamId: input.teamId,
          stage: targetStage,
          reviewerUserId: input.actorUserId,
          decision: input.decision,
          reasonCode: input.reasonCode ?? null,
          rationale,
        },
      });
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "P2002") {
        throw new ReviewDecisionAuthorityError("duplicate_stage_decision", {
          stage: targetStage,
        });
      }
      throw err;
    }

    // (v) Update the DERIVED workflow.status projection in the SAME
    // transaction. The projection follows the log — never the other
    // way around.
    const projection = deriveDecisionProjection(
      [...rows, created],
      secondReview.required,
    );
    const now = new Date();
    const data: Prisma.EvidenceReviewWorkflowUncheckedUpdateInput = {
      lastReviewedAt: now,
    };
    if (
      projection.projectedStage !== null &&
      projection.projectedStage !== currentStage
    ) {
      data.status = stageToDbStatus(projection.projectedStage);
      switch (projection.projectedStage) {
        case "APPROVED_INTERNAL":
          data.completedAtUtc = now;
          break;
        case "REJECTED_INSUFFICIENT":
          data.completedAtUtc = now;
          data.rejectionReason = rationale.slice(0, 400) || null;
          break;
        case "ESCALATED":
          data.escalationLevel = wf.escalationLevel + 1;
          data.escalatedAtUtc = now;
          data.escalatedByUserId = input.actorUserId;
          data.escalationReason = "reviewer_disagreement";
          break;
        default:
          break;
      }
    }
    const updated = await tx.evidenceReviewWorkflow.update({
      where: { id: wf.id },
      data,
    });

    // (vi) Audit — workflow event history + workspace activity feed,
    // atomically with the decision.
    await tx.evidenceReviewWorkflowEvent.create({
      data: {
        workflowId: wf.id,
        evidenceId: wf.evidenceId,
        actorUserId: input.actorUserId,
        eventType: "DECISION_LOGGED",
        previousValue: { stage: currentStage } as Prisma.InputJsonValue,
        nextValue: {
          stage: projection.projectedStage ?? currentStage,
          decisionStage: targetStage,
          decision: input.decision,
          state: projection.state,
        } as Prisma.InputJsonValue,
        note: rationale.slice(0, 1000) || null,
      },
    });
    await tx.teamActivity.create({
      data: {
        teamId: input.teamId,
        actorUserId: input.actorUserId,
        eventType:
          targetStage === "FIRST"
            ? "REVIEWER_DECISION_FIRST"
            : targetStage === "SECOND"
              ? "REVIEWER_DECISION_SECOND"
              : "REVIEWER_DECISION_ADJUDICATION",
        targetType: "workflow_review_decision",
        targetId: created.id,
        metadata: {
          workflowId: wf.id,
          evidenceId: wf.evidenceId,
          stage: targetStage,
          decision: input.decision,
          reasonCode: input.reasonCode ?? null,
        },
      },
    });

    return {
      workflow: updated,
      decision: created,
      state: projection.state,
      idempotent: false,
    };
  });

  // Post-commit operational notification — best-effort, never undoes
  // the decision. Mirrors the pre-convergence Phase 13 behaviour for
  // request-more-info outcomes.
  if (
    !result.idempotent &&
    mapDbStatusToReviewStage(result.workflow.status as string) ===
      "NEEDS_MORE_INFO"
  ) {
    notifyReviewNeedsMoreInfo(
      { workflow: result.workflow, actorUserId: input.actorUserId },
      client,
    ).catch(() => null);
  }

  return result;
}

// -----------------------------------------------------------------------------
// Reconciliation — repair a diverged projection from the immutable log.
// -----------------------------------------------------------------------------

export type ReconcileProjectionResult = {
  workflowId: string;
  repaired: boolean;
  reason:
    | "workflow_not_found"
    | "no_decisions"
    | "reopened_after_decisions"
    | "no_projectable_outcome"
    | "consistent"
    | "repaired";
  fromStage?: ReviewStage;
  toStage?: ReviewStage;
};

/**
 * Deterministically recompute the workflow.status projection from the
 * immutable decision log + lifecycle rules, and repair divergence.
 *
 * Lifecycle rules honoured:
 *   - No decision rows → the workflow is lifecycle-only; status stands.
 *   - A REOPEN that post-dates the latest decision resets the
 *     lifecycle; the historical log stays the audit-of-record but no
 *     longer projects the status.
 *   - Intermediate states (awaiting first/second review) do not
 *     project a stage; status stands.
 */
export async function reconcileWorkflowProjection(
  workflowId: string,
  client: PrismaClient = defaultPrisma,
): Promise<ReconcileProjectionResult> {
  const wf = await client.evidenceReviewWorkflow.findUnique({
    where: { id: workflowId },
  });
  if (!wf || !wf.teamId) {
    return { workflowId, repaired: false, reason: "workflow_not_found" };
  }
  const rows = await client.workflowReviewDecision.findMany({
    where: { workflowId, teamId: wf.teamId },
    orderBy: { decidedAt: "asc" },
  });
  if (rows.length === 0) {
    return { workflowId, repaired: false, reason: "no_decisions" };
  }
  const latestDecidedAt = rows[rows.length - 1]!.decidedAt;
  if (wf.reopenedAtUtc && wf.reopenedAtUtc.getTime() > latestDecidedAt.getTime()) {
    return { workflowId, repaired: false, reason: "reopened_after_decisions" };
  }
  const secondReview = await requiresSecondReview(
    { workflowId, teamId: wf.teamId, evidenceId: wf.evidenceId },
    client,
  );
  const projection = deriveDecisionProjection(rows, secondReview.required);
  if (projection.projectedStage === null) {
    return { workflowId, repaired: false, reason: "no_projectable_outcome" };
  }
  const currentStage = mapDbStatusToReviewStage(wf.status as string);
  if (currentStage === projection.projectedStage) {
    return { workflowId, repaired: false, reason: "consistent" };
  }
  const toStage = projection.projectedStage;
  await client.$transaction(async (tx) => {
    const now = new Date();
    const data: Prisma.EvidenceReviewWorkflowUncheckedUpdateInput = {
      status: stageToDbStatus(toStage),
    };
    if (
      (toStage === "APPROVED_INTERNAL" || toStage === "REJECTED_INSUFFICIENT") &&
      !wf.completedAtUtc
    ) {
      data.completedAtUtc = now;
    }
    await tx.evidenceReviewWorkflow.update({ where: { id: wf.id }, data });
    await tx.evidenceReviewWorkflowEvent.create({
      data: {
        workflowId: wf.id,
        evidenceId: wf.evidenceId,
        actorUserId: null,
        eventType: "STAGE_CHANGED",
        previousValue: { stage: currentStage } as Prisma.InputJsonValue,
        nextValue: {
          stage: toStage,
          source: "decision_projection_reconcile",
        } as Prisma.InputJsonValue,
        note: null,
      },
    });
  });
  return {
    workflowId,
    repaired: true,
    reason: "repaired",
    fromStage: currentStage,
    toStage,
  };
}

/**
 * Bounded batch scan — reconcile every workflow that has at least one
 * decision row (optionally scoped to one team). Deterministic order;
 * per-workflow failures are isolated so one bad row cannot abort the
 * sweep.
 */
export async function scanReviewDecisionProjections(
  input: { teamId?: string; batchSize?: number } = {},
  client: PrismaClient = defaultPrisma,
): Promise<{
  scanned: number;
  repaired: number;
  failures: number;
  results: ReconcileProjectionResult[];
}> {
  const batchSize = Math.min(Math.max(input.batchSize ?? 100, 1), 1000);
  const rows = await client.workflowReviewDecision.findMany({
    where: input.teamId ? { teamId: input.teamId } : {},
    select: { workflowId: true },
    distinct: ["workflowId"],
    orderBy: { workflowId: "asc" },
    take: batchSize,
  });
  const results: ReconcileProjectionResult[] = [];
  let repaired = 0;
  let failures = 0;
  for (const r of rows) {
    try {
      const res = await reconcileWorkflowProjection(r.workflowId, client);
      results.push(res);
      if (res.repaired) repaired += 1;
    } catch {
      failures += 1;
    }
  }
  return { scanned: rows.length, repaired, failures, results };
}
