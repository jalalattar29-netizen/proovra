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

import { advanceSweepCursor, readSweepCursor } from "./sweep-cursor.js";
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
  deriveDecisionProjection,
  deriveReviewState,
  DECISION_TERMINAL_STAGES,
  kindToProjectedStage,
  verdictStageRefusal,
  mapDbStatusToReviewStage,
  mapReviewStageToDbStatus,
  roundContinuesInNewRound,
  stringContainsForbiddenOverclaim,
  type ReviewStage,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { evidenceVisibleThroughCasesWhere } from "../cases/case-visibility.js";
import { evaluateMemberAccess } from "../identity/access-policy.service.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import {
  notifyReviewNeedsMoreInfo,
  notifySecondReviewRequired,
} from "../review-operations/review-notifications.service.js";
import { resolveOpenReviewEscalation } from "./escalation-engine.service.js";
import { releaseHeldOutputs } from "../governance/output-hold-release.service.js";
import {
  requiresSecondReview,
  secondReviewForRound,
  type SecondReviewRequirement,
} from "../evidence-review/second-review.service.js";
import { recordReviewActivityTx } from "../evidence-review/reviewer-audit.service.js";
import { emitDecisionOutcomeSignals } from "./decision-outcome-signals.js";
// Read-only eligibility (T-015). review-handoff reads this module's round
// state; both sides only call each other at run time.
import { countEligibleSecondReviewers } from "./review-handoff.service.js";
import { assertReviewAssigneeEligible, ReviewOperationError } from "../review-operations/review-operations.service.js";
import { buildCodingSnapshot, codingCompletenessRefusal } from "../reviewer-workspace/coding-value.service.js";

// -----------------------------------------------------------------------------
// Types + error surface
// -----------------------------------------------------------------------------

/** Any client that can run the reads/writes this service needs. */

export class ReviewDecisionAuthorityError extends Error {
  constructor(
    public readonly code:
      | "workflow_not_found"
      | "reviewer_required"
      | "stale_decision"
      | "review_already_resolved"
      | "duplicate_stage_decision"
      | "same_reviewer_blocked"
      | "adjudicator_not_independent"
      | "adjudicator_role_required"
      | "decision_kind_not_allowed"
      | "rationale_required"
      | "decision_not_from_stage"
      // TEAM-SPEC R3 (2026-11-23) — decision authority follows the assignment.
      | "not_assignee"
      | "second_stage_needs_reassignment"
      | "use_adjudication"
      | "second_review_pending"
      // T-010 — one input schema on every door.
      | "rationale_too_long"
      | "forbidden_wording"
      // Review remediation 2026-11-27.
      | "reviewer_not_eligible"
      | "coding_incomplete",
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "ReviewDecisionAuthorityError";
  }
}

// The decision-state DERIVATION lives in @proovra/shared (2026-10-23), so the
// Evidence page's projection of what a viewer may decide reads the SAME rules
// as this authority (the evidence route may not import reviewer-ops services).
import type { ReviewDecisionState } from "@proovra/shared";
export type { ReviewDecisionState, DecisionLogRow, DecisionProjection } from "@proovra/shared";
export { deriveReviewState, deriveDecisionProjection } from "@proovra/shared";

/** Decision kinds only valid at the ADJUDICATION stage. */
const ADJUDICATION_ONLY_KINDS: ReadonlySet<string> = new Set([
  "UPHOLD_FIRST",
  "UPHOLD_SECOND",
  "UNRESOLVED",
]);

/**
 * T-011 — the ONLY kinds an adjudication records. A plain verdict during a
 * conflict is refused with `use_adjudication`; it used to be recorded as
 * `ADJUDICATION:REJECT`, a kind the adjudication vocabulary does not have.
 */
export const ADJUDICATION_KINDS: ReadonlySet<string> = new Set([
  "UPHOLD_FIRST",
  "UPHOLD_SECOND",
  "NEEDS_MORE_INFO",
  "UNRESOLVED",
]);

/** T-010 — the rationale bound every door shares (the canonical door's). */
export const REVIEW_DECISION_RATIONALE_MAX = 4000;

/** Which door recorded a decision (audit metadata only; never changes the rules). */
export type ReviewDecisionSource =
  | "inspector"
  | "legacy_reviewer_ops"
  | "evidence_page"
  | "bulk"
  | "reconcile"
  | null;

/**
 * Workflow stages that are terminal for DECISION purposes. Recording a
 * new verdict on a workflow in one of these stages is a stale decision
 * (the operator acted on out-of-date state) → conflict, zero mutation.
 * REOPEN / CLOSE remain lifecycle transitions owned by the Phase 13
 * lifecycle service.
 */
// DECISION_TERMINAL_STAGES and the verdict stage rule live in @proovra/shared
// (review-decision-state.ts) so the action projections apply the same rule.

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

// The second-review requirement lives beside the workflow (2026-10-23), for the
// same reason; re-exported so every existing caller keeps one import.
export { requiresSecondReview, secondReviewForRound } from "../evidence-review/second-review.service.js";

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
   * TEAM-SPEC R3 — the submission came through the EXPLICIT adjudication door
   * (`POST /v1/reviewer-ops/workspace/:id/decisions`). Approve / Reject /
   * Request info never adjudicate: a conflict reached through them is refused
   * with `use_adjudication`, whoever the actor is. Fail-closed: absent = false.
   */
  adjudicationDoor?: boolean;
  /**
   * Optional optimistic precondition: the raw DB `workflow.status` the
   * caller last observed. A mismatch is a stale decision → conflict,
   * ZERO mutation.
   */
  expectedStatus?: string | null;
  /** Which door recorded it — audit metadata only. */
  source?: ReviewDecisionSource;
  /**
   * REQUEST_INFO only (2026-11-27): the workspace member the information is
   * requested from. Absent = the evidence's owner (the existing notification
   * recipient). Recorded on the NEEDS_MORE_INFO event.
   */
  requestedFromUserId?: string | null;
  /**
   * Round 2 (2026-11-25) — authorization BEFORE step-up. Runs every check of the
   * authority inside its transaction, then throws `ReviewDecisionDryRunPassed`
   * where the first immutable write would happen, so the transaction rolls back
   * (including the round bump) and nothing is notified. Use
   * `precheckReviewDecision`, never set this directly.
   */
  dryRun?: boolean;
};

