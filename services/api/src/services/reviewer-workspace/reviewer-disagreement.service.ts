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
  | { ok: true }
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
    select: { id: true, state: true, challengerUserId: true, workflowId: true },
  });
  if (!row) return deny("DISAGREEMENT_NOT_FOUND");
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
  const refusal = await withinAssignmentWrite(prisma, async (tx): Promise<AssigneeIneligibility | null> => {
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
          { inTransaction: true },
        );
      } catch (err) {
        if (err instanceof AssigneeEligibilityError) return err.reason;
        throw err;
      }
    }
    await tx.reviewerDisagreement.update({
      where: { id: row.id },
      data: data as never,
    });
    return null;
  });
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
    },
  }).catch(() => {});
  return { ok: true };
}

export async function listDisagreements(input: {
  prisma?: PrismaClient;
  teamId: string;
  forUserId?: string;
  state?: DisagreementState;
  limit?: number;
}) {
  const prisma = input.prisma ?? defaultPrisma;
  return prisma.reviewerDisagreement.findMany({
    where: {
      teamId: input.teamId,
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
}

function deny<T extends ReviewerDenialReason>(reason: T): { ok: false; denial: T } {
  return { ok: false, denial: reason };
}
