/**
 * THE CONSOLIDATED COUNTERS ANSWER EXACTLY WHAT THE SEPARATE COUNTS ANSWERED.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------------------------------------------------------------
 * `command-center-counters.ts` replaced thirteen per-engine `COUNT(*)`
 * statements with two queries — a `GROUP BY status` and one conditional
 * aggregate written in raw SQL. Raw SQL is where a consolidation goes wrong:
 * a predicate that reads the same in English can select different rows, and
 * the failure is silent, because a count that is merely WRONG still looks like
 * a count.
 *
 * So this does not assert numbers. It runs BOTH forms against the same live
 * database — the original Prisma predicates, exactly as the engines wrote
 * them, and the consolidated snapshot — and requires them to agree, on data
 * shaped to make disagreement possible: rows on every status, rows on both
 * sides of every time boundary, and rows belonging to another workspace.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  seedOwnedWorkspace,
  seedUser,
  setAccountPlan,
  type FixtureDeps,
} from "./point7/product-fixtures.js";

describe("COMMAND CENTER — counter equivalence (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;
  let teamId: string;
  let otherTeamId: string;
  let organizationId: string;
  let ownerUserId: string;

  let loadReviewQueueCounters: typeof import("../src/services/dashboard/command-center-counters.js")["loadReviewQueueCounters"];
  let reviewQueueWindow: typeof import("../src/services/dashboard/command-center-counters.js")["reviewQueueWindow"];
  let loadEvidenceCounters: typeof import("../src/services/dashboard/command-center-counters.js")["loadEvidenceCounters"];
  let loadOperationsCounters: typeof import("../src/services/dashboard/command-center-counters.js")["loadOperationsCounters"];
  let evidencePopulation: Record<string, unknown>;
  /*
   * Late-bound, like every other service import here. A STATIC import of
   * anything under `src/` pulls `db.js` in at module load — before the
   * harness has pointed DATABASE_URL at the test database — and the server
   * then boots against nothing and reports every table as missing.
   */
  let RECENT_ESCALATION_WINDOW_DAYS: number;
  let RECENT_ESCALATION_LIMIT: number;
  let DESTRUCTION_REVIEW_AWAITING_DECISION: readonly string[];
  let DESTRUCTION_REVIEW_PROPOSED: readonly string[];

  const DAY = 24 * 60 * 60 * 1000;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    /*
     * The shared-runtime Prisma registry is populated by `src/index.ts`, which
     * the harness does not run — it calls `buildServer` directly. Any endpoint
     * reaching a shared-runtime helper therefore fails with "accessed before
     * registerPrisma()", which is a harness gap rather than product behaviour.
     */
    await import("../src/register-shared-runtime.js");
    ({
      loadReviewQueueCounters,
      reviewQueueWindow,
      loadEvidenceCounters,
      loadOperationsCounters,
      DESTRUCTION_REVIEW_AWAITING_DECISION,
      DESTRUCTION_REVIEW_PROPOSED,
      RECENT_ESCALATION_WINDOW_DAYS,
      RECENT_ESCALATION_LIMIT,
    } = await import("../src/services/dashboard/command-center-counters.js"));

    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `ccce-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          {
            sub: userId,
            provider: "EMAIL",
            email,
            authMethod: "PASSWORD",
            authAt: Math.floor(Date.now() / 1000),
          },
          secret,
          60 * 60,
        ),
    };

    const owner = await seedUser(deps, "cc-owner");
    ownerUserId = owner.userId;
    await setAccountPlan(deps, owner.userId, "TEAM");
    const ws = await seedOwnedWorkspace(deps, {
      ownerUserId: owner.userId,
      billingPlan: "TEAM",
      billingStatus: "ACTIVE",
    });
    teamId = ws.teamId;
    organizationId = ws.organizationId;

    const otherWs = await seedOwnedWorkspace(deps, {
      ownerUserId: owner.userId,
      billingPlan: "TEAM",
      billingStatus: "ACTIVE",
    });
    otherTeamId = otherWs.teamId;

    const now = Date.now();

    /*
     * Data shaped so a wrong predicate CANNOT pass:
     *   - every status represented, including the two the "open" set excludes;
     *   - due dates on both sides of now and of the 24h horizon;
     *   - CLOSED rows inside last-7d, inside prev-7d, and older than both;
     *   - one row per interesting case in ANOTHER workspace, so a missing
     *     team filter shows up as a count that is too high;
     *   - one row with a NULL due date, which must never be "overdue".
     */
    const rows: Array<{
      team: string;
      status: string;
      dueAt: Date | null;
      updatedAt: Date;
    }> = [
      { team: teamId, status: "QUEUED", dueAt: new Date(now - 3 * DAY), updatedAt: new Date(now) },
      { team: teamId, status: "QUEUED", dueAt: new Date(now + 2 * 60 * 60 * 1000), updatedAt: new Date(now) },
      { team: teamId, status: "QUEUED", dueAt: null, updatedAt: new Date(now) },
      { team: teamId, status: "ASSIGNED", dueAt: new Date(now - 1 * DAY), updatedAt: new Date(now) },
      { team: teamId, status: "ASSIGNED", dueAt: new Date(now + 5 * DAY), updatedAt: new Date(now) },
      { team: teamId, status: "IN_REVIEW", dueAt: new Date(now + 60 * 60 * 1000), updatedAt: new Date(now) },
      { team: teamId, status: "NEEDS_INFO", dueAt: new Date(now - 10 * 60 * 1000), updatedAt: new Date(now) },
      { team: teamId, status: "NOT_STARTED", dueAt: new Date(now - 5 * DAY), updatedAt: new Date(now) },
      // NOT_STARTED is deliberately outside the "open" set: an overdue row
      // here must NOT be counted, which a careless `status <> 'CLOSED'` would.
      { team: teamId, status: "CLOSED", dueAt: null, updatedAt: new Date(now - 2 * DAY) },
      { team: teamId, status: "CLOSED", dueAt: null, updatedAt: new Date(now - 9 * DAY) },
      { team: teamId, status: "CLOSED", dueAt: null, updatedAt: new Date(now - 30 * DAY) },
      // Another workspace, on every interesting case.
      { team: otherTeamId, status: "QUEUED", dueAt: new Date(now - 3 * DAY), updatedAt: new Date(now) },
      { team: otherTeamId, status: "IN_REVIEW", dueAt: new Date(now + 60 * 60 * 1000), updatedAt: new Date(now) },
      { team: otherTeamId, status: "CLOSED", dueAt: null, updatedAt: new Date(now - 2 * DAY) },
    ];

    for (const r of rows) {
      const evidence = await prisma.evidence.create({
        data: {
          ownerUserId: owner.userId,
          teamId: r.team,
          organizationId,
          type: "PHOTO",
        },
        select: { id: true },
      });
      const wf = await prisma.evidenceReviewWorkflow.create({
        data: {
          teamId: r.team,
          evidenceId: evidence.id,
          // Persisted display label, required and inert. "TEAM" is what a
          // shared workspace writes.
          workspaceType: "TEAM",
          status: r.status as never,
          dueAt: r.dueAt,
        },
        select: { id: true },
      });
      // `updatedAt` is @updatedAt, so it must be set after the fact.
      await prisma.$executeRaw`
        UPDATE "public"."evidence_review_workflows"
        SET "updated_at" = ${r.updatedAt}
        WHERE "id" = ${wf.id}::uuid
      `;
    }

    /*
     * Escalations: two OPEN here, one RESOLVED here, one OPEN elsewhere. The
     * RESOLVED row is what makes `status: "OPEN"` load-bearing rather than
     * decorative, and the foreign one is what makes the team filter so.
     */
    const anyWorkflow = await prisma.evidenceReviewWorkflow.findFirstOrThrow({
      where: { teamId },
      select: { id: true },
    });
    const foreignWorkflow = await prisma.evidenceReviewWorkflow.findFirstOrThrow({
      where: { teamId: otherTeamId },
      select: { id: true },
    });
    await prisma.reviewEscalation.createMany({
      data: [
        {
          teamId,
          workflowId: anyWorkflow.id,
          status: "OPEN",
          reason: "SLA_BREACH",
          safeSummary: "fixture escalation a",
          fingerprint: `${deps.tag}-a`,
        },
        {
          teamId,
          workflowId: anyWorkflow.id,
          status: "OPEN",
          reason: "SLA_BREACH",
          safeSummary: "fixture escalation b",
          fingerprint: `${deps.tag}-b`,
        },
        {
          teamId,
          workflowId: anyWorkflow.id,
          status: "RESOLVED",
          reason: "SLA_BREACH",
          safeSummary: "fixture escalation c",
          fingerprint: `${deps.tag}-c`,
        },
        {
          teamId: otherTeamId,
          workflowId: foreignWorkflow.id,
          status: "OPEN",
          reason: "SLA_BREACH",
          safeSummary: "fixture escalation d",
          fingerprint: `${deps.tag}-d`,
        },
      ] as never,
    });

    /*
     * THE SECOND CONSOLIDATION'S FIXTURE.
     *
     * The review-queue rows above already give this workspace evidence on
     * several statuses. What the evidence and operations snapshots need on top
     * of that is:
     *
     *   - evidence on BOTH sides of the 24h, 7d and 30d boundaries, so a
     *     window that is off by one unit cannot agree by accident;
     *   - a SIGNED row carrying `blocked: true` in its package metadata, and
     *     one carrying `blocked: false`, so the JSON predicate is doing work;
     *   - open incidents in more than one category, plus a RESOLVED one and a
     *     platform-wide (`teamId: null`) one, because the engines counted
     *     "this workspace OR the platform" and a snapshot that dropped either
     *     half would still look plausible;
     *   - destruction reviews on three statuses, only two of which are
     *     "pending".
     */
    const t0 = Date.now();
    const evidenceAges = [
      2 * 60 * 60 * 1000, // inside 24h
      6 * 60 * 60 * 1000, // inside 24h
      3 * DAY, // inside 7d, outside 24h
      10 * DAY, // inside 30d, outside 7d
      45 * DAY, // outside every window
    ];
    for (const age of evidenceAges) {
      const e = await prisma.evidence.create({
        data: {
          ownerUserId: owner.userId,
          teamId,
          organizationId,
          type: "PHOTO",
          status: "SIGNED",
        },
        select: { id: true },
      });
      await prisma.$executeRaw`
        UPDATE "public"."evidence"
        SET "created_at" = ${new Date(t0 - age)}
        WHERE "id" = ${e.id}::uuid
      `;
    }
    // One in the OTHER workspace, inside every window — a missing team filter
    // shows up as a count that is too high.
    await prisma.evidence.create({
      data: {
        ownerUserId: owner.userId,
        teamId: otherTeamId,
        organizationId,
        type: "PHOTO",
        status: "SIGNED",
      },
    });

    await prisma.evidence.create({
      data: {
        ownerUserId: owner.userId,
        teamId,
        organizationId,
        type: "PHOTO",
        status: "SIGNED",
        verificationPackageMetadata: { blocked: true } as never,
      },
    });
    await prisma.evidence.create({
      data: {
        ownerUserId: owner.userId,
        teamId,
        organizationId,
        type: "PHOTO",
        status: "REPORTED",
        verificationPackageMetadata: { blocked: false } as never,
      },
    });

    const incident = (
      teamValue: string | null,
      category: string,
      status: string,
      suffix: string,
    ) => ({
      teamId: teamValue,
      scope: teamValue === null ? "PLATFORM" : "WORKSPACE",
      category,
      severity: "WARNING",
      status,
      fingerprint: `${deps.tag}-inc-${suffix}`,
      title: `fixture incident ${suffix}`,
      safeSummary: "fixture",
      openedBySystem: true,
    });
    await prisma.operationalIncident.createMany({
      data: [
        incident(teamId, "REPORT", "OPEN", "r1"),
        incident(teamId, "REPORT", "ACKNOWLEDGED", "r2"),
        incident(teamId, "PACKAGE", "OPEN", "p1"),
        // RESOLVED is outside the open set; counting it would inflate both.
        incident(teamId, "PACKAGE", "RESOLVED", "p2"),
        // Platform-wide: in scope for this workspace by every engine's
        // predicate, and the easiest half of that predicate to lose.
        incident(null, "PACKAGE", "OPEN", "p3"),
        incident(otherTeamId, "PACKAGE", "OPEN", "p4"),
      ] as never,
    });

    /*
     * A review is 1:1 with a piece of evidence, so the fixture needs four
     * distinct rows to hang them on.
     */
    const destructionEvidence: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const e = await prisma.evidence.create({
        data: {
          ownerUserId: owner.userId,
          teamId: i === 3 ? otherTeamId : teamId,
          organizationId,
          type: "PHOTO",
        },
        select: { id: true },
      });
      destructionEvidence.push(e.id);
    }
    await prisma.destructionReview.createMany({
      data: [
        {
          teamId,
          status: "PENDING",
          reason: "retention_expired",
          initiatedByUserId: owner.userId,
          evidenceId: destructionEvidence[0],
        },
        {
          teamId,
          status: "UNDER_REVIEW",
          reason: "retention_expired",
          initiatedByUserId: owner.userId,
          evidenceId: destructionEvidence[1],
        },
        {
          teamId,
          status: "EXECUTED",
          reason: "retention_expired",
          initiatedByUserId: owner.userId,
          evidenceId: destructionEvidence[2],
        },
        {
          teamId: otherTeamId,
          status: "PENDING",
          reason: "retention_expired",
          initiatedByUserId: owner.userId,
          evidenceId: destructionEvidence[3],
        },
      ] as never,
    }).catch(() => undefined);

    /*
     * The CANONICAL evidence population, resolved the way the endpoint
     * resolves it. Hand-writing `{ teamId }` here would compare the snapshot
     * against a predicate the product does not use, and would pass while the
     * product was wrong.
     */
    const { evidenceScopeFor } = await import("@proovra/shared-runtime");
    evidencePopulation = evidenceScopeFor({
      physicalWorkspaceId: teamId,
      workspaceKind: "ORGANIZATION",
      personalOwnerUserId: null,
    } as never) as never;
  });

  afterAll(async () => {
    await harness?.cleanup?.();
  });

  // =========================================================================
  // EVIDENCE SNAPSHOT
  // =========================================================================

  it("the windowed evidence counts equal the per-engine counts they replaced", async () => {
    /*
     * The originals, verbatim: Organizational Intelligence counted 24h and 7d,
     * Queue Telemetry counted 24h, 7d and 30d, and each took its own clock.
     * The snapshot takes ONE clock, so the comparison is made against that
     * same instant — otherwise this test would be measuring the milliseconds
     * between two `new Date()` calls rather than the predicate.
     */
    const now = new Date();
    const at = (ms: number) =>
      prisma.evidence.count({
        where: {
          AND: [evidencePopulation],
          createdAt: { gte: new Date(now.getTime() - ms) },
        } as never,
      });

    const [in24h, in7d, in30d] = await Promise.all([
      at(24 * 60 * 60 * 1000),
      at(7 * DAY),
      at(30 * DAY),
    ]);
    const snapshot = await loadEvidenceCounters(evidencePopulation as never, now);

    expect(snapshot.createdSince["24h"]).toBe(in24h);
    expect(snapshot.createdSince["7d"]).toBe(in7d);
    expect(snapshot.createdSince["30d"]).toBe(in30d);

    // The windows must actually be distinct here, or agreement proves nothing.
    expect(in24h).toBeGreaterThan(0);
    expect(in7d).toBeGreaterThan(in24h);
    expect(in30d).toBeGreaterThan(in7d);
  });

  it("every section reading a window reads the SAME instant", async () => {
    /*
     * The defect the shared clock removes: two engines taking `new Date()`
     * milliseconds apart could place a row on opposite sides of the same
     * boundary and report two different figures for "the last 24 hours".
     *
     * A row created exactly on the boundary makes that visible: called twice
     * with the SAME clock the answer cannot move, whatever the wall time does
     * between the calls.
     */
    const now = new Date();
    const a = await loadEvidenceCounters(evidencePopulation as never, now);
    await new Promise((r) => setTimeout(r, 25));
    const b = await loadEvidenceCounters(evidencePopulation as never, now);
    expect(b.createdSince).toEqual(a.createdSince);
  });

  it("the blocked-exports scan equals the one three engines each ran", async () => {
    // Pipeline Detail, Governance Posture and Audit Readiness each ran this
    // exact scan and reduced it to this exact number.
    const rows = await prisma.evidence.findMany({
      where: {
        AND: [evidencePopulation],
        status: { in: ["SIGNED", "REPORTED"] },
      } as never,
      take: 500,
      select: { verificationPackageMetadata: true },
    });
    let expected = 0;
    for (const r of rows) {
      const meta = r.verificationPackageMetadata as Record<string, unknown> | null;
      if (meta && meta.blocked === true) expected += 1;
    }

    const snapshot = await loadEvidenceCounters(evidencePopulation as never);
    expect(snapshot.blockedExports).toBe(expected);
    // And the fixture has both a blocked and an unblocked row, so a predicate
    // that ignored the flag would count too many.
    expect(expected).toBe(1);
  });

  // =========================================================================
  // OPERATIONS SNAPSHOT
  // =========================================================================

  it("open incidents by category equal the per-category counts they replaced", async () => {
    const original = (category: string) =>
      prisma.operationalIncident.count({
        where: {
          OR: [{ teamId }, { teamId: null }],
          status: { in: ["OPEN", "ACKNOWLEDGED"] as never },
          category: category as never,
        },
      });
    const [report, pkg] = await Promise.all([original("REPORT"), original("PACKAGE")]);
    const ops = await loadOperationsCounters(teamId);

    expect(ops.openIncidents(["REPORT"])).toBe(report);
    expect(ops.openIncidents(["PACKAGE"])).toBe(pkg);
    // Both categories present, and the RESOLVED row excluded from PACKAGE.
    expect(report).toBe(2);
    expect(pkg).toBe(2); // one team-scoped OPEN + one platform-wide OPEN
  });

  it("keeps the platform-wide incidents the engines' predicate included", async () => {
    /*
     * Every engine scoped incidents as "mine OR the platform's". A snapshot
     * that quietly narrowed that to `teamId` alone would under-report and
     * still look entirely reasonable, so the fixture holds a platform-wide
     * OPEN incident and this asserts it is counted.
     */
    const ops = await loadOperationsCounters(teamId);
    const teamOnly = await prisma.operationalIncident.count({
      where: {
        teamId,
        status: { in: ["OPEN", "ACKNOWLEDGED"] as never },
        category: "PACKAGE" as never,
      },
    });
    expect(teamOnly).toBe(1);
    expect(ops.openIncidents(["PACKAGE"])).toBe(teamOnly + 1);
  });

  it("does not count another workspace's incidents, reviews or escalations", async () => {
    const mine = await loadOperationsCounters(teamId);
    const theirs = await loadOperationsCounters(otherTeamId);

    // The other workspace has its own PACKAGE incident and sees the same
    // platform-wide one; it must NOT see this workspace's REPORT incidents.
    expect(theirs.openIncidents(["REPORT"])).toBe(0);
    expect(mine.openIncidents(["REPORT"])).toBe(2);
    expect(theirs.destructionReviews(DESTRUCTION_REVIEW_AWAITING_DECISION)).not.toBe(
      mine.destructionReviews(DESTRUCTION_REVIEW_AWAITING_DECISION),
    );
    expect(theirs.escalations(["OPEN"])).toBe(1);
    expect(mine.escalations(["OPEN"])).toBe(2);
  });

  it("destruction-review and escalation depths equal their original counts", async () => {
    const [pending, proposed, openEsc] = await Promise.all([
      prisma.destructionReview.count({
        where: { teamId, status: { in: ["PENDING", "UNDER_REVIEW"] as never } },
      }),
      prisma.destructionReview.count({ where: { teamId, status: "PENDING" as never } }),
      prisma.reviewEscalation.count({ where: { teamId, status: "OPEN" } }),
    ]);
    const ops = await loadOperationsCounters(teamId);

    expect(ops.destructionReviews(DESTRUCTION_REVIEW_AWAITING_DECISION)).toBe(pending);
    expect(ops.destructionReviews(DESTRUCTION_REVIEW_PROPOSED)).toBe(proposed);
    expect(ops.escalations(["OPEN"])).toBe(openEsc);
    // EXECUTED exists and is excluded — "pending" is narrower than "all".
    expect(pending).toBeLessThan(
      await prisma.destructionReview.count({ where: { teamId } }),
    );
  });

  it("the recent-escalation list equals the one two engines each fetched", async () => {
    /*
     * The operational timeline and the reconstructed timeline both read the
     * most recent escalations, with the same predicate, ordering and bound —
     * and each took its own `new Date()`, so the two sections of one page
     * could be built from windows milliseconds apart.
     *
     * The original query, verbatim, against the same clock the snapshot uses.
     */
    const now = new Date();
    const since = new Date(
      now.getTime() - RECENT_ESCALATION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    const original = await prisma.reviewEscalation.findMany({
      where: { teamId, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: RECENT_ESCALATION_LIMIT,
      select: {
        id: true,
        severity: true,
        reason: true,
        workflowId: true,
        createdAt: true,
      },
    });

    const ops = await loadOperationsCounters(teamId, now);
    expect(ops.recentEscalations.map((e) => e.id)).toEqual(
      original.map((e) => e.id),
    );
    // Not equal-but-empty: the fixture holds escalations in this window.
    expect(original.length).toBeGreaterThan(0);
  });

  it("the recent-escalation list is another workspace's, never this one's", async () => {
    const mine = await loadOperationsCounters(teamId);
    const theirs = await loadOperationsCounters(otherTeamId);
    const mineIds = new Set(mine.recentEscalations.map((e) => e.id));
    for (const e of theirs.recentEscalations) {
      expect(mineIds.has(e.id)).toBe(false);
    }
    expect(theirs.recentEscalations.length).toBeGreaterThan(0);
  });

  it("one clock: asking twice cannot move the escalation window", async () => {
    const now = new Date();
    const a = await loadOperationsCounters(teamId, now);
    await new Promise((r) => setTimeout(r, 25));
    const b = await loadOperationsCounters(teamId, now);
    expect(b.recentEscalations.map((e) => e.id)).toEqual(
      a.recentEscalations.map((e) => e.id),
    );
  });

  // =========================================================================
  // OPERATIONAL GRAPH — the grouping already answered the three counts
  // =========================================================================

  it("graph node counts derived from the grouping equal the counts they replaced", async () => {
    const original = async (nodeType: string) =>
      prisma.operationalGraphNode.count({
        where: { teamId, nodeType: nodeType as never },
      });

    const groups = await prisma.operationalGraphNode.groupBy({
      by: ["nodeType"],
      where: { teamId },
      _count: { _all: true },
      orderBy: { nodeType: "asc" },
    });
    const derived = (nodeType: string) =>
      groups.find((g) => String(g.nodeType) === nodeType)?._count._all ?? 0;

    for (const nodeType of ["EVIDENCE", "CASE", "REVIEWER"]) {
      expect(derived(nodeType), `${nodeType} disagrees`).toBe(
        await original(nodeType),
      );
    }
  });

  it("a node type with no rows reads as zero, not undefined", async () => {
    // A GROUP BY returns NO ROW for an empty bucket. Reading that as
    // `undefined` and doing arithmetic on it is how a dashboard renders NaN.
    const groups = await prisma.operationalGraphNode.groupBy({
      by: ["nodeType"],
      where: { teamId },
      _count: { _all: true },
    });
    const derived = (nodeType: string) =>
      groups.find((g) => String(g.nodeType) === nodeType)?._count._all ?? 0;
    const empty = derived("REVIEWER");
    expect(Number.isFinite(empty)).toBe(true);
    expect(empty).toBe(
      await prisma.operationalGraphNode.count({
        where: { teamId, nodeType: "REVIEWER" as never },
      }),
    );
  });

  it("a category or status with nothing in it reads as zero, not undefined", async () => {
    // Every engine that reads the snapshot does arithmetic on the result. A
    // grouping returns no row at all for an empty bucket, and `undefined`
    // propagating into a severity comparison is how a consolidation like this
    // renders "NaN" on a dashboard.
    const ops = await loadOperationsCounters(teamId);
    expect(ops.openIncidents(["STORAGE"])).toBe(0);
    expect(ops.destructionReviews(["CANCELLED"])).toBe(0);
    expect(ops.escalations(["ACKNOWLEDGED"])).toBe(0);
  });

  it("agrees with the per-engine counts it replaced, figure for figure", async () => {
    const window = reviewQueueWindow();
    const { now, dueSoonCutoff, last7dStart, prev7dStart } = window;
    const OPEN = ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] as const;

    /*
     * THE ORIGINALS, verbatim. Each of these is a predicate that was written
     * inside an engine before the consolidation; they are reproduced here
     * rather than referenced so that deleting one from the service cannot
     * quietly delete the thing this suite compares against.
     */
    const [
      queueDepth,
      overdue,
      dueSoon,
      unassigned,
      closedLast7d,
      closedPrev7d,
      assigned,
      inReview,
      pendingSignoff,
      openEscalations,
    ] = await Promise.all([
      prisma.evidenceReviewWorkflow.count({
        where: { teamId, status: { in: [...OPEN] as never } },
      }),
      prisma.evidenceReviewWorkflow.count({
        where: { teamId, status: { in: [...OPEN] as never }, dueAt: { lt: now } },
      }),
      prisma.evidenceReviewWorkflow.count({
        where: {
          teamId,
          status: { in: [...OPEN] as never },
          dueAt: { gte: now, lt: dueSoonCutoff },
        },
      }),
      prisma.evidenceReviewWorkflow.count({ where: { teamId, status: "QUEUED" } }),
      prisma.evidenceReviewWorkflow.count({
        where: { teamId, status: "CLOSED", updatedAt: { gte: last7dStart } },
      }),
      prisma.evidenceReviewWorkflow.count({
        where: {
          teamId,
          status: "CLOSED",
          updatedAt: { gte: prev7dStart, lt: last7dStart },
        },
      }),
      prisma.evidenceReviewWorkflow.count({ where: { teamId, status: "ASSIGNED" } }),
      prisma.evidenceReviewWorkflow.count({ where: { teamId, status: "IN_REVIEW" } }),
      prisma.evidenceReviewWorkflow.count({
        where: { teamId, status: { in: ["IN_REVIEW", "NEEDS_INFO"] as never } },
      }),
      prisma.reviewEscalation.count({ where: { teamId, status: "OPEN" } }),
    ]);

    const snapshot = await loadReviewQueueCounters(teamId, window);

    expect(snapshot.inStatus(OPEN)).toBe(queueDepth);
    expect(snapshot.overdue).toBe(overdue);
    expect(snapshot.dueSoon).toBe(dueSoon);
    expect(snapshot.inStatus(["QUEUED"])).toBe(unassigned);
    expect(snapshot.closedLast7d).toBe(closedLast7d);
    expect(snapshot.closedPrev7d).toBe(closedPrev7d);
    expect(snapshot.inStatus(["ASSIGNED"])).toBe(assigned);
    expect(snapshot.inStatus(["IN_REVIEW"])).toBe(inReview);
    expect(snapshot.inStatus(["IN_REVIEW", "NEEDS_INFO"])).toBe(pendingSignoff);
    expect(snapshot.openEscalations).toBe(openEscalations);

    /*
     * And the fixture actually exercises the boundaries. Equal-but-zero would
     * be equality proving nothing, which is the usual way a consolidation test
     * passes while the consolidation is wrong.
     */
    expect(queueDepth).toBeGreaterThan(0);
    expect(overdue).toBeGreaterThan(0);
    expect(dueSoon).toBeGreaterThan(0);
    expect(closedLast7d).toBeGreaterThan(0);
    expect(closedPrev7d).toBeGreaterThan(0);
    expect(openEscalations).toBe(2);
  });

  it("does not count another workspace's queue", async () => {
    const window = reviewQueueWindow();
    const mine = await loadReviewQueueCounters(teamId, window);
    const theirs = await loadReviewQueueCounters(otherTeamId, window);

    expect(theirs.inStatus(["QUEUED"])).toBe(1);
    expect(theirs.inStatus(["IN_REVIEW"])).toBe(1);
    expect(theirs.openEscalations).toBe(1);
    // The two workspaces disagree, which is how we know the filter is applied.
    expect(mine.inStatus(["QUEUED"])).not.toBe(theirs.inStatus(["QUEUED"]));
  });

  it("never treats a workflow with no due date as overdue", async () => {
    /*
     * `due_at < now` is NULL-safe in SQL and `dueAt: { lt: now }` is
     * NULL-safe in Prisma, but they are different implementations of that
     * safety and the fixture holds a QUEUED row with a NULL due date
     * specifically so a regression in either shows up here.
     */
    const window = reviewQueueWindow();
    const snapshot = await loadReviewQueueCounters(teamId, window);
    const nullDue = await prisma.evidenceReviewWorkflow.count({
      where: { teamId, status: "QUEUED", dueAt: null },
    });
    expect(nullDue).toBeGreaterThan(0);

    const overdueViaPrisma = await prisma.evidenceReviewWorkflow.count({
      where: {
        teamId,
        status: { in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] as never },
        dueAt: { lt: window.now },
      },
    });
    expect(snapshot.overdue).toBe(overdueViaPrisma);
  });

  it("excludes statuses outside the open set even when they are overdue", async () => {
    // The fixture holds a NOT_STARTED row whose due date has passed. A
    // predicate of `status <> 'CLOSED'` would count it; the product's does not.
    const window = reviewQueueWindow();
    const snapshot = await loadReviewQueueCounters(teamId, window);
    const notStartedOverdue = await prisma.evidenceReviewWorkflow.count({
      where: { teamId, status: "NOT_STARTED", dueAt: { lt: window.now } },
    });
    expect(notStartedOverdue).toBeGreaterThan(0);
    expect(snapshot.inStatus(["NOT_STARTED"])).toBe(notStartedOverdue);

    const openOverdue = await prisma.evidenceReviewWorkflow.count({
      where: {
        teamId,
        status: { in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] as never },
        dueAt: { lt: window.now },
      },
    });
    expect(snapshot.overdue).toBe(openOverdue);
    expect(snapshot.overdue).toBeLessThan(openOverdue + notStartedOverdue);
  });

  it("the command-center endpoint still returns the same reviewer figures", async () => {
    /*
     * The end of the chain: the numbers the PAGE renders, through the real
     * route, compared against the same predicates computed independently.
     */
    const token = deps.mintToken(ownerUserId, "cc-owner@example.test");
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/dashboard/command-center?teamId=${teamId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as {
      sections: {
        reviewerWorkload: { status: string; data: Record<string, number> | null };
      };
    };

    const workload = body.sections.reviewerWorkload;
    expect(workload.status).toBe("ok");
    expect(workload.data!.queuedCount).toBe(
      await prisma.evidenceReviewWorkflow.count({ where: { teamId, status: "QUEUED" } }),
    );
    expect(workload.data!.assignedCount).toBe(
      await prisma.evidenceReviewWorkflow.count({ where: { teamId, status: "ASSIGNED" } }),
    );
    expect(workload.data!.inReviewCount).toBe(
      await prisma.evidenceReviewWorkflow.count({ where: { teamId, status: "IN_REVIEW" } }),
    );
  });
});
