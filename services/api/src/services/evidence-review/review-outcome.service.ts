/**
 * THE CURRENT-ROUND DECISION, read from what the decision authority recorded
 * (2026-10-24) — independent of the workflow state.
 *
 * Close used to overwrite the stored status with CLOSED, after which the only
 * place the verdict survived was the decision log — and every reader that
 * looked at the status alone lost it (the Evidence page then read "Closed" as
 * "Not accepted"). Readers now ask this for the decision and the status for
 * the workflow state, and show both.
 *
 * ONE DERIVATION. The decision is the round's decision rows under the LIVE
 * second-review requirement for that round — `deriveDecisionProjection` with
 * `secondReviewForRound`, exactly what the decision authority, the reconciler
 * and the Evidence page's available actions derive. Reading the state logged
 * at decision time instead disagreed with them once the requirement changed:
 * a first approval logged as "second review required" stayed "No decision"
 * here after the legal hold was released, while the authority already
 * refused a second verdict as resolved and the reconciler projected Approved.
 *
 * A REACHED VERDICT STANDS. A round whose decision event recorded it as
 * resolved keeps that verdict even if a requirement arrives afterwards (a
 * legal hold placed on an approved record): the authority refuses any further
 * verdict for it, so un-deciding it here would leave it undecidable.
 *
 * LEGACY. A workflow decided before the decision log existed (round 0, no
 * decision rows) has its verdict in its stored status — or, once Close
 * overwrote that status, in the verdict its own history recorded right
 * before it was closed. Never CLOSED itself: a verdict followed by a Reopen
 * or by any other move (back into review, for instance) no longer stands.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  deriveDecisionProjection,
  legacyReviewDecisionFromStatus,
  reviewDecisionFromProjection,
  type ReviewDecision,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { secondReviewForRound } from "./second-review.service.js";

type Db = PrismaClient | Prisma.TransactionClient;

export type ReviewWorkflowRef = {
  id: string;
  teamId: string | null;
  evidenceId: string;
  status: string;
  decisionRound: number;
};

type DecisionRow = { workflowId: string; round: number; stage: string; decision: string; reviewerUserId: string };

function loggedAsResolved(nextValue: unknown): ReviewDecision | null {
  const v = (nextValue ?? {}) as { state?: unknown; stage?: unknown };
  if (v.state !== "resolved") return null;
  return reviewDecisionFromProjection({ state: "resolved", projectedStage: typeof v.stage === "string" ? v.stage : null });
}

/** What a legacy workflow-history value moved TO, if it names a status/stage. */
function movedTo(value: unknown): string | null {
  const v = (value ?? {}) as { status?: unknown; stage?: unknown };
  const to = typeof v.status === "string" ? v.status : typeof v.stage === "string" ? v.stage : null;
  return to ? to.toUpperCase() : null;
}

/**
 * The verdict a closed legacy workflow's history recorded before it was
 * closed (history is ordered newest first). Moves into Closed are passed
 * over; the first other move decides: a verdict stands, anything else —
 * a Reopen, a move back into review — means the verdict no longer did.
 * Events that move nothing (assignment, priority, notes) are skipped.
 */
function legacyVerdictFromHistory(
  history: ReadonlyArray<{ eventType: string; nextValue: unknown }>,
): ReviewDecision {
  for (const e of history) {
    if (e.eventType === "REOPENED") return "NO_DECISION";
    const byType = legacyReviewDecisionFromStatus(e.eventType);
    if (byType !== "NO_DECISION") return byType;
    const to = movedTo(e.nextValue);
    if (to === null || e.eventType === "CLOSED" || to === "CLOSED") continue;
    if (e.eventType === "ASSIGNED" || e.eventType === "REASSIGNED" || e.eventType === "CLAIMED" || e.eventType === "UNASSIGNED") continue;
    return legacyReviewDecisionFromStatus(to);
  }
  return "NO_DECISION";
}

/** The current round's decision for ONE workflow. */
export async function loadCurrentReviewDecision(wf: ReviewWorkflowRef, client: Db = defaultPrisma): Promise<ReviewDecision> {
  return (await loadCurrentReviewDecisions([wf], client)).get(wf.id) ?? "NO_DECISION";
}

