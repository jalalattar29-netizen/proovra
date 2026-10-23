import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";

type Db = PrismaClient | Prisma.TransactionClient;

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

/**
 * Whether a decision round was SETTLED by a request for information, as it
 * was when that decision was recorded (audit 2026-10-23 #2). Read from the
 * DECISION_LOGGED event the decision wrote in its own transaction — its round
 * and the state it derived — never re-derived with TODAY'S second-review
 * requirement: an escalation, legal hold or redaction that arrives after the
 * request must not turn a settled request into the first of two reviews (and
 * then a "disagreement" with the next verdict).
 *
 * null: no decision event can be found for the round — callers derive it
 * live.
 */
export async function roundSettledByRequestInfo(
  input: { workflowId: string; round: number },
  client: Db = defaultPrisma,
): Promise<boolean | null> {
  const event = await client.evidenceReviewWorkflowEvent.findFirst({
    where: {
      workflowId: input.workflowId,
      eventType: "DECISION_LOGGED",
      nextValue: { path: ["round"], equals: input.round },
    },
    orderBy: { createdAt: "desc" },
    select: { nextValue: true },
  });
  if (event) return settledBy(event.nextValue);
  // A round decided before events recorded their round: its latest decision
  // and that decision's event were written in one transaction, so the first
  // DECISION_LOGGED event at or after the decision is its own (third audit).
  const latest = await client.workflowReviewDecision.findFirst({
    where: { workflowId: input.workflowId, round: input.round },
    orderBy: { decidedAt: "desc" },
    select: { decidedAt: true },
  });
  if (!latest) return null;
  const legacy = await client.evidenceReviewWorkflowEvent.findFirst({
    where: { workflowId: input.workflowId, eventType: "DECISION_LOGGED", createdAt: { gte: latest.decidedAt } },
    orderBy: { createdAt: "asc" },
    select: { nextValue: true },
  });
  return legacy ? settledBy(legacy.nextValue) : null;
}

function settledBy(nextValue: unknown): boolean {
  const v = (nextValue ?? {}) as { stage?: unknown; state?: unknown };
  return v.stage === "NEEDS_MORE_INFO" && v.state === "resolved";
}

/**
 * The second-review requirement that governs a round's EXISTING decisions:
 * none for a round a request for information settled; otherwise the live
 * requirement. The one rule the decision authority, the reconciler and the
 * Evidence page all read.
 */
export async function secondReviewForRound(
  input: { workflowId: string; teamId: string; evidenceId: string; round: number },
  client: Db = defaultPrisma,
): Promise<{ required: boolean; reason: string | null }> {
  if ((await roundSettledByRequestInfo(input, client)) === true) {
    return { required: false, reason: "round_settled_by_request_info" };
  }
  return requiresSecondReview(input, client);
}
