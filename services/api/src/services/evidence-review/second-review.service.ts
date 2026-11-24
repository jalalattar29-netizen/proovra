import type { Prisma, PrismaClient } from "@prisma/client";
import {
  SECOND_REVIEW_REEVALUATION_SOURCE,
  decisionEventPinsSecondReview,
  escalationForcesIndependentReview,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";

type Db = PrismaClient | Prisma.TransactionClient;

export type SecondReviewRequirement = {
  required: boolean;
  reason: string | null;
  /** The forcing escalation (highest severity, then newest), when one forces the requirement. */
  escalation?: { id: string; reason: string; severity: string } | null;
};

const SEVERITY_RANK: Record<string, number> = { CRITICAL: 4, HIGH: 3, WARNING: 2, INFO: 1 };

/**
 * Derive whether a workflow currently requires a second review.
 * Triggers (computed live — no stored column):
 *   - workflow.status === ESCALATED
 *   - an active escalation that FORCES independent review
 *     (`escalationForcesIndependentReview`, T-013: an escalation the automatic
 *     overdue / SLA / stuck sweep raised on its own does not)
 *   - an ACTIVE legal hold on the underlying evidence
 *   - at least one redaction-required visibility decision
 */
export async function requiresSecondReview(
  input: { workflowId: string; teamId: string; evidenceId: string },
  client: Db = defaultPrisma,
): Promise<SecondReviewRequirement> {
  const [wf, activeEsc, holdCount, redactionCount] = await Promise.all([
    client.evidenceReviewWorkflow.findUnique({
      where: { id: input.workflowId },
      select: { status: true },
    }),
    client.reviewEscalation.findMany({
      where: {
        teamId: input.teamId,
        workflowId: input.workflowId,
        status: { in: ["OPEN", "ACKNOWLEDGED", "REASSIGNED"] },
      },
      select: { id: true, reason: true, severity: true, createdByUserId: true, createdAt: true },
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
  const forcing = activeEsc
    .filter((e) => escalationForcesIndependentReview(e))
    .sort(
      (a, b) =>
        (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) ||
        b.createdAt.getTime() - a.createdAt.getTime(),
    )[0];
  const escalation = forcing ? { id: forcing.id, reason: forcing.reason, severity: forcing.severity } : null;
  if (wf?.status === "ESCALATED") return { required: true, reason: "workflow_escalated", escalation };
  if (forcing) return { required: true, reason: "open_escalation", escalation };
  if (holdCount > 0) return { required: true, reason: "active_legal_hold" };
  if (redactionCount > 0) return { required: true, reason: "redaction_required" };
  return { required: false, reason: null };
}

/**
 * Whether a round's FIRST decision was recorded under a requirement that stays
 * with the round (`decisionEventPinsSecondReview`) and no explicit
 * re-evaluation (T-014) has lifted it since. Resolving the escalation that
 * caused the requirement never finalises the first verdict (binding
 * direction 4): the round still waits for its independent SECOND reviewer.
 * Returns the recorded cause, or null.
 */
export async function roundPinnedToSecondReview(
  input: { workflowId: string; round: number },
  client: Db = defaultPrisma,
): Promise<string | null> {
  const events = await client.evidenceReviewWorkflowEvent.findMany({
    where: {
      workflowId: input.workflowId,
      eventType: { in: ["DECISION_LOGGED", "STAGE_CHANGED"] },
      nextValue: { path: ["round"], equals: input.round },
    },
    select: { eventType: true, nextValue: true },
  });
  return pinnedCauseFromRoundEvents(events);
}

/** The same rule over events already loaded for ONE round (batched readers). */
export function pinnedCauseFromRoundEvents(
  events: ReadonlyArray<{ eventType?: string | null; nextValue: unknown }>,
): string | null {
  let cause: string | null = null;
  for (const e of events) {
    const v = (e.nextValue ?? {}) as { source?: unknown; secondReviewCause?: unknown };
    if (v.source === SECOND_REVIEW_REEVALUATION_SOURCE) return null;
    if ((e.eventType ?? "DECISION_LOGGED") === "DECISION_LOGGED" && decisionEventPinsSecondReview(e.nextValue)) {
      cause = typeof v.secondReviewCause === "string" ? v.secondReviewCause : "recorded_requirement";
    }
  }
  return cause;
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
 * none for a round a request for information settled; the recorded
 * requirement for a round pinned by its FIRST decision
 * (`roundPinnedToSecondReview`); otherwise the live requirement. The one rule
 * the decision authority, the reconciler and the Evidence page all read.
 */
export async function secondReviewForRound(
  input: { workflowId: string; teamId: string; evidenceId: string; round: number },
  client: Db = defaultPrisma,
): Promise<SecondReviewRequirement> {
  if ((await roundSettledByRequestInfo(input, client)) === true) {
    return { required: false, reason: "round_settled_by_request_info" };
  }
  const live = await requiresSecondReview(input, client);
  if (live.required) return live;
  const pinned = await roundPinnedToSecondReview(input, client);
  if (pinned) return { required: true, reason: pinned, escalation: null };
  return live;
}
