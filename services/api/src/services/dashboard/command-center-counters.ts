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

/*
 * The two status sets are the governance vocabulary's, not this module's.
 * They lived here while the defect was being fixed on the dashboard; three
 * other surfaces had the same hole, so they now live beside
 * `DESTRUCTION_REVIEW_STATUSES` and every reader imports the same pair.
 */
export {
  DESTRUCTION_REVIEW_AWAITING_DECISION,
  DESTRUCTION_REVIEW_PROPOSED,
} from "@proovra/shared";

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
  /**
   * Evidence created inside a window, against ONE clock.
   *
   * Three windows, six statements: "created in the last 24h" was asked twice
   * and "the last 7 days" twice, by engines that could not know about each
   * other. Worse than the duplication, each took its own `new Date()`, so
   * Operational Intelligence and Queue Telemetry could report the same window
   * over boundaries milliseconds apart and disagree about the present.
   *
   * The window keys are fixed rather than arbitrary because a caller that can
   * ask for any cutoff can re-introduce exactly that skew.
   */
  createdSince: Readonly<Record<EvidenceWindow, number>>;
  /**
   * Evidence whose verification package metadata is marked blocked.
   *
   * Governance Posture and Audit Readiness each ran the SAME 500-row scan for
   * this and reported it under two labels. One scan now answers both, which
   * also means the two sections can no longer disagree about it.
   */
  blockedExports: number;
};

/** The windows the page actually asks about. */
export type EvidenceWindow = "24h" | "7d" | "30d";

const WINDOW_MS: Readonly<Record<EvidenceWindow, number>> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export type EvidencePopulationFragment = Record<string, unknown>;

export async function loadEvidenceCounters(
  population: EvidencePopulationFragment,
  now: Date = new Date(),
): Promise<EvidenceCounters> {
  const windows = Object.keys(WINDOW_MS) as EvidenceWindow[];
  const [signedWithoutReport, reportedWithoutPackage, blockedSample, ...windowed] =
    await Promise.all([
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
      /*
       * "Blocked" lives in a JSON column, so it cannot be counted in SQL
       * without teaching the database the shape of that document. The sample
       * bound and the predicate are exactly the ones both callers used — this
       * is the same scan, run once instead of twice, not a new one.
       */
      prisma.evidence.findMany({
        where: {
          AND: [population],
          status: { in: ["SIGNED", "REPORTED"] },
        } as never,
        take: 500,
        select: { verificationPackageMetadata: true },
      }),
      ...windows.map((w) =>
        prisma.evidence.count({
          where: {
            AND: [population],
            createdAt: { gte: new Date(now.getTime() - WINDOW_MS[w]) },
          } as never,
        }),
      ),
    ]);

  let blockedExports = 0;
  for (const row of blockedSample) {
    const meta = row.verificationPackageMetadata as Record<string, unknown> | null;
    if (meta && meta.blocked === true) blockedExports += 1;
  }

  const createdSince = {} as Record<EvidenceWindow, number>;
  windows.forEach((w, i) => {
    createdSince[w] = windowed[i] as number;
  });

  return {
    signedWithoutReport,
    reportedWithoutPackage,
    createdSince,
    blockedExports,
  };
}

// ===========================================================================
// OPERATIONS COUNTERS
// ===========================================================================

/**
 * The three operational tables MORE THAN ONE ENGINE COUNTS.
 *
 * Same shape of finding as the review queue, one layer out. Measured on one
 * organization-workspace request:
 *
 *   * `operational_incidents` — the open-incident count by category was
 *     issued three times, differing only in the category. Pipeline Detail
 *     asked for REPORT and PACKAGE, Audit Readiness asked for PACKAGE again.
 *   * `destruction_reviews` — "pending" (PROPOSED + PENDING_APPROVAL) was
 *     counted three times, by Governance Posture, Audit Readiness and Queue
 *     Congestion, and "PROPOSED" once more beside it.
 *   * `review_escalations` — the open count, twice.
 *
 * Each is answered here by ONE `GROUP BY`, which is strictly more information
 * than the counts it replaces: a grouping over status or category returns
 * every bucket, so a later engine asking about a different one costs nothing.
 *
 * As with the review queue this is request-scoped, not cached, and it answers
 * only the questions that were already being asked — an engine wanting a
 * predicate that is not a plain status or category still asks for itself.
 */
export type OperationsCounters = {
  /** Open (OPEN + ACKNOWLEDGED) incidents for this workspace, by category. */
  openIncidentsByCategory: Readonly<Record<string, number>>;
  /** Destruction reviews for this workspace, by status. */
  destructionReviewsByStatus: Readonly<Record<string, number>>;
  /** Review escalations for this workspace, by status. */
  escalationsByStatus: Readonly<Record<string, number>>;
  /** Sum over the given categories; 0 for a category with no open incidents. */
  openIncidents(categories: readonly string[]): number;
  /** Sum over the given destruction-review statuses. */
  destructionReviews(statuses: readonly string[]): number;
  /** Sum over the given escalation statuses. */
  escalations(statuses: readonly string[]): number;
};

/**
 * The incident scope every caller used: this workspace's incidents PLUS the
 * platform-wide ones (`teamId: null`) that affect it. Written once here
 * because a snapshot that quietly narrowed the scope would under-report, and
 * an engine reading it would have no way to notice.
 */
const incidentScopeFor = (teamId: string) => ({
  OR: [{ teamId }, { teamId: null }],
});

export async function loadOperationsCounters(
  teamId: string,
): Promise<OperationsCounters> {
  const [incidents, destruction, escalations] = await Promise.all([
    prisma.operationalIncident
      .groupBy({
        by: ["category"],
        where: {
          ...incidentScopeFor(teamId),
          status: { in: ["OPEN", "ACKNOWLEDGED"] },
        },
        _count: { _all: true },
      })
      .catch(() => []),
    prisma.destructionReview
      .groupBy({ by: ["status"], where: { teamId }, _count: { _all: true } })
      .catch(() => []),
    prisma.reviewEscalation
      .groupBy({ by: ["status"], where: { teamId }, _count: { _all: true } })
      .catch(() => []),
  ]);

  const tally = (rows: { _count: { _all: number } }[], key: string) => {
    const out: Record<string, number> = {};
    for (const r of rows) {
      out[String((r as Record<string, unknown>)[key])] = r._count._all;
    }
    return out;
  };

  const openIncidentsByCategory = tally(incidents as never, "category");
  const destructionReviewsByStatus = tally(destruction as never, "status");
  const escalationsByStatus = tally(escalations as never, "status");
  const sum = (table: Record<string, number>, keys: readonly string[]) =>
    keys.reduce((n, k) => n + (table[k] ?? 0), 0);

  return {
    openIncidentsByCategory,
    destructionReviewsByStatus,
    escalationsByStatus,
    openIncidents: (categories) => sum(openIncidentsByCategory, categories),
    destructionReviews: (statuses) => sum(destructionReviewsByStatus, statuses),
    escalations: (statuses) => sum(escalationsByStatus, statuses),
  };
}
