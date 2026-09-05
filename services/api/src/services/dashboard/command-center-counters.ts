/**
 * ONE REQUEST, ONE SET OF COUNTERS.
 *
 * THE AMPLIFICATION THIS REMOVES
 * ---------------------------------------------------------------------------
 * Measured from PostgreSQL's own statement log, one
 * `GET /v1/dashboard/command-center` on an organization workspace issued 181
 * statements, 82 of them `SELECT COUNT(*)`. The single largest repeated shape
 * was `evidence_review_workflows`: THIRTEEN counts, from five engines that
 * never knew about each other, several of them asking the identical question.
 * `{ teamId, status: "QUEUED" }` alone was counted four times in one request.
 *
 * Independent engines are the right decomposition for the PRODUCT — each owns
 * a section of the page and can fail alone — and the wrong one for the
 * DATABASE, because a round trip is paid per engine rather than per fact.
 *
 * WHAT THIS IS
 * ---------------------------------------------------------------------------
 * A request-scoped snapshot of the review-queue counters, loaded ONCE before
 * the engines run and read from memory afterwards. Two queries answer all
 * thirteen:
 *
 *   1. one `GROUP BY status` — every count whose only predicate is a status;
 *   2. one conditional aggregate — the four counters that also carry a time
 *      window, which a status grouping cannot express.
 *
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 * Not a cache: it lives for one request and is never consulted by a second.
 * Not a god query: it answers ONE domain — the review queue — and an engine
 * asking about evidence, cases or incidents still asks for itself. Not an
 * approximation: every counter is an exact count over the same predicate the
 * engine used, and `command-center-counter-equivalence.integration.test.ts`
 * proves that against a live database by running both forms and comparing.
 *
 * THE CLOCK IS THE REQUEST'S
 * ---------------------------------------------------------------------------
 * "Overdue" was previously evaluated against a `new Date()` taken inside each
 * engine, so two sections of one page could disagree about the present by the
 * milliseconds between them. One clock per request is both cheaper and more
 * defensible: a page cannot show two different nows.
 */

import { prisma } from "../../db.js";

/** The statuses the product treats as "open work in the queue". */
export const OPEN_REVIEW_STATUSES = [
  "QUEUED",
  "ASSIGNED",
  "IN_REVIEW",
  "NEEDS_INFO",
] as const;

export type ReviewWorkflowStatus =
  | "NOT_STARTED"
  | "QUEUED"
  | "ASSIGNED"
  | "IN_REVIEW"
  | "NEEDS_INFO"
  | "CLOSED"
  | (string & {});

export type ReviewQueueCounters = {
  /** The request's single clock. Every window below was evaluated against it. */
  now: Date;
  /** Exact count of workflows in ANY of the given statuses. */
  inStatus: (statuses: readonly ReviewWorkflowStatus[]) => number;
  /** Open work whose due date has passed. */
  overdue: number;
  /** Open work due within the request's "due soon" horizon. */
  dueSoon: number;
  /** CLOSED and touched in the last 7 days. */
  closedLast7d: number;
  /** CLOSED and touched in the 7 days before those. */
  closedPrev7d: number;
  /** Open review escalations — counted here because two engines asked for it. */
  openEscalations: number;
};

export type ReviewQueueWindow = {
  now: Date;
  dueSoonCutoff: Date;
  last7dStart: Date;
  prev7dStart: Date;
};

/**
 * Build the window this request measures against.
 *
 * Exported so the engines and the equivalence test derive the boundaries the
 * same way rather than each computing "seven days ago" for itself.
 */
export function reviewQueueWindow(now = new Date()): ReviewQueueWindow {
  const DAY = 24 * 60 * 60 * 1000;
  return {
    now,
    // 24 hours — the horizon the reviewer-orchestration engine has always used.
    dueSoonCutoff: new Date(now.getTime() + DAY),
    last7dStart: new Date(now.getTime() - 7 * DAY),
    prev7dStart: new Date(now.getTime() - 14 * DAY),
  };
}

type WindowedRow = {
  overdue: bigint | number;
  due_soon: bigint | number;
  closed_last_7d: bigint | number;
  closed_prev_7d: bigint | number;
};

const toNumber = (v: bigint | number | null | undefined): number =>
  typeof v === "bigint" ? Number(v) : (v ?? 0);