/**
 * The current round's decision for MANY workflows (queues, counts): one
 * decision-row query and one decision-event query for the batch; the live
 * requirement only for workflows whose round has rows and is not already
 * resolved; history only for legacy workflows whose status lost the verdict.
 */
export async function loadCurrentReviewDecisions(
  workflows: ReadonlyArray<ReviewWorkflowRef>,
  client: Db = defaultPrisma,
): Promise<Map<string, ReviewDecision>> {
  const out = new Map<string, ReviewDecision>();
  if (workflows.length === 0) return out;
  const roundOf = new Map(workflows.map((w) => [w.id, w.decisionRound]));

  // Only each workflow's CURRENT round (bounded by the batch).
  const rows = (await client.workflowReviewDecision.findMany({
    where: { OR: workflows.map((w) => ({ workflowId: w.id, round: w.decisionRound })) },
    orderBy: { decidedAt: "asc" },
    select: { workflowId: true, round: true, stage: true, decision: true, reviewerUserId: true },
  })) as unknown as DecisionRow[];
  const roundRows = new Map<string, DecisionRow[]>();
  for (const r of rows) {
    if (r.round !== roundOf.get(r.workflowId)) continue;
    const list = roundRows.get(r.workflowId) ?? [];
    list.push(r);
    roundRows.set(r.workflowId, list);
  }

  const events = await client.evidenceReviewWorkflowEvent.findMany({
    where: { workflowId: { in: [...roundRows.keys()] }, eventType: "DECISION_LOGGED" },
    orderBy: { createdAt: "desc" },
    select: { workflowId: true, nextValue: true },
  });
  const resolvedInRound = new Map<string, ReviewDecision>();
  for (const e of events) {
    if (resolvedInRound.has(e.workflowId)) continue;
    const round = (e.nextValue as { round?: unknown } | null)?.round;
    if (round !== roundOf.get(e.workflowId)) continue;
    const verdict = loggedAsResolved(e.nextValue);
    if (verdict !== null) resolvedInRound.set(e.workflowId, verdict);
  }

  const legacyHistoryNeeded: ReviewWorkflowRef[] = [];
  for (const wf of workflows) {
    const current = roundRows.get(wf.id);
    if (current && current.length > 0 && wf.teamId) {
      const reached = resolvedInRound.get(wf.id);
      if (reached !== undefined) {
        out.set(wf.id, reached);
        continue;
      }
      const second = await secondReviewForRound(
        { workflowId: wf.id, teamId: wf.teamId, evidenceId: wf.evidenceId, round: wf.decisionRound },
        client,
      );
      out.set(wf.id, reviewDecisionFromProjection(deriveDecisionProjection(current as never, second.required)));
      continue;
    }
    if (wf.decisionRound !== 0) {
      out.set(wf.id, "NO_DECISION");
      continue;
    }
    const fromStatus = legacyReviewDecisionFromStatus(wf.status);
    if (fromStatus !== "NO_DECISION") {
      out.set(wf.id, fromStatus);
      continue;
    }
    // Only Close overwrites a verdict status with one that carries none (a
    // verdict stage moves only to Closed or Reopened, and Reopen opens round
    // 1). Every other round-0 workflow without rows was never decided.
    if (String(wf.status).toUpperCase() === "CLOSED") legacyHistoryNeeded.push(wf);
    else out.set(wf.id, "NO_DECISION");
  }

  if (legacyHistoryNeeded.length > 0) {
    const history = await client.evidenceReviewWorkflowEvent.findMany({
      where: { workflowId: { in: legacyHistoryNeeded.map((w) => w.id) } },
      orderBy: { createdAt: "desc" },
      select: { workflowId: true, eventType: true, nextValue: true },
    });
    const byWorkflow = new Map<string, Array<{ eventType: string; nextValue: unknown }>>();
    for (const h of history) {
      const list = byWorkflow.get(h.workflowId) ?? [];
      list.push({ eventType: String(h.eventType), nextValue: h.nextValue });
      byWorkflow.set(h.workflowId, list);
    }
    for (const wf of legacyHistoryNeeded) {
      out.set(wf.id, legacyVerdictFromHistory(byWorkflow.get(wf.id) ?? []));
    }
  }
  return out;
}