/** Thrown by a dry run that every check passed. Never escapes `precheckReviewDecision`. */
export class ReviewDecisionDryRunPassed extends Error {
  constructor() {
    super("review_decision_dry_run_passed");
    this.name = "ReviewDecisionDryRunPassed";
  }
}

/**
 * The SAME authority, asked before a door spends a step-up challenge: a verdict
 * that would be refused is refused first, with the authority's own error, and no
 * second factor is asked for it. Resolves when the decision would be accepted
 * (or replayed idempotently); throws `ReviewDecisionAuthorityError` otherwise.
 * The real call re-checks everything: state can move between the two.
 */
export async function precheckReviewDecision(
  input: Omit<RecordReviewDecisionInput, "dryRun">,
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  try {
    await recordReviewDecision({ ...input, dryRun: true }, client);
  } catch (err) {
    if (err instanceof ReviewDecisionDryRunPassed) return;
    throw err;
  }
  throw new Error("precheckReviewDecision: the dry run returned instead of stopping");
}

export type ReviewDecisionNextRequirement = "second_review" | "adjudication" | "information" | null;

/**
 * TEAM-SPEC §2.3 — what a submission actually did. A FIRST decision under a
 * second-review requirement records a stage and changes no status; callers
 * report THIS, never "approved", unless the status reached a terminal stage.
 */
export type ReviewDecisionOutcome = {
  /** "NONE" — a request for information records no decision (2026-11-27). */
  stageRecorded: WorkflowReviewStage | "NONE";
  statusChanged: boolean;
  reviewState: ReviewDecisionState;
  nextRequirement: ReviewDecisionNextRequirement;
  idempotent: boolean;
  /**
   * T-015 — present when the round now waits for an independent SECOND
   * reviewer: why, and whether anyone can give it. `staffing` is the
   * machine-readable `no_eligible_second_reviewer` when nobody can.
   */
  secondReview?: {
    cause: string | null;
    escalation: { id: string; reason: string; severity: string } | null;
    eligibleReviewerCount: number;
    staffing: "ok" | "no_eligible_second_reviewer";
  };
};

export function nextRequirementFor(state: ReviewDecisionState): ReviewDecisionNextRequirement {
  if (state === "second_required") return "second_review";
  if (state === "conflict_detected" || state === "adjudication_required") return "adjudication";
  return null;
}

