/**
 * PROOVRA Phase 2A — Reviewer Disagreement service.
 *
 * State machine for challenging another reviewer's decision:
 *
 *   FILED → UNDER_SECOND_REVIEW → UNDER_SUPERVISOR_REVIEW → RESOLVED_*
 *                              ↘ RESOLVED_*           ↗
 *                              ↘ WITHDRAWN
 *
 * Hard rules:
 *   * The challenger cannot be the original decision reviewer
 *     (DISAGREEMENT_SELF_FILE).
 *   * Every transition is checked against
 *     `isAllowedDisagreementTransition`.
 *   * Workspace-anchored reads + bounded denial reasons.
 */

import type { PrismaClient } from "@prisma/client";
import {
  DISAGREEMENT_STATES,
  isAllowedDisagreementTransition,
  REVIEWER_VERDICTS,
  type DisagreementState,
  type ReviewerDenialReason,
  type ReviewerVerdict,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { hiddenWorkflowIdsInWorkspace } from "../access/record-reach.js";
// Phase 4 — wire audit emission via the canonical tenant-audit facade.
// `.catch(() => {})` keeps emission best-effort so audit failure cannot
// roll back the primary disagreement mutation.
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import {
  AssigneeEligibilityError,
  assertWorkAssigneeEligible,
  type AssigneeIneligibility,
} from "../assignment/assignee-eligibility.js";
import { withinAssignmentWrite } from "../assignment/assignment-write.js";
import { mapDbStatusToReviewStage } from "@proovra/shared";
import { secondReviewForRound } from "../evidence-review/second-review.service.js";
import {
  precheckLifecycleTransition,
  recordLifecycleTransition,
} from "../review-operations/review-operations.service.js";

export type FileDisagreementInput = {
  prisma?: PrismaClient;
  teamId: string;
  workflowId: string;
  originalDecisionId: string;
  challengerUserId: string;
  rationale: string;
};

export async function fileDisagreement(
  input: FileDisagreementInput,
): Promise<
  | { ok: true; disagreementId: string }
  | { ok: false; denial: ReviewerDenialReason }
> {
  const prisma = input.prisma ?? defaultPrisma;
  if (!input.rationale || input.rationale.length === 0 || input.rationale.length > 600) {
    return deny("RATIONALE_REQUIRED");
  }
  const decision = await prisma.workflowReviewDecision.findFirst({
    where: {
      id: input.originalDecisionId,
      workflowId: input.workflowId,
      teamId: input.teamId,
    },
    select: { id: true, reviewerUserId: true },
  });
  if (!decision) return deny("DISAGREEMENT_NOT_FOUND");
  if (decision.reviewerUserId === input.challengerUserId) {
    return deny("DISAGREEMENT_SELF_FILE");
  }
  const created = await prisma.reviewerDisagreement.create({
    data: {
      teamId: input.teamId,
      workflowId: input.workflowId,
      originalDecisionId: input.originalDecisionId,
      state: "FILED",
      challengerUserId: input.challengerUserId,
      challengerRationale: input.rationale,
    },
    select: { id: true },
  });
  // Phase 4 — best-effort audit emission. Bounded metadata: IDs only.
  // Raw rationale text is intentionally NOT included (would leak
  // reviewer commentary into the platform audit chain).
  await emitTenantAudit({
    action: "reviewer.disagreement.filed",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.challengerUserId,
    workspaceId: input.teamId,
    resourceType: "reviewer_disagreement",
    resourceId: created.id,
    metadata: {
      workflowId: input.workflowId,
      disagreementId: created.id,
      originalDecisionId: input.originalDecisionId,
      challengerUserId: input.challengerUserId,
    },
  }).catch(() => {});
  return { ok: true, disagreementId: created.id };
}

export type TransitionDisagreementInput = {
  prisma?: PrismaClient;
  teamId: string;
  disagreementId: string;
  to: DisagreementState;
  actorUserId: string;
  /** Verdict required for any RESOLVED_* / second-review / supervisor transition. */
  verdict?: ReviewerVerdict;
  rationale?: string;
};

const DISAGREEMENT_RATIONALE_MAX = 600;
const DISAGREEMENT_RESOLUTION_MAX = 800;

function buildResolutionSummary(input: {
  verdict: ReviewerVerdict | null;
  rationale: string | null;
  actorStage: "SECOND_REVIEW" | "SUPERVISOR";
}): string | null {
  const payload = {
    verdict: input.verdict,
    rationale: input.rationale,
    actorStage: input.actorStage,
  };
  const summary = JSON.stringify(payload);
  return summary.length > 0
    ? summary.slice(0, DISAGREEMENT_RESOLUTION_MAX)
    : null;
}

export async function transitionDisagreement(
  input: TransitionDisagreementInput,
): Promise<
  | { ok: true; superseded?: "reopen" | "advance_round" | "already_superseded" | null }
  | {
      ok: false;
      denial: ReviewerDenialReason;
      /** Which assignee rule refused a second-review take (re-audit B10); the route may forward it. */
      code?: "REVIEW_ASSIGNEE_NOT_PLACED" | "REVIEW_ASSIGNEE_NOT_ELIGIBLE";
    }
> {
  const prisma = input.prisma ?? defaultPrisma;
  const row = await prisma.reviewerDisagreement.findFirst({
    where: { id: input.disagreementId, teamId: input.teamId },
    select: { id: true, state: true, challengerUserId: true, workflowId: true, originalDecisionId: true },
  });
  if (!row) return deny("DISAGREEMENT_NOT_FOUND");
  // PRO-R2-04 — independence, as second review and adjudication are
  // independent of the earlier deciders (review-decision.service): neither
  // the challenger nor the reviewer whose decision is challenged may take the
  // second / supervisor review or resolve the disagreement.
  if (
    input.to === "UNDER_SECOND_REVIEW" ||
    input.to === "UNDER_SUPERVISOR_REVIEW" ||
    input.to.startsWith("RESOLVED_")
  ) {
    if (input.actorUserId === row.challengerUserId) {
      return deny("DISAGREEMENT_RESOLVER_NOT_INDEPENDENT");
    }
    const original = row.originalDecisionId
      ? await prisma.workflowReviewDecision.findFirst({
          where: { id: row.originalDecisionId, teamId: input.teamId },
          select: { reviewerUserId: true },
        })
      : null;
    if (original && original.reviewerUserId === input.actorUserId) {
      return deny("DISAGREEMENT_RESOLVER_NOT_INDEPENDENT");
    }
  }
  if (
    !(DISAGREEMENT_STATES as ReadonlyArray<string>).includes(input.to) ||
    !isAllowedDisagreementTransition(row.state as DisagreementState, input.to)
  ) {
    return deny("DISAGREEMENT_STATE_INVALID");
  }
  const verdictRequired =
    input.to.startsWith("RESOLVED_") ||
    input.to === "UNDER_SECOND_REVIEW" ||
    input.to === "UNDER_SUPERVISOR_REVIEW";
  if (
    verdictRequired &&
    (!input.verdict ||
      !(REVIEWER_VERDICTS as ReadonlyArray<string>).includes(input.verdict))
  ) {
    if (input.to !== "UNDER_SECOND_REVIEW" && input.to !== "UNDER_SUPERVISOR_REVIEW") {
      return deny("VERDICT_REQUIRED");
    }
  }

  const now = new Date();
  const data: Record<string, unknown> = { state: input.to };
  const trimmedRationale =
    input.rationale && input.rationale.trim().length > 0
      ? input.rationale.trim().slice(0, DISAGREEMENT_RATIONALE_MAX)
      : null;

  if (input.to === "UNDER_SECOND_REVIEW") {
    data["secondReviewerUserId"] = input.actorUserId;
  } else if (input.to === "UNDER_SUPERVISOR_REVIEW") {
    data["supervisorUserId"] = input.actorUserId;
  } else if (input.to.startsWith("RESOLVED_")) {
    const actorStage = row.state.startsWith("UNDER_SUPERVISOR_REVIEW")
      ? "SUPERVISOR"
      : "SECOND_REVIEW";
    data["resolvedAtUtc"] = now;
    data["resolvedByUserId"] = input.actorUserId;
    data["resolution"] = buildResolutionSummary({
      verdict: input.verdict ?? null,
      rationale: trimmedRationale,
      actorStage,
    });
  } else if (input.to === "WITHDRAWN") {
    if (input.actorUserId !== row.challengerUserId) {
      return deny("NOT_PERMITTED");
    }
  }

  /*
   * TAKING THE SECOND REVIEW IS BEING GIVEN REVIEW WORK (members re-audit B10).
   *
   * The move to UNDER_SECOND_REVIEW makes the actor the second reviewer. It
   * wrote `secondReviewerUserId = actor` with no assignee rule, so an unplaced
   * reviewer (or one off the review's restricted case) could take second-review
   * work a queue claim would refuse. The actor now passes THE ONE assignee
   * authority — reviewer permission, reach to the disputed review's evidence,
   * placement — inside the write, the placement share-locked until it commits.
   * Taking the SUPERVISOR review (UNDER_SUPERVISOR_REVIEW) is the same act at
   * the next stage and passes the same authority.
   */
  /*
   * F-11 (review remediation 2026-11-27) — "overturned" (and "partially
   * overturned") is never a silent no-op: the challenged outcome is SUPERSEDED
   * through the canonical lifecycle, keeping every decision and the challenge
   * on the record.
   *   - finished review (approved / rejected / closed) → the canonical Reopen
   *     (a new round; the earlier decisions stay on the log);
   *   - open review whose current round holds the challenged decision → the
   *     round advances (any recorded independence requirement is carried);
   *   - the challenged decision is already from an earlier round → nothing to
   *     supersede (recorded as such).
   * Approval-dependent projections and gates follow from the derivation;
   * previously issued artifacts are untouched.
   */
  const supersedes = input.to === "RESOLVED_OVERTURNED" || input.to === "RESOLVED_PARTIAL";
  let supersedePlan: "reopen" | "advance_round" | "already_superseded" | null = null;
  let supersedeWorkflow: { id: string; evidenceId: string; status: string; decisionRound: number; teamId: string } | null = null;
  if (supersedes) {
    const wf = await prisma.evidenceReviewWorkflow.findFirst({
      where: { id: row.workflowId, teamId: input.teamId },
      select: { id: true, evidenceId: true, status: true, decisionRound: true },
    });
    const challenged = row.originalDecisionId
      ? await prisma.workflowReviewDecision.findFirst({ where: { id: row.originalDecisionId }, select: { round: true } })
      : null;
    if (!wf) return deny("DISAGREEMENT_NOT_FOUND");
    supersedeWorkflow = { ...wf, status: String(wf.status), teamId: input.teamId };
    const stage = mapDbStatusToReviewStage(String(wf.status));
    if (!challenged || challenged.round !== wf.decisionRound) supersedePlan = "already_superseded";
    else if (stage === "APPROVED_INTERNAL" || stage === "REJECTED_INSUFFICIENT" || stage === "CLOSED") {
      supersedePlan = "reopen";
      try {
        await precheckLifecycleTransition(
          { evidenceId: wf.evidenceId, decision: "REOPEN", note: "Challenge overturned" },
          prisma,
        );
      } catch {
        return deny("DISAGREEMENT_STATE_INVALID");
      }
    } else supersedePlan = "advance_round";
  }

  const refusal = await withinAssignmentWrite(prisma, async (tx): Promise<AssigneeIneligibility | "STATE_MOVED" | null> => {
    if (input.to === "UNDER_SECOND_REVIEW" || input.to === "UNDER_SUPERVISOR_REVIEW") {
      const workflow = await tx.evidenceReviewWorkflow.findFirst({
        where: { id: row.workflowId, teamId: input.teamId },
        select: { evidenceId: true },
      });
      try {
        if (!workflow) throw new AssigneeEligibilityError("NOT_ELIGIBLE");
        await assertWorkAssigneeEligible(
          {
            workspaceId: input.teamId,
            assigneeUserId: input.actorUserId,
            permission: "evidence_request.review",
            evidenceId: workflow.evidenceId,
          },
          tx,
          // Review work: the Review placement rule (2026-11-27), not the case one.
          { inTransaction: true, placementRule: "review" },
        );
      } catch (err) {
        if (err instanceof AssigneeEligibilityError) return err.reason;
        throw err;
      }
    }
    // PRO-R2-04 — compare-and-swap on the state just read: of two racing
    // transitions only one applies; the other is told the state moved on.
    const moved = await tx.reviewerDisagreement.updateMany({
      where: { id: row.id, teamId: input.teamId, state: row.state },
      data: data as never,
    });
    if (moved.count === 0) return "STATE_MOVED" as const;
    if (supersedePlan === "advance_round" && supersedeWorkflow) {
      const carried = await secondReviewForRound(
        {
          workflowId: supersedeWorkflow.id,
          teamId: input.teamId,
          evidenceId: supersedeWorkflow.evidenceId,
          round: supersedeWorkflow.decisionRound,
        },
        tx,
      );
      const bumped = await tx.evidenceReviewWorkflow.updateMany({
        where: { id: supersedeWorkflow.id, decisionRound: supersedeWorkflow.decisionRound },
        data: { decisionRound: supersedeWorkflow.decisionRound + 1 },
      });
      if (bumped.count !== 1) throw new Error("challenge_supersede_round_moved");
      await tx.evidenceReviewWorkflowEvent.create({
        data: {
          workflowId: supersedeWorkflow.id,
          evidenceId: supersedeWorkflow.evidenceId,
          actorUserId: input.actorUserId,
          eventType: "STAGE_CHANGED",
          previousValue: { round: supersedeWorkflow.decisionRound },
          nextValue: {
            round: supersedeWorkflow.decisionRound + 1,
            source: "challenge_overturned",
            disagreementId: row.id,
            supersededRound: supersedeWorkflow.decisionRound,
            supersededDecisionId: row.originalDecisionId,
            carriedSecondReviewCause: carried.required ? carried.reason ?? "recorded_requirement" : null,
          },
          note: trimmedRationale,
        },
      });
    }
    return null;
  });
  if (refusal === "STATE_MOVED") return deny("DISAGREEMENT_STATE_INVALID");
  if (refusal) {
    return {
      ok: false,
      denial: "NOT_PERMITTED",
      code: refusal === "NOT_PLACED" ? "REVIEW_ASSIGNEE_NOT_PLACED" : "REVIEW_ASSIGNEE_NOT_ELIGIBLE",
    };
  }
  // Phase 4 — best-effort audit emission for state transitions.
  // Bounded metadata: IDs, enum states, and (when present) the
  // bounded verdict enum. Raw rationale text is intentionally NOT
  // included.
  if (supersedePlan === "reopen" && supersedeWorkflow) {
    // The canonical Reopen door (event REOPENED, a new round, terminal markers
    // cleared). Run after the challenge is recorded as resolved; a refusal here
    // (the review moved meanwhile) leaves the resolution recorded and is audited.
    await recordLifecycleTransition(
      {
        evidenceId: supersedeWorkflow.evidenceId,
        decision: "REOPEN",
        actorUserId: input.actorUserId,
        note: `Challenge ${input.to === "RESOLVED_PARTIAL" ? "partially overturned" : "overturned"}: ${trimmedRationale ?? "the challenged outcome was superseded"}`.slice(0, 1000),
      },
      prisma,
    ).catch((err) => {
      supersedePlan = null;
      void emitTenantAudit({
        action: "reviewer.disagreement.supersede_failed",
        outcome: "error",
        sourceApp: "API",
        actorUserId: input.actorUserId,
        workspaceId: input.teamId,
        resourceType: "reviewer_disagreement",
        resourceId: row.id,
        metadata: { reason: String((err as Error)?.message ?? err).slice(0, 200) },
      }).catch(() => {});
    });
  }
  await emitTenantAudit({
    action: "reviewer.disagreement.transitioned",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId,
    workspaceId: input.teamId,
    resourceType: "reviewer_disagreement",
    resourceId: row.id,
    metadata: {
      disagreementId: row.id,
      fromState: row.state,
      toState: input.to,
      resolution: input.verdict ?? null,
      actorUserId: input.actorUserId,
      superseded: supersedePlan,
    },
  }).catch(() => {});
  return { ok: true, superseded: supersedePlan };
}

export async function listDisagreements(input: {
  prisma?: PrismaClient;
  teamId: string;
  forUserId?: string;
  state?: DisagreementState;
  limit?: number;
  /** The reader. A disagreement over a closed record is not listed (WORKFLOW-003). */
  viewerUserId: string;
}) {
  const prisma = input.prisma ?? defaultPrisma;
  const closed = await hiddenWorkflowIdsInWorkspace(input.teamId, input.viewerUserId, prisma);
  const rows = await prisma.reviewerDisagreement.findMany({
    where: {
      teamId: input.teamId,
      ...(closed.length > 0 ? { workflowId: { notIn: closed } } : {}),
      ...(input.state ? { state: input.state } : {}),
      ...(input.forUserId
        ? {
            OR: [
              { challengerUserId: input.forUserId },
              { secondReviewerUserId: input.forUserId },
              { supervisorUserId: input.forUserId },
            ],
          }
        : {}),
    },
    orderBy: { filedAtUtc: "desc" },
    take: Math.min(input.limit ?? 50, 200),
  });
  // §4 — the reader's independence on each row, by the SAME rule
  // transitionDisagreement enforces (neither the challenger nor the reviewer
  // whose decision is challenged reviews or resolves it), so the page offers
  // only what the server accepts.
  const decisionIds = [...new Set(rows.map((r) => r.originalDecisionId).filter((v): v is string => !!v))];
  const deciders = new Map(
    decisionIds.length === 0
      ? []
      : (
          await prisma.workflowReviewDecision.findMany({
            where: { id: { in: decisionIds }, teamId: input.teamId },
            select: { id: true, reviewerUserId: true },
          })
        ).map((d) => [d.id, d.reviewerUserId]),
  );
  return rows.map((r) => {
    const decidedBy = r.originalDecisionId ? deciders.get(r.originalDecisionId) ?? null : null;
    const viewerIndependent = input.viewerUserId !== r.challengerUserId && input.viewerUserId !== decidedBy;
    return {
      ...r,
      viewerIndependent,
      viewerNotIndependentReason: viewerIndependent
        ? null
        : input.viewerUserId === r.challengerUserId
          ? ("filed_challenge" as const)
          : ("made_challenged_decision" as const),
    };
  });
}

function deny<T extends ReviewerDenialReason>(reason: T): { ok: false; denial: T } {
  return { ok: false, denial: reason };
}
