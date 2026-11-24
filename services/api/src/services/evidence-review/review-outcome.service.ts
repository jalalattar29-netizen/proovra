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
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  SECOND_REVIEW_REEVALUATION_SOURCE,
  decisionEventPinsSecondReview,
  deriveDecisionProjection,
  escalationForcesIndependentReview,
  legacyReviewDecisionFromStatus,
  reviewDecisionFromProjection,
  type ReviewDecision,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";

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
 * requirement only for workflows whose round has rows, is not already
 * resolved, and whose verdict actually depends on it — read for all of them
 * in one batch (`secondReviewRequiredForRounds`); history only for legacy
 * workflows whose status lost the verdict.
 *
 * PERF (2026-11-23, team-review perf pass): the requirement used to be read
 * per workflow (`secondReviewForRound`, 5–7 statements each), which made the
 * reviewer-performance analytics issue ~3,500 statements (2.6 s) for a 90-day
 * window on a 5,000-review workspace; and the current-round rows were asked
 * for with one OR branch per workflow (a 2,000-branch BitmapOr, ~90 ms). Same
 * results — proven against the per-workflow derivation in
 * test/team-review-perf-decision-batch.integration.test.ts.
 */
export async function loadCurrentReviewDecisions(
  workflows: ReadonlyArray<ReviewWorkflowRef>,
  client: Db = defaultPrisma,
): Promise<Map<string, ReviewDecision>> {
  const out = new Map<string, ReviewDecision>();
  if (workflows.length === 0) return out;
  const roundOf = new Map(workflows.map((w) => [w.id, w.decisionRound]));

  // Only each workflow's CURRENT round (bounded by the batch). Asked as one
  // `workflow_id = ANY(...)` (plus the rounds in play) and narrowed to each
  // workflow's own round below — never one OR branch per workflow.
  const rows = (await client.workflowReviewDecision.findMany({
    where: {
      workflowId: { in: [...roundOf.keys()] },
      round: { in: [...new Set(roundOf.values())] },
    },
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
  const requirementNeeded: Array<ReviewWorkflowRef & { teamId: string }> = [];
  for (const wf of workflows) {
    const current = roundRows.get(wf.id);
    if (current && current.length > 0 && wf.teamId) {
      const reached = resolvedInRound.get(wf.id);
      if (reached !== undefined) {
        out.set(wf.id, reached);
        continue;
      }
      // The requirement only matters when it changes the verdict (a round
      // with a FIRST decision only); with a second decision or an
      // adjudication on the log the projection ignores it.
      const ifRequired = reviewDecisionFromProjection(deriveDecisionProjection(current as never, true));
      const ifNot = reviewDecisionFromProjection(deriveDecisionProjection(current as never, false));
      if (ifRequired === ifNot) {
        out.set(wf.id, ifRequired);
        continue;
      }
      requirementNeeded.push({ ...wf, teamId: wf.teamId });
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

  if (requirementNeeded.length > 0) {
    const required = await secondReviewRequiredForRounds(requirementNeeded, events, client);
    for (const wf of requirementNeeded) {
      out.set(
        wf.id,
        reviewDecisionFromProjection(deriveDecisionProjection(roundRows.get(wf.id) as never, required.get(wf.id) === true)),
      );
    }
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

/**
 * `secondReviewForRound(...).required` for MANY rounds, in a constant number
 * of statements. The SAME rule as second-review.service.ts — keep the two in
 * step (the equivalence test compares them on seeded data):
 *
 *   1. A round SETTLED by a request for information needs no second review
 *      (`roundSettledByRequestInfo`): the latest DECISION_LOGGED event
 *      recording this round decides; failing one, the first DECISION_LOGGED
 *      event at or after the round's latest decision (pre-round events).
 *   2. Otherwise the live requirement (`requiresSecondReview`): the workflow
 *      is ESCALATED, it has an open escalation in its team, its evidence has
 *      an ACTIVE legal hold in its team, or a redaction-required visibility
 *      decision.
 *
 * `events` are the batch's DECISION_LOGGED events, newest first, already
 * loaded by the caller for exactly these workflows.
 */
export async function secondReviewRequiredForRounds(
  rounds: ReadonlyArray<{ id: string; teamId: string; evidenceId: string; decisionRound: number }>,
  events: ReadonlyArray<{ workflowId: string; nextValue: unknown }>,
  client: Db,
): Promise<Map<string, boolean>> {
  const required = new Map<string, boolean>();
  const byWorkflow = new Map<string, Array<{ nextValue: unknown }>>();
  for (const e of events) {
    const list = byWorkflow.get(e.workflowId) ?? [];
    list.push(e);
    byWorkflow.set(e.workflowId, list);
  }

  const live: typeof rounds[number][] = [];
  const preRound: typeof rounds[number][] = [];
  for (const wf of rounds) {
    // The latest event recording THIS round (events are newest first, in the
    // database's own order).
    const inRound = (byWorkflow.get(wf.id) ?? []).find(
      (e) => (e.nextValue as { round?: unknown } | null)?.round === wf.decisionRound,
    );
    if (!inRound) preRound.push(wf);
    else if (settledByRequestInfo(inRound.nextValue)) required.set(wf.id, false);
    else live.push(wf);
  }
  if (preRound.length > 0) {
    // Pre-round events: the first DECISION_LOGGED event at or after the
    // round's latest decision — compared IN THE DATABASE, at its microsecond
    // precision (a decision and its own event share a transaction timestamp,
    // which a millisecond JS Date cannot order).
    const firstAfter = await client.$queryRaw<Array<{ workflow_id: string; next_value: unknown }>>(Prisma.sql`
      SELECT d.workflow_id::text AS workflow_id, e.next_value
      FROM (
        SELECT DISTINCT ON (w.workflow_id) w.workflow_id, w.decided_at
        FROM "workflow_review_decisions" w
        JOIN unnest(${preRound.map((w) => w.id)}::uuid[], ${preRound.map((w) => w.decisionRound)}::int[]) AS r(id, round)
          ON w.workflow_id = r.id AND w.round = r.round
        ORDER BY w.workflow_id, w.decided_at DESC
      ) d
      JOIN LATERAL (
        SELECT ev.next_value
        FROM "evidence_review_workflow_events" ev
        WHERE ev.workflow_id = d.workflow_id
          AND ev.event_type = 'DECISION_LOGGED'
          AND ev.created_at >= d.decided_at
        ORDER BY ev.created_at ASC
        LIMIT 1
      ) e ON TRUE
    `);
    const settledById = new Map(firstAfter.map((r) => [r.workflow_id, settledByRequestInfo(r.next_value)]));
    for (const wf of preRound) {
      if (settledById.get(wf.id) === true) required.set(wf.id, false);
      else live.push(wf);
    }
  }
  if (live.length === 0) return required;

  const ids = live.map((w) => w.id);
  const evidenceIds = [...new Set(live.map((w) => w.evidenceId))];
  const [statuses, openEsc, holds, redactions] = await Promise.all([
    client.evidenceReviewWorkflow.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } }),
    client.reviewEscalation.findMany({
      where: { workflowId: { in: ids }, status: { in: ["OPEN", "ACKNOWLEDGED", "REASSIGNED"] } },
      select: { workflowId: true, teamId: true, reason: true, createdByUserId: true },
    }),
    client.evidenceLegalHold.findMany({
      where: { evidenceId: { in: evidenceIds }, status: "ACTIVE" },
      select: { evidenceId: true, teamId: true },
    }),
    client.evidenceWorkflowVisibilityDecision.findMany({
      where: { evidenceId: { in: evidenceIds }, requiresRedaction: true },
      select: { evidenceId: true },
      distinct: ["evidenceId"],
    }),
  ]);
  const escalated = new Set(statuses.filter((w) => w.status === "ESCALATED").map((w) => w.id));
  // T-013 — only escalations that FORCE independent review count.
  const escByWf = new Set(
    openEsc.filter((e) => escalationForcesIndependentReview(e)).map((e) => `${e.workflowId}|${e.teamId}`),
  );
  const holdByEv = new Set(holds.map((h) => `${h.evidenceId}|${h.teamId}`));
  const redacted = new Set(redactions.map((r) => r.evidenceId));
  // A round pinned by its FIRST decision (second-review.service.ts
  // `roundPinnedToSecondReview`) keeps its requirement; an explicit
  // re-evaluation marker (T-014) lifts the pin.
  const pinCandidates = live.filter((wf) =>
    (byWorkflow.get(wf.id) ?? []).some(
      (e) =>
        (e.nextValue as { round?: unknown } | null)?.round === wf.decisionRound && decisionEventPinsSecondReview(e.nextValue),
    ),
  );
  const markers =
    pinCandidates.length === 0
      ? []
      : await client.evidenceReviewWorkflowEvent.findMany({
          where: {
            workflowId: { in: pinCandidates.map((w) => w.id) },
            eventType: "STAGE_CHANGED",
            nextValue: { path: ["source"], equals: SECOND_REVIEW_REEVALUATION_SOURCE },
          },
          select: { workflowId: true, nextValue: true },
        });
  const pinned = new Set(
    pinCandidates
      .filter(
        (wf) =>
          !markers.some(
            (m) => m.workflowId === wf.id && (m.nextValue as { round?: unknown } | null)?.round === wf.decisionRound,
          ),
      )
      .map((wf) => wf.id),
  );
  for (const wf of live) {
    required.set(
      wf.id,
      escalated.has(wf.id) ||
        escByWf.has(`${wf.id}|${wf.teamId}`) ||
        holdByEv.has(`${wf.evidenceId}|${wf.teamId}`) ||
        redacted.has(wf.evidenceId) ||
        pinned.has(wf.id),
    );
  }
  return required;
}

/** Same reading as second-review.service.ts `settledBy`. */
function settledByRequestInfo(nextValue: unknown): boolean {
  const v = (nextValue ?? {}) as { stage?: unknown; state?: unknown };
  return v.stage === "NEEDS_MORE_INFO" && v.state === "resolved";
}
