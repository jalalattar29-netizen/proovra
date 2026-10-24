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
 * SOURCE. The decision authority logs each submission as a DECISION_LOGGED
 * workflow event carrying its round and the projection it resolved to, in the
 * same transaction as the decision row. A round decided before events carried
 * their round falls back to the round's decision rows (the same derivation the
 * authority uses), and a workflow decided before the decision log existed to
 * its verdict status — never to CLOSED.
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

function decisionFromLoggedEvent(nextValue: unknown): ReviewDecision {
  const v = (nextValue ?? {}) as { state?: unknown; stage?: unknown };
  return reviewDecisionFromProjection({ state: String(v.state ?? ""), projectedStage: typeof v.stage === "string" ? v.stage : null });
}

async function legacyDecision(wf: ReviewWorkflowRef, client: Db): Promise<ReviewDecision> {
  if (!wf.teamId) return legacyReviewDecisionFromStatus(wf.status);
  const rows = await client.workflowReviewDecision.findMany({
    where: { workflowId: wf.id, round: wf.decisionRound },
    orderBy: { decidedAt: "asc" },
    select: { stage: true, decision: true, reviewerUserId: true },
  });
  if (rows.length === 0) return wf.decisionRound === 0 ? legacyReviewDecisionFromStatus(wf.status) : "NO_DECISION";
  const second = await secondReviewForRound(
    { workflowId: wf.id, teamId: wf.teamId, evidenceId: wf.evidenceId, round: wf.decisionRound },
    client,
  );
  return reviewDecisionFromProjection(deriveDecisionProjection(rows, second.required));
}

/** The current round's decision for ONE workflow. */
export async function loadCurrentReviewDecision(wf: ReviewWorkflowRef, client: Db = defaultPrisma): Promise<ReviewDecision> {
  return (await loadCurrentReviewDecisions([wf], client)).get(wf.id) ?? "NO_DECISION";
}

/**
 * The current round's decision for MANY workflows (queues, counts): one
 * bounded event query, the legacy fallback only for workflows whose current
 * round has no round-tagged decision event.
 */
export async function loadCurrentReviewDecisions(
  workflows: ReadonlyArray<ReviewWorkflowRef>,
  client: Db = defaultPrisma,
): Promise<Map<string, ReviewDecision>> {
  const out = new Map<string, ReviewDecision>();
  if (workflows.length === 0) return out;
  const events = await client.evidenceReviewWorkflowEvent.findMany({
    where: { workflowId: { in: workflows.map((w) => w.id) }, eventType: "DECISION_LOGGED" },
    orderBy: { createdAt: "desc" },
    select: { workflowId: true, nextValue: true },
  });
  const latestForRound = new Map<string, unknown>();
  const roundOf = new Map(workflows.map((w) => [w.id, w.decisionRound]));
  for (const e of events) {
    if (latestForRound.has(e.workflowId)) continue;
    const round = (e.nextValue as { round?: unknown } | null)?.round;
    if (typeof round === "number" && round === roundOf.get(e.workflowId)) latestForRound.set(e.workflowId, e.nextValue);
  }
  for (const wf of workflows) {
    const logged = latestForRound.get(wf.id);
    out.set(wf.id, logged !== undefined ? decisionFromLoggedEvent(logged) : await legacyDecision(wf, client));
  }
  return out;
}
