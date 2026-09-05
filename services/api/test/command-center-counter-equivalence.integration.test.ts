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
    ({ loadReviewQueueCounters, reviewQueueWindow } = await import(
      "../src/services/dashboard/command-center-counters.js"
    ));

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
  });

  afterAll(async () => {
    await harness?.cleanup?.();
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
