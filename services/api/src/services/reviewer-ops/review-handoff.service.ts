/**
 * TEAM-SPEC R3 (2026-11-23) — the second-review / adjudication HANDOFF.
 *
 * After a FIRST decision under a second-review requirement, the review waits
 * for an assignment manager to reassign it to a different eligible reviewer;
 * after a conflict, it waits for an independent OWNER/ADMIN to adjudicate.
 * This module answers, read-only, who could complete that step:
 *
 *   - second review: ACTIVE members other than the first reviewer who pass
 *     THE assignee authority the reassignment itself applies
 *     (`assertReviewAssigneeEligible`: decision permission + reach to the
 *     record + Collaboration Team placement where the plan requires it);
 *   - adjudication: ACTIVE OWNER/ADMIN members who decided neither stage and
 *     pass the decision authority's own checks (decision permission on the
 *     review + reach to the record).
 *
 * With nobody eligible the review stays pending with a staffing explanation —
 * the required number of reviews is never reduced (TEAM-SPEC R3).
 */

import type { EvidenceReviewWorkflow as DbWorkflow, PrismaClient } from "@prisma/client";
import { DECISION_TERMINAL_STAGES } from "@proovra/shared";
import {
  deriveDecisionProjection,
  deriveReviewState,
  mapDbStatusToReviewStage,
  type ReviewDecisionState,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { maskEmail } from "@proovra/shared";
import { evaluateMemberAccessWithSnapshot } from "../identity/access-policy.service.js";
import { resolveEvidenceRecordAccess } from "../evidence/evidence-record-access.service.js";
import { assertReviewAssigneeEligible, ReviewOperationError } from "../review-operations/review-operations.service.js";
import { secondReviewRequiredForRounds } from "../evidence-review/review-outcome.service.js";
import { loadCurrentRoundDecisionState, type CurrentRoundDecisionState } from "./review-decision.service.js";

/** The handoff queue slices `GET /v1/reviewer-ops/queue` accepts besides the shared catalog. */
export const REVIEWER_OPS_HANDOFF_QUEUE_TYPES = ["AWAITING_SECOND_REVIEW", "AWAITING_ADJUDICATION"] as const;
export type ReviewerOpsHandoffQueueType = (typeof REVIEWER_OPS_HANDOFF_QUEUE_TYPES)[number];

export type ReviewHandoffRequirement = "second_review" | "adjudication" | null;
export type ReviewHandoffStaffing = "ok" | "no_eligible_reviewer" | "no_eligible_adjudicator";

export type ReviewHandoff = {
  requirement: ReviewHandoffRequirement;
  firstReviewerUserId: string | null;
  /** Readable name of the first reviewer, when the account has one. */
  firstReviewerDisplayName: string | null;
  /**
   * Team remediation T-086 / E2E-08 — the first reviewer's e-mail, MASKED
   * (shared `maskEmail`), so the banner names them the way the lineage and the
   * picker do when there is no display name; never an id reference.
   */
  firstReviewerMaskedEmail: string | null;
  secondReviewerUserId: string | null;
  /**
   * Second review: true while nobody other than the first reviewer holds the
   * review (an assignment manager still has to reassign it). Adjudication:
   * true until an adjudicator records the outcome.
   */
  awaitingAssignment: boolean;
  /**
   * Second review: members who could be assigned the SECOND review.
   * Adjudication: OWNER/ADMIN members who could adjudicate. 0 when nothing is
   * required.
   */
  eligibleReviewerCount: number;
  staffing: ReviewHandoffStaffing;
};

/** Which handoff (if any) the current round's decision state is waiting on. */
export function handoffRequirementFor(state: CurrentRoundDecisionState["state"]): ReviewHandoffRequirement {
  if (state === "second_required") return "second_review";
  if (state === "conflict_detected" || state === "adjudication_required") return "adjudication";
  return null;
}

/** Bounded pool, like the assignable-reviewers picker. */
const MEMBER_POOL = 200;

async function activeMemberIds(teamId: string, exclude: ReadonlyArray<string>, client: PrismaClient): Promise<string[]> {
  const rows = await client.teamMember.findMany({
    where: { teamId, status: "ACTIVE", userId: { notIn: [...exclude] } },
    select: { userId: true },
    orderBy: { userId: "asc" },
    take: MEMBER_POOL,
  });
  return rows.map((r) => r.userId);
}

/** Members (other than the first reviewer) the SECOND review could be reassigned to. */
export async function countEligibleSecondReviewers(
  workflow: Pick<DbWorkflow, "teamId" | "evidenceId">,
  firstReviewerUserId: string | null,
  client: PrismaClient = defaultPrisma,
): Promise<number> {
  if (!workflow.teamId) return 0;
  const candidates = await activeMemberIds(workflow.teamId, firstReviewerUserId ? [firstReviewerUserId] : [], client);
  let count = 0;
  for (const userId of candidates) {
    try {
      await assertReviewAssigneeEligible(workflow, userId, client);
      count += 1;
    } catch (err) {
      if (!(err instanceof ReviewOperationError)) throw err;
    }
  }
  return count;
}

/** OWNER/ADMIN members who decided neither stage and could adjudicate this review. */
export async function countEligibleAdjudicators(
  workflow: Pick<DbWorkflow, "id" | "teamId" | "evidenceId">,
  participantUserIds: ReadonlyArray<string>,
  client: PrismaClient = defaultPrisma,
): Promise<number> {
  if (!workflow.teamId) return 0;
  const candidates = await activeMemberIds(workflow.teamId, participantUserIds, client);
  let count = 0;
  for (const userId of candidates) {
    const { decision, snapshot } = await evaluateMemberAccessWithSnapshot(
      {
        teamId: workflow.teamId,
        userId,
        permission: "evidence_request.review",
        resourceKind: "review_workflow",
        resourceId: workflow.id,
      },
      client,
    );
    if (!decision.allowed) continue;
    if (snapshot?.role !== "OWNER" && snapshot?.role !== "ADMIN") continue;
    const reach = await resolveEvidenceRecordAccess(
      { userId, evidenceId: workflow.evidenceId, permission: "evidence.read" },
      client,
    );
    if (reach.allowed) count += 1;
  }
  return count;
}

/** The workspace projection's `handoff` block, from the current round's decision state. */
export async function computeReviewHandoff(
  row: Pick<DbWorkflow, "id" | "teamId" | "evidenceId" | "assignedToUserId">,
  decision: CurrentRoundDecisionState,
  client: PrismaClient = defaultPrisma,
): Promise<ReviewHandoff> {
  const requirement = handoffRequirementFor(decision.state);
  const base = {
    requirement,
    firstReviewerUserId: decision.firstReviewerUserId,
    firstReviewerDisplayName: null as string | null,
    firstReviewerMaskedEmail: null as string | null,
    secondReviewerUserId: decision.secondReviewerUserId,
  };
  if (requirement === null) {
    return { ...base, awaitingAssignment: false, eligibleReviewerCount: 0, staffing: "ok" };
  }
  if (decision.firstReviewerUserId) {
    const user = await client.user
      .findUnique({ where: { id: decision.firstReviewerUserId }, select: { displayName: true, email: true } })
      .catch(() => null);
    base.firstReviewerDisplayName = user?.displayName?.trim() || null;
    base.firstReviewerMaskedEmail = maskEmail(user?.email ?? null);
  }
  if (requirement === "second_review") {
    const eligible = await countEligibleSecondReviewers(row, decision.firstReviewerUserId, client);
    return {
      ...base,
      awaitingAssignment: !row.assignedToUserId || row.assignedToUserId === decision.firstReviewerUserId,
      eligibleReviewerCount: eligible,
      staffing: eligible > 0 ? "ok" : "no_eligible_reviewer",
    };
  }
  const participants = [decision.firstReviewerUserId, decision.secondReviewerUserId].filter(
    (v): v is string => typeof v === "string",
  );
  const eligible = await countEligibleAdjudicators(row, participants, client);
  return {
    ...base,
    awaitingAssignment: true,
    eligibleReviewerCount: eligible,
    staffing: eligible > 0 ? "ok" : "no_eligible_adjudicator",
  };
}

// -----------------------------------------------------------------------------
// Batched current-round classification (queues, counts).
// -----------------------------------------------------------------------------

export type HandoffWorkflowRef = {
  id: string;
  teamId: string | null;
  evidenceId: string;
  status: string;
  decisionRound: number;
};

// One terminal set: the authority's (@proovra/shared).

/**
 * `loadCurrentRoundDecisionState(wf).state` for MANY workflows in a constant
 * number of statements: one query for the current-round decision rows, one for
 * their DECISION_LOGGED events, and the round's second-review requirement from
 * `secondReviewRequiredForRounds` (the batched `secondReviewForRound`).
 *
 * Same rules as the per-row reader, rule for rule:
 *   - no rows in the round → first_required;
 *   - a round a request for information resolved, on a review that has since
 *     moved on (not terminal, not NEEDS_MORE_INFO) → a new round, first_required;
 *   - otherwise `deriveReviewState` under the LIVE requirement. The batched
 *     requirement is the round's, which equals the live one except for a round
 *     settled by a request for information; that rare case (a FIRST-only
 *     round holding a REQUEST_INFO, the review still waiting for information)
 *     falls back to the per-row reader, so the answer is exactly its answer.
 * Proven equal on seeded data in test/team-review-handoff.integration.test.ts.
 */
export async function classifyCurrentRounds(
  workflows: ReadonlyArray<HandoffWorkflowRef>,
  client: PrismaClient = defaultPrisma,
): Promise<Map<string, ReviewDecisionState>> {
  const out = new Map<string, ReviewDecisionState>();
  const scoped = workflows.filter((w): w is HandoffWorkflowRef & { teamId: string } => !!w.teamId);
  if (scoped.length === 0) return out;
  const roundOf = new Map(scoped.map((w) => [w.id, w.decisionRound]));
  const rows = await client.workflowReviewDecision.findMany({
    where: { workflowId: { in: [...roundOf.keys()] }, round: { in: [...new Set(roundOf.values())] } },
    orderBy: { decidedAt: "asc" },
    select: { workflowId: true, round: true, stage: true, decision: true, reviewerUserId: true },
  });
  const byWf = new Map<string, Array<{ stage: string; decision: string; reviewerUserId: string }>>();
  for (const r of rows) {
    if (r.round !== roundOf.get(r.workflowId)) continue;
    const list = byWf.get(r.workflowId) ?? [];
    list.push({ stage: String(r.stage), decision: String(r.decision), reviewerUserId: r.reviewerUserId });
    byWf.set(r.workflowId, list);
  }
  const decided = scoped.filter((w) => (byWf.get(w.id)?.length ?? 0) > 0);
  for (const w of scoped) if (!byWf.has(w.id)) out.set(w.id, "first_required");
  if (decided.length === 0) return out;

  const events = await client.evidenceReviewWorkflowEvent.findMany({
    where: { workflowId: { in: decided.map((w) => w.id) }, eventType: "DECISION_LOGGED" },
    orderBy: { createdAt: "desc" },
    select: { workflowId: true, nextValue: true },
  });
  const roundRequired = await secondReviewRequiredForRounds(decided, events, client);
  const fallback: HandoffWorkflowRef[] = [];
  for (const w of decided) {
    const list = byWf.get(w.id)!;
    const required = roundRequired.get(w.id) === true;
    const outcome = deriveDecisionProjection(list, required);
    const stageNow = mapDbStatusToReviewStage(w.status);
    if (
      outcome.state === "resolved" &&
      outcome.projectedStage === "NEEDS_MORE_INFO" &&
      !DECISION_TERMINAL_STAGES.has(stageNow) &&
      stageNow !== "NEEDS_MORE_INFO"
    ) {
      out.set(w.id, "first_required");
      continue;
    }
    const firstOnly = list.some((d) => d.stage === "FIRST") && !list.some((d) => d.stage !== "FIRST");
    if (!required && firstOnly && list.some((d) => d.decision === "REQUEST_INFO")) {
      // Possibly settled by a request for information: the live requirement
      // may differ from the round's. Ask the per-row reader.
      fallback.push(w);
      continue;
    }
    out.set(w.id, deriveReviewState({ decisions: list, requiresSecond: required }));
  }
  for (const w of fallback) {
    out.set(
      w.id,
      (
        await loadCurrentRoundDecisionState(
          { id: w.id, teamId: w.teamId!, evidenceId: w.evidenceId, status: w.status, decisionRound: w.decisionRound },
          client,
        )
      ).state,
    );
  }
  return out;
}