export type RecordReviewDecisionResult = {
  workflow: DbWorkflow;
  /** null for a request for information (no decision row, 2026-11-27). */
  decision: DbDecision | null;
  state: ReviewDecisionState;
  /** True when an identical decision was already on the immutable log. */
  idempotent: boolean;
  /** The stored status the decision was made against. */
  previousStatus: string;
  outcome: ReviewDecisionOutcome;
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
  const rationale = (input.rationale ?? "").trim();
  // THE AUTHORITY ASKS, NOT ITS CALLERS (WORKFLOW-001). A verdict satisfies the
  // report, package and public-verify gates and cannot be erased from the log,
  // and one door skipped the check, so a read-only member could approve. The
  // canonical engine answers here for every door, live and bulk.
  const decision = await evaluateMemberAccess(
    {
      teamId: input.teamId,
      userId: input.actorUserId,
      permission: "evidence_request.review",
      resourceKind: "review_workflow",
      resourceId: input.workflowId,
    },
    client,
  );
  if (!decision.allowed) throw new ReviewDecisionAuthorityError("reviewer_required");

  // F-04 (review remediation 2026-11-27) — a request for information is a
  // workflow action, never a vote: it records no decision row and consumes no
  // FIRST / SECOND slot. Adjudication keeps its own NEEDS_MORE_INFO outcome.
  if (input.decision === "REQUEST_INFO") {
    return recordInformationRequest(input, rationale, client);
  }

  const result: RecordReviewDecisionResult = await client.$transaction(async (tx): Promise<RecordReviewDecisionResult> => {
    // (i) Workspace isolation — cross-workspace probes are
    // indistinguishable from missing workflows. So is a record closed to the
    // actor by a restricted case (WORKFLOW-003).
    const wf = await tx.evidenceReviewWorkflow.findFirst({
      where: {
        id: input.workflowId,
        teamId: input.teamId,
        evidence: evidenceVisibleThroughCasesWhere(input.actorUserId),
      },
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

    // THE CURRENT ROUND (2026-10-23). A reopened review — and a review that
    // continues after a request-more-information outcome — decides in a new
    // round; earlier rounds stay on the log and decide nothing now.
    let round = wf.decisionRound;
    let rows = await tx.workflowReviewDecision.findMany({
      where: { workflowId: input.workflowId, teamId: input.teamId, round },
      orderBy: { decidedAt: "asc" },
    });
    // T-018 — a round an adjudicator left UNRESOLVED is finished: the next
    // submission opens a new round, whose first decision must again be
    // confirmed by an independent second reviewer (the disagreement stood).
    let freshRoundRequirement: SecondReviewRequirement | null = null;
    if (rows.length > 0) {
      const continued = roundContinuesInNewRound(
        rows,
        deriveDecisionProjection(rows, true),
        mapDbStatusToReviewStage(wf.status as string),
      );
      if (continued === "unresolved_adjudication") {
        const bumped = await tx.evidenceReviewWorkflow.updateMany({
          where: { id: wf.id, decisionRound: round },
          data: { decisionRound: round + 1 },
        });
        if (bumped.count !== 1) {
          throw new ReviewDecisionAuthorityError("stale_decision", { reason: "round_moved" });
        }
        round += 1;
        rows = [];
        freshRoundRequirement = { required: true, reason: "unresolved_adjudication", escalation: null };
      }
    }
    {
      // The round is finished only by the SAME rule that resolved it. A
      // request for information as the FIRST of two required reviews leaves
      // the round open for the SECOND reviewer, who must not be moved into a
      // new round (audit F1); a request that settled the round stays settled
      // whatever is required later (secondReviewForRound).
      const roundSecond = rows.length > 0
        ? await secondReviewForRound(
            { workflowId: input.workflowId, teamId: input.teamId, evidenceId: wf.evidenceId, round },
            tx,
          )
        : { required: false };
      const roundOutcome = deriveDecisionProjection(rows, roundSecond.required);
      const stageNow = mapDbStatusToReviewStage(wf.status as string);
      if (
        rows.length > 0 &&
        roundOutcome.state === "resolved" &&
        roundOutcome.projectedStage === "NEEDS_MORE_INFO" &&
        !DECISION_TERMINAL_STAGES.has(stageNow) &&
        // The same reviewer repeating the same request WHILE the review still
        // waits for that information is a replay, below. Once the review has
        // moved on, asking again is a new request (audit 2026-10-23 #3: it
        // was a silent no-op that reported success).
        !(
          stageNow === "NEEDS_MORE_INFO" &&
          rows.some((r) => r.reviewerUserId === input.actorUserId && r.decision === input.decision)
        )
      ) {
        // Information was requested; the review continues in a NEW round.
        // Conditional on the round we read, so two concurrent decisions
        // cannot both open it.
        const bumped = await tx.evidenceReviewWorkflow.updateMany({
          where: { id: wf.id, decisionRound: round },
          data: { decisionRound: round + 1 },
        });
        if (bumped.count !== 1) {
          throw new ReviewDecisionAuthorityError("stale_decision", { reason: "round_moved" });
        }
        round += 1;
        rows = [];
      }
    }

    // Idempotent replay — the identical decision (same workflow + same
    // actor + same kind) is already the audit-of-record. Return it
    // without touching the log or the projection.
    const identical = rows.find(
      (r) =>
        r.reviewerUserId === input.actorUserId &&
        r.decision === input.decision,
    );
    if (identical) {
      if (input.dryRun) throw new ReviewDecisionDryRunPassed();
      const requiresSecondNow = await secondReviewForRound(
        {
          workflowId: input.workflowId,
          teamId: input.teamId,
          evidenceId: wf.evidenceId,
          round,
        },
        tx,
      );
      const replayState = deriveReviewState({
        decisions: rows,
        requiresSecond: requiresSecondNow.required,
      });
      return {
        workflow: wf,
        decision: identical,
        state: replayState,
        idempotent: true,
        previousStatus: String(wf.status),
        outcome: {
          stageRecorded: identical.stage,
          statusChanged: false,
          reviewState: replayState,
          nextRequirement: nextRequirementFor(replayState),
          idempotent: true,
        },
      };
    }

    // (iii) Terminal / resolved denial — conflict with zero mutation.
    const currentStage = mapDbStatusToReviewStage(wf.status as string);
    const stageRefusal = verdictStageRefusal(currentStage, input.decision as string);
    if (stageRefusal === "review_already_resolved") {
      throw new ReviewDecisionAuthorityError("review_already_resolved", {
        currentStage,
      });
    }
    // THE STAGE MATRIX (2026-10-23). A verdict is a move to the stage it
    // projects; it was accepted from any non-terminal stage, so a review
    // nobody had started could be approved. Adjudication kinds project no
    // stage of their own and are governed by the decision state below.
    if (stageRefusal === "decision_not_from_stage") {
      throw new ReviewDecisionAuthorityError("decision_not_from_stage", {
        currentStage,
        verdictStage: kindToProjectedStage(input.decision as string),
      });
    }
    // The requirement that governs THIS round: a fresh round after an
    // unresolved adjudication requires it; a round that already holds its
    // FIRST decision keeps the requirement that decision was recorded under
    // (secondReviewForRound — resolving the escalation never finalises it);
    // otherwise the live requirement (T-013 forcing predicate).
    const liveRequirement = await requiresSecondReview(
      { workflowId: input.workflowId, teamId: input.teamId, evidenceId: wf.evidenceId },
      tx,
    );
    let secondReview: SecondReviewRequirement = freshRoundRequirement ?? liveRequirement;
    if (!freshRoundRequirement && !liveRequirement.required && rows.length > 0) {
      const pinned = await secondReviewForRound(
        { workflowId: input.workflowId, teamId: input.teamId, evidenceId: wf.evidenceId, round },
        tx,
      );
      if (pinned.required) secondReview = pinned;
    }
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

    // TEAM-SPEC R3 — the FIRST decision (a request for information included)
    // belongs to the CURRENT ASSIGNEE. Holding review.assign confers no
    // decision authority. Read on the row this transaction decides against;
    // the projection write below is conditional on the same assignment, so a
    // reassignment that commits meanwhile refuses this decision.
    if (targetStage === "FIRST" && wf.assignedToUserId !== input.actorUserId) {
      throw new ReviewDecisionAuthorityError("not_assignee", {
        reason: "not_assignee",
        stage: "FIRST",
      });
    }

    // Same-reviewer independence guard (server-enforced).
    if (targetStage === "SECOND") {
      const first = rows.find((d) => d.stage === "FIRST");
      if (first && first.reviewerUserId === input.actorUserId) {
        throw new ReviewDecisionAuthorityError("same_reviewer_blocked", {
          reason: "same_reviewer_blocked",
          firstReviewerUserId: first.reviewerUserId,
          nextRequirement: "second_review",
        });
      }
      // The SECOND decision belongs to the reviewer an assignment manager
      // reassigned the review to — never to whoever holds the permission.
      if (wf.assignedToUserId !== input.actorUserId) {
        throw new ReviewDecisionAuthorityError("second_stage_needs_reassignment", {
          reason: "second_stage_needs_reassignment",
          stage: "SECOND",
        });
      }
    }

    // Approve / Reject / Request info never adjudicate (TEAM-SPEC R3): a
    // conflict is resolved only through the explicit adjudication action.
    if (targetStage === "ADJUDICATION" && !input.adjudicationDoor) {
      throw new ReviewDecisionAuthorityError("use_adjudication", {
        reason: "use_adjudication",
        reviewState: state,
      });
    }

    // Adjudication requires caller-asserted OWNER/ADMIN authority.
    if (targetStage === "ADJUDICATION" && !input.actorIsAdjudicator) {
      throw new ReviewDecisionAuthorityError("adjudicator_role_required", {
        reason: "adjudicator_role_required",
      });
    }
    // WORKFLOW-018 — separation of duties at adjudication. An adjudicator
    // resolves a disagreement between the first and second reviewers, so
    // neither of them may resolve it: the same independence the second review
    // has from the first (above), and the second person destruction requires.
    if (targetStage === "ADJUDICATION") {
      const own = rows.find(
        (d) => (d.stage === "FIRST" || d.stage === "SECOND") && d.reviewerUserId === input.actorUserId,
      );
      if (own) {
        throw new ReviewDecisionAuthorityError("adjudicator_not_independent", {
          reviewedAtStage: own.stage,
        });
      }
    }

    // T-011 — an adjudication records ONLY an adjudication kind. A plain
    // verdict (approve / reject / request info) during a conflict is refused
    // with use_adjudication instead of being stored as ADJUDICATION:<verdict>.
    if (targetStage === "ADJUDICATION" && !ADJUDICATION_KINDS.has(input.decision)) {
      throw new ReviewDecisionAuthorityError("use_adjudication", {
        reason: "use_adjudication",
        reviewState: state,
        decision: input.decision,
      });
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

    // Review remediation 2026-11-27 — eligibility is re-checked at WRITE time
    // with the one assignee authority (capability + reach + placement when an
    // explicit policy requires it), so a member who lost eligibility after the
    // assignment cannot decide. Adjudicators are checked by role above.
    if (targetStage !== "ADJUDICATION") {
      try {
        await assertReviewAssigneeEligible(wf, input.actorUserId, tx as unknown as PrismaClient, { inTransaction: true });
      } catch (err) {
        if (err instanceof ReviewOperationError) {
          throw new ReviewDecisionAuthorityError("reviewer_not_eligible", { detail: err.code });
        }
        throw err;
      }
      // F-18 — complete coding is required only under the explicit workspace
      // policy, only for rounds started after it was enabled, and never for a
      // request for information (handled above).
      if (input.decision === "APPROVE" || input.decision === "REJECT") {
        const started = await tx.evidenceReviewWorkflowEvent.findFirst({
          where: { workflowId: wf.id, eventType: "REVIEW_STARTED" },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        });
        const refusal = await codingCompletenessRefusal(tx as unknown as PrismaClient, {
          teamId: input.teamId,
          workflowId: wf.id,
          decision: String(input.decision),
          roundStartedAt: started?.createdAt ?? null,
        });
        if (refusal) {
          throw new ReviewDecisionAuthorityError("coding_incomplete", {
            missingFieldIds: refusal.missingFieldIds,
            missingLabels: refusal.missingLabels,
          });
        }
      }
    }

    // T-010 — ONE input schema, here, so every door inherits it: a non-empty
    // rationale for EVERY kind (an approval included), at most 4000 characters,
    // screened for public-authenticity overclaims. Checked where the rationale
    // rule always sat — after who may decide and at which stage (the workspace
    // policy step of the precedence), so a refusal names the real blocker.
    if (rationale.length === 0) {
      throw new ReviewDecisionAuthorityError("rationale_required", { decision: input.decision });
    }
    if (rationale.length > REVIEW_DECISION_RATIONALE_MAX) {
      throw new ReviewDecisionAuthorityError("rationale_too_long", {
        decision: input.decision,
        max: REVIEW_DECISION_RATIONALE_MAX,
      });
    }
    if (stringContainsForbiddenOverclaim(rationale)) {
      throw new ReviewDecisionAuthorityError("forbidden_wording", { reason: "forbidden_wording" });
    }

    if (input.dryRun) throw new ReviewDecisionDryRunPassed();

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
          round,
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
    // Stage C (T-044) — the first-review SLA completes on the review's first
    // recorded decision (never on Start). Written once; later rounds keep it.
    if (!wf.firstDecidedAtUtc) data.firstDecidedAtUtc = created.decidedAt;
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
    // CONDITIONAL ON THE STAGE THIS DECISION WAS MADE AGAINST (2026-10-24). An
    // unconditional write let a verdict that read the review before a
    // concurrent Close (or any lifecycle move) committed overwrite it — Close
    // returned 200 and the review read Approved. A review that moved under the
    // decision refuses it; the whole transaction (decision row included) rolls
    // back, and the reviewer sees the review as it now is.
    const projected = await tx.evidenceReviewWorkflow.updateMany({
      where: {
        id: wf.id,
        status: wf.status,
        // A FIRST / SECOND decision is the assignee's: conditional on the
        // assignment it was authorized against (TEAM-SPEC R3, atomic).
        ...(targetStage === "ADJUDICATION" ? {} : { assignedToUserId: wf.assignedToUserId }),
      },
      data,
    });
    if (projected.count !== 1) {
      throw new ReviewDecisionAuthorityError("stale_decision", { reason: "concurrent_change" });
    }
    const updated = await tx.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: wf.id } });
    // F-20 — the round's coding, frozen with the decision that FINISHES it
    // (immutable on the event log; a reopened review keeps it and its next
    // finalizing decision records a new one).
    const finalStage = mapDbStatusToReviewStage(String(updated.status));
    const codingSnapshot =
      String(updated.status) !== String(wf.status) &&
      (finalStage === "APPROVED_INTERNAL" || finalStage === "REJECTED_INSUFFICIENT")
        ? await buildCodingSnapshot(tx as unknown as PrismaClient, { teamId: input.teamId, workflowId: wf.id })
        : null;
    // Every recorded submission is on the reviewer audit + tenant audit, in
    // this transaction: a verdict as a decision, a request for information as
    // what it is. Never forensic custody (owner decision 2026-10-24); never
    // for a replay (a replay returned above).
    await recordReviewActivityTx(tx, {
      evidenceId: wf.evidenceId,
      workflowId: wf.id,
      teamId: input.teamId,
      actorUserId: input.actorUserId,
      code: input.decision === "REQUEST_INFO" ? "REVIEW_INFORMATION_REQUESTED" : "REVIEW_DECISION_RECORDED",
      previousState: String(wf.status),
      resultingState: String(updated.status),
      decision: String(input.decision),
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
          round,
          decision: input.decision,
          state: projection.state,
          // T-015 / T-022 — the requirement that governed this decision, as it
          // was when it was recorded. A FIRST decision recorded under an
          // escalation-caused requirement pins its round to the second review
          // (decisionEventPinsSecondReview).
          ...(secondReview.required
            ? {
                secondReviewCause: secondReview.reason,
                ...(secondReview.escalation
                  ? {
                      secondReviewEscalation: {
                        reason: secondReview.escalation.reason,
                        severity: secondReview.escalation.severity,
                      },
                    }
                  : {}),
              }
            : { secondReviewCause: null }),
          ...(input.source ? { source: input.source } : {}),
          ...(codingSnapshot ? { codingSnapshot } : {}),
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
      previousStatus: String(wf.status),
      outcome: {
        stageRecorded: targetStage,
        statusChanged: String(updated.status) !== String(wf.status),
        reviewState: projection.state,
        nextRequirement: nextRequirementFor(projection.state),
        idempotent: false,
      },
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

  // TEAM-SPEC R3 — a FIRST decision that leaves the round awaiting an
  // independent SECOND reviewer tells the workspace's assignment managers
  // (never the first reviewer). After commit, best-effort: a failed send never
  // undoes the decision. A replay notifies nobody; the helper is also
  // idempotent per workflow + round against the delivery log.
  if (result.decision && result.outcome.stageRecorded === "FIRST" && result.outcome.nextRequirement === "second_review") {
    // T-015 — who could give the second review, from THE assignee authority
    // the reassignment applies. Read-only; never reduces the requirement.
    const eligible = await countEligibleSecondReviewers(result.workflow, input.actorUserId, client).catch(() => 0);
    const cause = await secondReviewForRound(
      {
        workflowId: result.workflow.id,
        teamId: input.teamId,
        evidenceId: result.workflow.evidenceId,
        round: result.decision.round,
      },
      client,
    ).catch(() => null);
    result.outcome.secondReview = {
      cause: cause?.reason ?? null,
      escalation: cause?.escalation ?? null,
      eligibleReviewerCount: eligible,
      staffing: eligible > 0 ? "ok" : "no_eligible_second_reviewer",
    };
    if (!result.idempotent) {
      await notifySecondReviewRequired(
        {
          workflow: result.workflow,
          firstReviewerUserId: input.actorUserId,
          firstDecidedAt: result.decision.decidedAt,
          eligibleReviewerCount: eligible,
          cause: cause?.reason ?? null,
        },
        client,
      ).catch(() => null);
    }
  }

  // T-171 — the outcome signals (metrics, security events, the first-decision
  // and completion audit rows) are emitted HERE, once, for every door.
  await emitDecisionOutcomeSignals(
    {
      teamId: input.teamId,
      actorUserId: input.actorUserId,
      workflowId: result.workflow.id,
      decision: String(input.decision),
      workflowStatusAfter: String(result.workflow.status),
      outcome: result.outcome,
      source: input.source ?? null,
    },
    client,
  ).catch(() => null);

  // A verdict that FINISHES the review resolves the escalation raised about
  // it (2026-10-23), so the admins' inbox item does not outlive the issue.
  if (!result.idempotent) {
    const stageAfter = mapDbStatusToReviewStage(result.workflow.status as string);
    if (stageAfter === "APPROVED_INTERNAL" || stageAfter === "REJECTED_INSUFFICIENT") {
      await resolveOpenReviewEscalation(
        { workflow: result.workflow, actorUserId: input.actorUserId, note: "Review decided." },
        client,
      );
    }
    // REPORT-004 — an approval can satisfy a requireReviewBefore* gate that
    // held this record's first outputs at sealing. The release re-reads the
    // policy itself; best effort, never undoes the decision.
    if (stageAfter === "APPROVED_INTERNAL") {
      // A client without the read (a narrow test double) is treated as not held.
      const held = await Promise.resolve()
        .then(() =>
          client.evidence.findUnique({ where: { id: result.workflow.evidenceId }, select: { outputsHeldAtUtc: true } }),
        )
        .catch(() => null);
      if (held?.outputsHeldAtUtc) await releaseHeldOutputs(result.workflow.evidenceId).catch(() => null);
    }
  }

  return result;
}

/**
 * F-04 (review remediation 2026-11-27) — REQUEST FOR INFORMATION, as a
 * workflow action through the ONE authority (every door: the Review page, the
 * lifecycle /request-info route, bulk, the Evidence page and mobile).
 *
 *   - No `workflow_review_decisions` row: it is not an approval or rejection
 *     vote and never takes a FIRST / SECOND slot.
 *   - Allowed for the current assignee of an open round that waits for its
 *     FIRST or SECOND decision (not during a disagreement: adjudication has its
 *     own NEEDS_MORE_INFO outcome), with the same rationale rules and the same
 *     write-time eligibility as a verdict.
 *   - The stage moves to NEEDS_MORE_INFO and a NEEDS_MORE_INFO event records
 *     the reason, the requester and who it is requested from.
 *   - After a FIRST decision (`second_required`) the request SUPERSEDES that
 *     decision for the round: the round advances (the earlier decision stays on
 *     the log), and the requirement's cause is CARRIED into the new round so
 *     the eventual verdict still needs an independent second decision.
 *   - The same requester repeating it while the review waits is a replay.
 */
async function recordInformationRequest(
  input: RecordReviewDecisionInput,
  rationale: string,
  client: PrismaClient,
): Promise<RecordReviewDecisionResult> {
  const result = await client.$transaction(async (tx): Promise<RecordReviewDecisionResult> => {
    const wf = await tx.evidenceReviewWorkflow.findFirst({
      where: { id: input.workflowId, teamId: input.teamId, evidence: evidenceVisibleThroughCasesWhere(input.actorUserId) },
    });
    if (!wf) throw new ReviewDecisionAuthorityError("workflow_not_found");
    if (input.expectedStatus != null && (wf.status as string) !== input.expectedStatus) {
      throw new ReviewDecisionAuthorityError("stale_decision", { expectedStatus: input.expectedStatus, currentStatus: wf.status });
    }
    const currentStage = mapDbStatusToReviewStage(wf.status as string);
    if (currentStage === "NEEDS_MORE_INFO") {
      const last = await tx.evidenceReviewWorkflowEvent.findFirst({
        where: { workflowId: wf.id, eventType: "NEEDS_MORE_INFO" },
        orderBy: { createdAt: "desc" },
        select: { actorUserId: true },
      });
      if (last?.actorUserId === input.actorUserId) {
        if (input.dryRun) throw new ReviewDecisionDryRunPassed();
        return {
          workflow: wf,
          decision: null,
          state: "first_required",
          idempotent: true,
          previousStatus: String(wf.status),
          outcome: { stageRecorded: "NONE", statusChanged: false, reviewState: "first_required", nextRequirement: "information", idempotent: true },
        };
      }
      throw new ReviewDecisionAuthorityError("decision_not_from_stage", { currentStage, reason: "already_awaiting_information" });
    }
    const stageRefusal = verdictStageRefusal(currentStage, "REQUEST_INFO");
    if (stageRefusal === "review_already_resolved") throw new ReviewDecisionAuthorityError("review_already_resolved", { currentStage });
    if (stageRefusal) throw new ReviewDecisionAuthorityError("decision_not_from_stage", { currentStage, verdictStage: "NEEDS_MORE_INFO" });

    const round = wf.decisionRound;
    const rows = await tx.workflowReviewDecision.findMany({
      where: { workflowId: wf.id, teamId: input.teamId, round },
      orderBy: { decidedAt: "asc" },
    });
    const requirement = await secondReviewForRound(
      { workflowId: wf.id, teamId: input.teamId, evidenceId: wf.evidenceId, round },
      tx,
    );
    // A legacy round settled by an old REQUEST_INFO decision row has moved on:
    // read it as a fresh round (its decisions no longer govern).
    const legacyContinued =
      rows.length > 0 && roundContinuesInNewRound(rows, deriveDecisionProjection(rows, requirement.required), currentStage) !== null;
    const liveRows = legacyContinued ? [] : rows;
    const state = deriveReviewState({ decisions: liveRows, requiresSecond: requirement.required });
    if (state === "resolved") throw new ReviewDecisionAuthorityError("review_already_resolved", { currentState: state });
    if (state === "conflict_detected" || state === "adjudication_required") {
      throw new ReviewDecisionAuthorityError("use_adjudication", { reason: "use_adjudication", reviewState: state });
    }
    if (wf.assignedToUserId !== input.actorUserId) {
      throw new ReviewDecisionAuthorityError(state === "second_required" ? "second_stage_needs_reassignment" : "not_assignee", {
        reason: state === "second_required" ? "second_stage_needs_reassignment" : "not_assignee",
      });
    }
    try {
      await assertReviewAssigneeEligible(wf, input.actorUserId, tx as unknown as PrismaClient, { inTransaction: true });
    } catch (err) {
      if (err instanceof ReviewOperationError) throw new ReviewDecisionAuthorityError("reviewer_not_eligible", { detail: err.code });
      throw err;
    }
    if (rationale.length === 0) throw new ReviewDecisionAuthorityError("rationale_required", { decision: "REQUEST_INFO" });
    if (rationale.length > REVIEW_DECISION_RATIONALE_MAX) {
      throw new ReviewDecisionAuthorityError("rationale_too_long", { decision: "REQUEST_INFO", max: REVIEW_DECISION_RATIONALE_MAX });
    }
    if (stringContainsForbiddenOverclaim(rationale)) throw new ReviewDecisionAuthorityError("forbidden_wording", { reason: "forbidden_wording" });
    let requestedFromUserId: string | null = null;
    if (input.requestedFromUserId) {
      const member = await tx.teamMember.findFirst({
        where: { teamId: input.teamId, userId: input.requestedFromUserId, status: "ACTIVE" },
        select: { userId: true },
      });
      // Never disclose who is (not) a member: an unknown recipient falls back to the owner.
      requestedFromUserId = member?.userId ?? null;
    }
    if (input.dryRun) throw new ReviewDecisionDryRunPassed();

    // After a FIRST decision: supersede it for this round and carry the cause.
    const first = liveRows.find((r) => r.stage === "FIRST") ?? null;
    let nextRound = round;
    if (first) {
      const bumped = await tx.evidenceReviewWorkflow.updateMany({
        where: { id: wf.id, decisionRound: round },
        data: { decisionRound: round + 1 },
      });
      if (bumped.count !== 1) throw new ReviewDecisionAuthorityError("stale_decision", { reason: "round_moved" });
      nextRound = round + 1;
    }
    // The request is the reviewer's first substantive response: it completes
    // the FIRST_REVIEW deadline (T-044) exactly as a first decision does, but
    // it records no decision and uses no FIRST / SECOND slot.
    const requestedAt = new Date();
    const moved = await tx.evidenceReviewWorkflow.updateMany({
      where: { id: wf.id, status: wf.status, assignedToUserId: wf.assignedToUserId },
      data: {
        status: stageToDbStatus("NEEDS_MORE_INFO"),
        lastReviewedAt: requestedAt,
        ...(wf.firstDecidedAtUtc ? {} : { firstDecidedAtUtc: requestedAt }),
      },
    });
    if (moved.count !== 1) throw new ReviewDecisionAuthorityError("stale_decision", { reason: "concurrent_change" });
    const updated = await tx.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: wf.id } });
    await recordReviewActivityTx(tx, {
      evidenceId: wf.evidenceId,
      workflowId: wf.id,
      teamId: input.teamId,
      actorUserId: input.actorUserId,
      code: "REVIEW_INFORMATION_REQUESTED",
      previousState: String(wf.status),
      resultingState: String(updated.status),
      decision: "REQUEST_INFO",
    });
    await tx.evidenceReviewWorkflowEvent.create({
      data: {
        workflowId: wf.id,
        evidenceId: wf.evidenceId,
        actorUserId: input.actorUserId,
        eventType: "NEEDS_MORE_INFO",
        previousValue: { stage: currentStage, round } as Prisma.InputJsonValue,
        nextValue: {
          stage: "NEEDS_MORE_INFO",
          round: nextRound,
          requestedByUserId: input.actorUserId,
          requestedFrom: requestedFromUserId ? { userId: requestedFromUserId } : { role: "evidence_owner" },
          ...(first
            ? {
                supersededDecisionId: first.id,
                supersededRound: round,
                carriedSecondReviewCause: requirement.required ? requirement.reason ?? "recorded_requirement" : null,
              }
            : {}),
          ...(input.source ? { source: input.source } : {}),
        } as Prisma.InputJsonValue,
        note: rationale.slice(0, 1000) || null,
      },
    });
    return {
      workflow: updated,
      decision: null,
      state: "first_required",
      idempotent: false,
      previousStatus: String(wf.status),
      outcome: { stageRecorded: "NONE", statusChanged: true, reviewState: "first_required", nextRequirement: "information", idempotent: false },
    };
  });
  if (!result.idempotent) {
    notifyReviewNeedsMoreInfo({ workflow: result.workflow, actorUserId: input.actorUserId }, client).catch(() => null);
  }
  await emitDecisionOutcomeSignals(
    {
      teamId: input.teamId,
      actorUserId: input.actorUserId,
      workflowId: result.workflow.id,
      decision: "REQUEST_INFO",
      workflowStatusAfter: String(result.workflow.status),
      outcome: result.outcome,
      source: input.source ?? null,
    },
    client,
  ).catch(() => null);
  return result;
}

// -----------------------------------------------------------------------------
// TEAM-SPEC R3 — the decision state the NEXT submission would meet.
// -----------------------------------------------------------------------------

export type CurrentRoundDecisionState = {
  state: ReviewDecisionState;
  round: number;
  secondReviewRequired: boolean;
  secondReviewReason: string | null;
  /** The forcing escalation, when one is the cause (T-015). */
  secondReviewEscalation?: {
    id: string;
    reason: string;
    severity: string;
    requestedByUserId?: string | null;
    requestedAtUtc?: string | null;
    note?: string | null;
  } | null;
  firstReviewerUserId: string | null;
  secondReviewerUserId: string | null;
  /** The previous round finished this way and the next submission opens a new round. */
  continuedFrom?: "request_info" | "unresolved_adjudication" | null;
};

/**
 * Read-only mirror of the round rule `recordReviewDecision` applies: a round a
 * request for information resolved, on a review that has since moved on, is
 * finished, and the next submission opens a fresh round (FIRST required). Used
 * by the viewer-action projection, the reassignment independence check and the
 * Close guard, so none of them can disagree with the authority.
 */
export async function loadCurrentRoundDecisionState(
  wf: { id: string; teamId: string; evidenceId: string; status: string; decisionRound: number },
  client: PrismaClient | Prisma.TransactionClient = defaultPrisma,
): Promise<CurrentRoundDecisionState> {
  const rows = await client.workflowReviewDecision.findMany({
    where: { workflowId: wf.id, teamId: wf.teamId, round: wf.decisionRound },
    orderBy: { decidedAt: "asc" },
    select: { stage: true, decision: true, reviewerUserId: true },
  });
  const live = await requiresSecondReview(
    { workflowId: wf.id, teamId: wf.teamId, evidenceId: wf.evidenceId },
    client,
  );
  let governing: SecondReviewRequirement = live;
  if (rows.length > 0) {
    const roundSecond = await secondReviewForRound(
      { workflowId: wf.id, teamId: wf.teamId, evidenceId: wf.evidenceId, round: wf.decisionRound },
      client,
    );
    const outcome = deriveDecisionProjection(rows, roundSecond.required);
    const stageNow = mapDbStatusToReviewStage(wf.status);
    const continued = roundContinuesInNewRound(rows, outcome, stageNow);
    if (continued !== null) {
      const fresh: SecondReviewRequirement =
        continued === "unresolved_adjudication"
          ? { required: true, reason: "unresolved_adjudication", escalation: null }
          : live;
      return {
        state: "first_required",
        round: wf.decisionRound + 1,
        secondReviewRequired: fresh.required,
        secondReviewReason: fresh.reason,
        secondReviewEscalation: fresh.escalation ?? null,
        firstReviewerUserId: null,
        secondReviewerUserId: null,
        continuedFrom: continued,
      };
    }
    // The round's own requirement ADDS to the live one: a FIRST decision
    // recorded under an escalation-caused requirement keeps it (never
    // "resolved" while the review is still in review, T-017).
    governing = live.required ? live : roundSecond.required ? roundSecond : live;
  }
  return {
    state: deriveReviewState({ decisions: rows, requiresSecond: governing.required }),
    round: wf.decisionRound,
    secondReviewRequired: governing.required,
    secondReviewReason: governing.reason,
    secondReviewEscalation: governing.escalation ?? null,
    firstReviewerUserId: rows.find((r) => r.stage === "FIRST")?.reviewerUserId ?? null,
    secondReviewerUserId: rows.find((r) => r.stage === "SECOND")?.reviewerUserId ?? null,
    continuedFrom: null,
  };
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
    | "continued_after_request_info"
    | "continued_after_unresolved_adjudication"
    | "closed_after_decisions"
    | "no_projectable_outcome"
    | "moved_during_repair"
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
  // CLOSE IS A PERSON'S ACT (audit 2026-10-23 #5). Close records no decision
  // row, so a closed review's round still projects its last verdict (or its
  // conflict); "repairing" it reopened a review someone had closed. Only
  // Reopen — a new round — moves a closed review.
  if (mapDbStatusToReviewStage(wf.status as string) === "CLOSED") {
    // ...and a closed review keeps no open escalation: one a failed Close
    // left behind is resolved here (third audit).
    await resolveOpenReviewEscalation(
      {
        workflow: wf,
        actorUserId: null,
        note: "Review closed; escalation resolved by the reconciler.",
        // Only what was raised before this read: a review reopened and
        // escalated meanwhile keeps its new escalation.
        raisedAtOrBefore: wf.updatedAt,
      },
      client,
    );
    return { workflowId, repaired: false, reason: "closed_after_decisions" };
  }
  const rows = await client.workflowReviewDecision.findMany({
    where: { workflowId, teamId: wf.teamId, round: wf.decisionRound },
    orderBy: { decidedAt: "asc" },
  });
  if (rows.length === 0) {
    return { workflowId, repaired: false, reason: "no_decisions" };
  }
  const latestDecidedAt = rows[rows.length - 1]!.decidedAt;
  if (wf.reopenedAtUtc && wf.reopenedAtUtc.getTime() > latestDecidedAt.getTime()) {
    return { workflowId, repaired: false, reason: "reopened_after_decisions" };
  }
  const secondReview = await secondReviewForRound(
    { workflowId, teamId: wf.teamId, evidenceId: wf.evidenceId, round: wf.decisionRound },
    client,
  );
  const projection = deriveDecisionProjection(rows, secondReview.required);
  // CONTINUED AFTER A REQUEST FOR INFORMATION (2026-10-23, audit F3). Such a
  // round resolves to NEEDS_MORE_INFO and stays current until the next
  // decision opens a new round; meanwhile the review legitimately moves on
  // (resumed, escalated, closed). That is not a diverged projection, and
  // "repairing" it back to NEEDS_INFO undid the reviewer's resume.
  if (
    projection.projectedStage === "NEEDS_MORE_INFO" &&
    mapDbStatusToReviewStage(wf.status as string) !== "NEEDS_MORE_INFO"
  ) {
    return { workflowId, repaired: false, reason: "continued_after_request_info" };
  }
  // T-018 — a round an adjudicator left UNRESOLVED continues in a new round;
  // a review that moved on meanwhile is not a diverged projection either.
  if (
    roundContinuesInNewRound(rows, projection, mapDbStatusToReviewStage(wf.status as string)) ===
      "unresolved_adjudication" &&
    mapDbStatusToReviewStage(wf.status as string) !== "ESCALATED"
  ) {
    return { workflowId, repaired: false, reason: "continued_after_unresolved_adjudication" };
  }
  if (projection.projectedStage === null) {
    return { workflowId, repaired: false, reason: "no_projectable_outcome" };
  }
  const currentStage = mapDbStatusToReviewStage(wf.status as string);
  if (currentStage === projection.projectedStage) {
    return { workflowId, repaired: false, reason: "consistent" };
  }
  const toStage = projection.projectedStage;
  const repaired = await client.$transaction(async (tx) => {
    const now = new Date();
    const data: Prisma.EvidenceReviewWorkflowUncheckedUpdateManyInput = {
      status: stageToDbStatus(toStage),
    };
    if (
      (toStage === "APPROVED_INTERNAL" || toStage === "REJECTED_INSUFFICIENT") &&
      !wf.completedAtUtc
    ) {
      data.completedAtUtc = now;
    }
    // A projected rejection carries the reason the deciding verdict gave, as
    // the decision write does (T-017 / T-014: never a rejection with no reason).
    if (toStage === "REJECTED_INSUFFICIENT" && !wf.rejectionReason) {
      const deciding = [...rows].reverse().find((r) => r.decision === "REJECT" || r.stage === "FIRST");
      data.rejectionReason = deciding?.rationale?.slice(0, 400) || null;
    }
    // WORKFLOW-019: conditional on the status this repair was computed from,
    // like every other writer. A move committed since the read wins, and this
    // repair stands down; the next sweep decides afresh.
    const moved = await tx.evidenceReviewWorkflow.updateMany({
      where: { id: wf.id, status: wf.status },
      data,
    });
    if (moved.count !== 1) return false;
    // A status change is a review event like any other: PROOVRA's own act, so
    // a null actor, on the same record as a person's move.
    await recordReviewActivityTx(tx, {
      evidenceId: wf.evidenceId,
      workflowId: wf.id,
      teamId: wf.teamId,
      actorUserId: null,
      code: "REVIEW_WORKFLOW_STATE_CHANGED",
      previousState: String(wf.status),
      resultingState: stageToDbStatus(toStage),
    });
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
    return true;
  });
  if (!repaired) {
    return { workflowId, repaired: false, reason: "moved_during_repair" };
  }
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
  // Resumes where the last pass stopped: the first N workflows repeated forever,
  // so workflow N+1 was never checked (WORKFLOW-012).
  const cursorKey = `reviewer_projection:${input.teamId ?? "all"}`;
  const cursor = await readSweepCursor(client, cursorKey);
  const rows = await client.workflowReviewDecision.findMany({
    where: {
      ...(input.teamId ? { teamId: input.teamId } : {}),
      ...(cursor ? { workflowId: { gt: cursor } } : {}),
    },
    select: { workflowId: true },
    distinct: ["workflowId"],
    orderBy: { workflowId: "asc" },
    take: batchSize,
  });
  await advanceSweepCursor(client, cursorKey, cursor, {
    lastId: rows.at(-1)?.workflowId ?? null,
    pageSize: rows.length,
    limit: batchSize,
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
  // A repair means a projection diverged from the immutable log, which should
  // not happen, so a non-zero count reaches an operator (WORKFLOW-019).
  if (repaired > 0) {
    bump("reviewer_decision_projection_repaired_total", repaired);
    safeEmitSecurityEvent({
      teamId: input.teamId ?? null,
      eventType: "reviewer_decision_projection_repaired",
      severity: "HIGH",
      details: { repaired, scanned: rows.length },
    });
  }
  return { scanned: rows.length, repaired, failures, results };
}
