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

import type { Prisma, PrismaClient } from "@prisma/client";
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
import { recordLifecycleTransitionTx } from "../review-operations/review-operations.service.js";

/** What resolving a challenge OVERTURNED / PARTIAL did to the challenged outcome. */
export type SupersedePlan = "reopen" | "advance_round" | "already_superseded";

/**
 * The superseding write failed inside the resolution's transaction: the whole
 * transaction (resolution included) is rolled back and the caller answers
 * DISAGREEMENT_SUPERSEDE_FAILED.
 */
class ChallengeSupersedeError extends Error {
  constructor(readonly failure: unknown) {
    super("challenge_supersede_failed");
    this.name = "ChallengeSupersedeError";
  }
}

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
  | { ok: true; superseded?: SupersedePlan | null }
  | {
      ok: false;
      /**
       * DISAGREEMENT_SUPERSEDE_FAILED (finding B) — an OVERTURNED / PARTIAL
       * resolution whose superseding write failed: nothing was recorded.
       */
      denial: ReviewerDenialReason | "DISAGREEMENT_SUPERSEDE_FAILED";
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
  /*
   * Finding B (review remediation 2026-11-27) — the resolution and the
   * superseding are ONE transaction. Decided under the workflow row lock
   * (taken first, as every Close / Reopen takes it), from the state read
   * under it: the challenged decision must still be in the review's CURRENT
   * round. A stale challenge resolves as "already superseded" and changes no
   * workflow; a supersede that fails rolls the resolution back with it.
   */
  const supersedes = input.to === "RESOLVED_OVERTURNED" || input.to === "RESOLVED_PARTIAL";
  let supersedePlan: SupersedePlan | null = null;
  let supersedeAfterCommit: (() => Promise<void>) | undefined;
  const supersedeNote = `Challenge ${input.to === "RESOLVED_PARTIAL" ? "partially overturned" : "overturned"}: ${trimmedRationale ?? "the challenged outcome was superseded"}`.slice(0, 1000);

  let refusal: AssigneeIneligibility | "STATE_MOVED" | "WORKFLOW_GONE" | null;
  try {
  refusal = await withinAssignmentWrite(prisma, async (tx): Promise<AssigneeIneligibility | "STATE_MOVED" | "WORKFLOW_GONE" | null> => {
    let lockedWorkflow: { id: string; evidenceId: string; status: string; decisionRound: number } | null = null;
    if (supersedes) {
      await tx.$queryRaw`SELECT "id" FROM "evidence_review_workflows" WHERE "id" = ${row.workflowId}::uuid FOR UPDATE`;
      const wf = await tx.evidenceReviewWorkflow.findFirst({
        where: { id: row.workflowId, teamId: input.teamId },
        select: { id: true, evidenceId: true, status: true, decisionRound: true },
      });
      if (!wf) return "WORKFLOW_GONE";
      lockedWorkflow = { ...wf, status: String(wf.status) };
    }
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
    if (supersedes && lockedWorkflow) {
      const wf = lockedWorkflow;
      // Revalidated under the lock: the challenged decision is in the CURRENT round.
      const challenged = row.originalDecisionId
        ? await tx.workflowReviewDecision.findFirst({
            where: { id: row.originalDecisionId, workflowId: wf.id, teamId: input.teamId },
            select: { round: true },
          })
        : null;
      const stage = mapDbStatusToReviewStage(wf.status);
      supersedePlan =
        !challenged || challenged.round !== wf.decisionRound
          ? "already_superseded"
          : stage === "APPROVED_INTERNAL" || stage === "REJECTED_INSUFFICIENT" || stage === "CLOSED"
            ? "reopen"
            : "advance_round";
      try {
        if (supersedePlan === "reopen") {
          // The canonical Reopen (event REOPENED referencing the challenge, a
          // new round, terminal markers cleared, its audit entry) in THIS
          // transaction; its after-commit work runs only once this commits.
          const done = await recordLifecycleTransitionTx(
            tx as unknown as Prisma.TransactionClient,
            {
              evidenceId: wf.evidenceId,
              decision: "REOPEN",
              actorUserId: input.actorUserId,
              note: supersedeNote,
              eventContext: {
                source: "challenge_overturned",
                disagreementId: row.id,
                resolution: input.to,
                supersededRound: wf.decisionRound,
                supersededDecisionId: row.originalDecisionId,
              },
            },
            prisma,
          );
          supersedeAfterCommit = done.afterCommit;
        } else if (supersedePlan === "advance_round") {
          const carried = await secondReviewForRound(
            {
              workflowId: wf.id,
              teamId: input.teamId,
              evidenceId: wf.evidenceId,
              round: wf.decisionRound,
            },
            tx,
          );
          const bumped = await tx.evidenceReviewWorkflow.updateMany({
            where: { id: wf.id, decisionRound: wf.decisionRound },
            data: { decisionRound: wf.decisionRound + 1 },
          });
          if (bumped.count !== 1) throw new Error("challenge_supersede_round_moved");
          await tx.evidenceReviewWorkflowEvent.create({
            data: {
              workflowId: wf.id,
              evidenceId: wf.evidenceId,
              actorUserId: input.actorUserId,
              eventType: "STAGE_CHANGED",
              previousValue: { round: wf.decisionRound },
              nextValue: {
                round: wf.decisionRound + 1,
                source: "challenge_overturned",
                disagreementId: row.id,
                resolution: input.to,
                supersededRound: wf.decisionRound,
                supersededDecisionId: row.originalDecisionId,
                carriedSecondReviewCause: carried.required ? carried.reason ?? "recorded_requirement" : null,
              },
              note: trimmedRationale,
            },
          });
        }
        // The resolution's audit entry commits WITH the resolution and says
        // what it did to the review (or that nothing was left to supersede).
        await emitTenantAudit(
          {
            action: "reviewer.disagreement.transitioned",
            outcome: "success",
            sourceApp: "API",
            actorUserId: input.actorUserId,
            workspaceId: input.teamId,
            resourceType: "reviewer_disagreement",
            resourceId: row.id,
            metadata: {
              disagreementId: row.id,
              workflowId: wf.id,
              fromState: row.state,
              toState: input.to,
              resolution: input.verdict ?? null,
              actorUserId: input.actorUserId,
              superseded: supersedePlan,
              originalDecisionId: row.originalDecisionId,
              challengedDecisionRound: challenged?.round ?? null,
              workflowRoundBefore: wf.decisionRound,
              workflowRoundAfter: supersedePlan === "already_superseded" ? wf.decisionRound : wf.decisionRound + 1,
            },
          },
          tx,
        );
      } catch (err) {
        throw new ChallengeSupersedeError(err);
      }
    }
    return null;
  });
  } catch (err) {
    if (!(err instanceof ChallengeSupersedeError)) throw err;
    // Rolled back whole: the challenge keeps its prior state, the review is
    // untouched. Audited after the rollback, best-effort.
    await emitTenantAudit({
      action: "reviewer.disagreement.supersede_failed",
      outcome: "error",
      sourceApp: "API",
      actorUserId: input.actorUserId,
      workspaceId: input.teamId,
      resourceType: "reviewer_disagreement",
      resourceId: row.id,
      metadata: {
        disagreementId: row.id,
        fromState: row.state,
        toState: input.to,
        plannedSupersede: supersedePlan,
        reason: String((err.failure as Error)?.message ?? err.failure).slice(0, 200),
      },
    }).catch(() => {});
    return { ok: false, denial: "DISAGREEMENT_SUPERSEDE_FAILED" };
  }
  if (refusal === "STATE_MOVED") return deny("DISAGREEMENT_STATE_INVALID");
  if (refusal === "WORKFLOW_GONE") return deny("DISAGREEMENT_NOT_FOUND");
  if (refusal) {
    return {
      ok: false,
      denial: "NOT_PERMITTED",
      code: refusal === "NOT_PLACED" ? "REVIEW_ASSIGNEE_NOT_PLACED" : "REVIEW_ASSIGNEE_NOT_ELIGIBLE",
    };
  }
  if (supersedes) {
    // Committed: the Reopen's after-commit work (escalations the finished
    // review left behind), best-effort. The audit entry is already committed.
    await supersedeAfterCommit?.().catch(() => null);
    return { ok: true, superseded: supersedePlan };
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