export async function loadReviewQueueCounters(
  teamId: string,
  window: ReviewQueueWindow,
): Promise<ReviewQueueCounters> {
  const openList = [...OPEN_REVIEW_STATUSES];

  const [byStatus, windowed, openEscalations] = await Promise.all([
    // 1. Every status-only counter, in one trip.
    prisma.evidenceReviewWorkflow.groupBy({
      by: ["status"],
      where: { teamId },
      _count: { _all: true },
    }),
    /*
     * 2. The windowed counters, in one trip.
     *
     * Conditional aggregation rather than four counts: the predicates differ
     * only in their time bounds, so they scan the same rows. Written as raw
     * SQL because `COUNT(*) FILTER (WHERE …)` has no Prisma expression — and
     * the equivalence test exists precisely because raw SQL can drift from
     * the Prisma predicate it replaced.
     *
     * `status::text` keeps the comparison off the enum's OID so this cannot
     * break when a value is added to `EvidenceReviewWorkflowStatus`.
     */
    prisma.$queryRaw<WindowedRow[]>`
      SELECT
        COUNT(*) FILTER (
          WHERE "status"::text = ANY(${openList}::text[]) AND "due_at" < ${window.now}
        ) AS overdue,
        COUNT(*) FILTER (
          WHERE "status"::text = ANY(${openList}::text[])
            AND "due_at" >= ${window.now}
            AND "due_at" < ${window.dueSoonCutoff}
        ) AS due_soon,
        COUNT(*) FILTER (
          WHERE "status"::text = 'CLOSED' AND "updated_at" >= ${window.last7dStart}
        ) AS closed_last_7d,
        COUNT(*) FILTER (
          WHERE "status"::text = 'CLOSED'
            AND "updated_at" >= ${window.prev7dStart}
            AND "updated_at" < ${window.last7dStart}
        ) AS closed_prev_7d
      FROM "public"."evidence_review_workflows"
      WHERE "team_id" = ${teamId}::uuid
    `,
    // Counted once for the two engines that both reported it.
    prisma.reviewEscalation.count({ where: { teamId, status: "OPEN" } }),
  ]);

  const counts = new Map<string, number>();
  for (const row of byStatus) {
    counts.set(String(row.status), row._count._all);
  }
  const w = windowed[0];

  return {
    now: window.now,
    inStatus: (statuses) =>
      statuses.reduce((total, s) => total + (counts.get(String(s)) ?? 0), 0),
    overdue: toNumber(w?.overdue),
    dueSoon: toNumber(w?.due_soon),
    closedLast7d: toNumber(w?.closed_last_7d),
    closedPrev7d: toNumber(w?.closed_prev_7d),
    openEscalations,
  };
}

// ===========================================================================
// EVIDENCE COUNTERS
// ===========================================================================

/**
 * The evidence facts MORE THAN ONE ENGINE ASKS FOR.
 *
 * Measured on the same request: twenty-two `COUNT(*)` statements against
 * `evidence`, but only fifteen DISTINCT predicates. Seven were the same
 * question asked again by an engine that could not know another had already
 * asked it — "SIGNED with no report" three times and "REPORTED with no
 * verification package" twice among them.
 *
 * WHY THIS IS PRISMA AND NOT ONE CONDITIONAL AGGREGATE. The review-queue
 * counters above collapse into raw SQL because their predicate is a status and
 * a timestamp on one table. These cannot: every one is scoped by
 * `pop.evidence`, the CANONICAL evidence population from
 * `@proovra/shared-runtime` — the fragment that decides which rows belong to a
 * workspace, personal NULL-team rows included. Re-expressing that in
 * hand-written SQL would create a SECOND population authority, and a second
 * authority that disagrees with the first is precisely the defect class this
 * codebase keeps removing. Removing duplication is worth having; a private
 * copy of the tenancy rule is not.
 *
 * So this removes the DUPLICATION and leaves the distinct questions distinct.
 */
export type EvidenceCounters = {
  /** SIGNED with no report — the report backlog. Asked by three engines. */
  signedWithoutReport: number;
  /** REPORTED with no verification package. Asked by two. */
  reportedWithoutPackage: number;
};

export type EvidencePopulationFragment = Record<string, unknown>;

export async function loadEvidenceCounters(
  population: EvidencePopulationFragment,
): Promise<EvidenceCounters> {
  const [signedWithoutReport, reportedWithoutPackage] = await Promise.all([
    prisma.evidence.count({
      where: { AND: [population], status: "SIGNED", reports: { none: {} } } as never,
    }),
    prisma.evidence.count({
      where: {
        AND: [population],
        status: "REPORTED",
        verificationPackages: { none: {} },
      } as never,
    }),
  ]);
  return { signedWithoutReport, reportedWithoutPackage };
}
