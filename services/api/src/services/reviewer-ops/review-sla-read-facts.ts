/**
 * Stage C follow-up — read-time SLA facts, so every reader is correct for rows
 * the repair job (`ops:repair-review-sla-truth`) has NOT touched.
 *
 * Two facts are derived at read time, batched (one query each per page, no
 * N+1), and never written back:
 *
 *   1. `firstDecidedAtUtc` is null on a review that already has a decision
 *      (decided before the column existed, or while the rollback image ran):
 *      it is the earliest `WorkflowReviewDecision.decidedAt` of the review.
 *   2. A deadline the open-review sweep stamped AFTER the fact it measures
 *      (assignment deadline on a review assigned before the stamp; first-review
 *      deadline on a review first decided before the stamp) is not a deadline
 *      the review ever had: it is presented as absent (the dimension is
 *      omitted), never as "Met". The stamp is identified by its own
 *      SLA_UPDATED event (`nextValue.source = "open_review_sweep"`); a deadline
 *      before that stamp's time was set by an earlier, honest stamp and kept.
 *
 * The rule in (2) is the repair job's rule (`deadlineStampedAfterFact`), so a
 * repaired row and an un-repaired row read the same.
 *
 * Not derivable: a sweep-stamped row whose SLA_UPDATED event is missing (the
 * sweep writes the event right after the row; a failure between the two would
 * leave none). Such a deadline is presented as stored: "Met · <the real
 * completion date>" when the fact came first — the date shown is always the
 * fact's, never the deadline's.
 */

import type { PrismaClient } from "@prisma/client";

/** True when a deadline was stamped at `stampedAt` after the fact it measures. */
export function deadlineStampedAfterFact(
  dueAt: Date | null | undefined,
  factAt: Date | null | undefined,
  stampedAt: Date | null | undefined,
): boolean {
  return Boolean(dueAt && factAt && stampedAt && factAt < stampedAt && dueAt >= stampedAt);
}

type FactRow = {
  id: string;
  firstDecidedAtUtc?: Date | null;
  assignedAtUtc?: Date | null;
  assignmentDueAtUtc?: Date | null;
  firstResponseDueAtUtc?: Date | null;
};

/** Earliest decision per workflow, for the rows whose column is still null. */
export async function loadFirstDecisionTimes(
  ids: ReadonlyArray<string>,
  client: PrismaClient,
): Promise<Map<string, Date>> {
  if (ids.length === 0) return new Map();
  const rows = await client.workflowReviewDecision.groupBy({
    by: ["workflowId"],
    where: { workflowId: { in: [...ids] } },
    _min: { decidedAt: true },
  });
  const out = new Map<string, Date>();
  for (const r of rows) if (r._min.decidedAt) out.set(r.workflowId, r._min.decidedAt);
  return out;
}

/** First open-review-sweep stamp time per workflow. */
export async function loadSweepStampTimes(
  ids: ReadonlyArray<string>,
  client: PrismaClient,
): Promise<Map<string, Date>> {
  if (ids.length === 0) return new Map();
  const events = await client.evidenceReviewWorkflowEvent.findMany({
    where: {
      workflowId: { in: [...ids] },
      eventType: "SLA_UPDATED",
      nextValue: { path: ["source"], equals: "open_review_sweep" },
    },
    select: { workflowId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  const out = new Map<string, Date>();
  for (const e of events) if (!out.has(e.workflowId)) out.set(e.workflowId, e.createdAt);
  return out;
}

/**
 * Copies of `rows` carrying the read-time facts. For PRESENTATION only: never
 * pass the result to a write. `stampedAfter: false` fills the first decision
 * only (what the stamp guard needs; nulling a deadline there would re-stamp it).
 */
export async function withReadTimeSlaFacts<T extends FactRow>(
  rows: ReadonlyArray<T>,
  client: PrismaClient,
  opts: { stampedAfter?: boolean } = {},
): Promise<T[]> {
  if (rows.length === 0) return [];
  const firsts = await loadFirstDecisionTimes(
    rows.filter((r) => !r.firstDecidedAtUtc).map((r) => r.id),
    client,
  );
  const withFirst = rows.map((r) =>
    !r.firstDecidedAtUtc && firsts.has(r.id) ? { ...r, firstDecidedAtUtc: firsts.get(r.id)! } : r,
  );
  if (opts.stampedAfter === false) return withFirst;
  const candidates = withFirst.filter(
    (r) => (r.assignmentDueAtUtc && r.assignedAtUtc) || (r.firstResponseDueAtUtc && r.firstDecidedAtUtc),
  );
  const stamps = await loadSweepStampTimes(
    candidates.map((r) => r.id),
    client,
  );
  if (stamps.size === 0) return withFirst;
  return withFirst.map((r) => {
    const stampedAt = stamps.get(r.id);
    if (!stampedAt) return r;
    const patch: Partial<FactRow> = {};
    if (deadlineStampedAfterFact(r.assignmentDueAtUtc, r.assignedAtUtc, stampedAt)) patch.assignmentDueAtUtc = null;
    if (deadlineStampedAfterFact(r.firstResponseDueAtUtc, r.firstDecidedAtUtc, stampedAt)) {
      patch.firstResponseDueAtUtc = null;
    }
    return Object.keys(patch).length > 0 ? { ...r, ...patch } : r;
  });
}
