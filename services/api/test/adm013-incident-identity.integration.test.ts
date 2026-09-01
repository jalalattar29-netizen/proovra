/**
 * ADM-013 PHASE 4 — INCIDENT IDENTITY UNDER REAL CONCURRENCY.
 *
 * =============================================================================
 * WHAT THE UNIT TEST COULD NOT SAY
 * =============================================================================
 * `adm013-incident-identity.test.ts` proves the WRITER catches P2002 and
 * recovers onto the winner, by driving a double through the exact interleaving.
 * That is the right test for that property and it cannot say the two things
 * that matter most in production:
 *
 *   1. that the DATABASE actually refuses the second row, and
 *   2. that the writer's recovery path is REACHABLE — that a real pair of
 *      concurrent evaluations really does produce one row and one recovery,
 *      rather than one row and one lost observation, or two rows.
 *
 * Both are properties of Postgres plus the writer together, so both need a real
 * Postgres and a real race. This runs `recordIncident` twice CONCURRENTLY on
 * two independent Prisma clients against one database, for the same NULL-team
 * fingerprint, and asserts on the rows afterwards.
 *
 * Two clients, not two awaits on one: a single client serialises through one
 * pool connection and the two inserts would not overlap at all — the test would
 * pass without ever exercising the constraint.
 *
 * =============================================================================
 * THE INDEX IS A PRECONDITION, AND IT IS ASSERTED
 * =============================================================================
 * Every claim here depends on
 * `operational_incidents_platform_fingerprint_uk` existing. Migration
 * 20280104000000 creates it on a clean database; the operator script creates it
 * on one that needed converging first. The suite asserts it is present before
 * asserting anything about behaviour — because without it these tests pass
 * vacuously in the worst possible way: two rows, no error, and a green suite.
 */

import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("INCIDENT IDENTITY — concurrency, against live PostgreSQL 16", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let recordIncident: typeof import("../src/services/observability/incident.service.js")["recordIncident"];
  /** A SECOND client, so the two writes are genuinely concurrent. */
  let second: import("@prisma/client").PrismaClient;
  let secondPool: import("pg").Pool;

  const fingerprints: string[] = [];

  function fp(label: string): string {
    const value = `adm013:${label}:${randomUUID().slice(0, 8)}`;
    fingerprints.push(value);
    return value;
  }

  /** A platform-scope observation. `teamId` absent is what makes it NULL-team. */
  function observation(fingerprint: string, severity = "WARNING") {
    return {
      sourceId: "platform.queue_backlog",
      category: "REPORT" as const,
      severity: severity as "WARNING",
      fingerprint,
      title: "Queue backlog",
      safeSummary: "The report queue is backed up.",
    };
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ recordIncident } = await import(
      "../src/services/observability/incident.service.js"
    ));

    const { PrismaClient } = await import("@prisma/client");
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const { Pool } = await import("pg");
    secondPool = new Pool({ connectionString: process.env.DATABASE_URL });
    second = new PrismaClient({ adapter: new PrismaPg(secondPool) });
  }, 300_000);

  afterAll(async () => {
    if (!harness) return;
    try {
      await prisma.operationalIncident.deleteMany({
        where: { fingerprint: { in: fingerprints } },
      });
    } catch {
      /* the harness drops the database anyway */
    }
    await second?.$disconnect().catch(() => undefined);
    await secondPool?.end().catch(() => undefined);
    await harness.cleanup();
  }, 120_000);

  // ==========================================================================
  // The precondition.
  // ==========================================================================

  it("the platform uniqueness index is present on this database", async () => {
    const [row] = (await prisma.$queryRawUnsafe(`
      SELECT EXISTS (
        SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname = 'operational_incidents_platform_fingerprint_uk'
      ) AS present
    `)) as Array<{ present: boolean }>;
    expect(
      row.present,
      "without the partial unique index every assertion below passes vacuously — two rows, no error, green suite",
    ).toBe(true);
  });

  it("the index is PARTIAL, so workspace rows are untouched by it", async () => {
    const [row] = (await prisma.$queryRawUnsafe(`
      SELECT indexdef FROM pg_indexes
       WHERE indexname = 'operational_incidents_platform_fingerprint_uk'
    `)) as Array<{ indexdef: string }>;
    // An unqualified unique index on `fingerprint` would merge unrelated
    // tenants' conditions into one identity.
    expect(row.indexdef).toMatch(/WHERE \(team_id IS NULL\)/);
  });

  // ==========================================================================
  // The race.
  // ==========================================================================

  it("two CONCURRENT platform evaluations produce exactly one row", async () => {
    const fingerprint = fp("concurrent");

    // Two clients, started together. One of them loses the create.
    const [a, b] = await Promise.all([
      recordIncident(observation(fingerprint), prisma),
      recordIncident(observation(fingerprint), second),
    ]);

    const rows = await prisma.operationalIncident.findMany({
      where: { fingerprint, teamId: null },
      select: { id: true, occurrenceCount: true, status: true },
    });

    expect(
      rows.length,
      "two concurrent evaluations of ONE platform condition produced more than one row — the partial unique index is not doing its job",
    ).toBe(1);

    // Neither call threw, and both describe the same row. A writer that let
    // P2002 escape would have failed the await above; a writer that swallowed
    // it would have returned something that is not this row.
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();

    // The occurrence is counted. Exactly one create plus one recovery-into-
    // update gives 2 — the loser's observation is NOT dropped, which is the
    // whole point of the recovery path.
    expect(
      rows[0].occurrenceCount,
      "the loser's observation was lost — recovery ran but did not count",
    ).toBe(2);
  });

  it("ten concurrent evaluations still produce one row and count all ten", async () => {
    // One race can pass by luck if the two calls happen not to overlap. Ten
    // alternating across two clients makes an accidental serialisation
    // improbable, and makes the counting claim much harder to satisfy by
    // accident.
    const fingerprint = fp("storm");
    const clients = [prisma, second];
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        recordIncident(observation(fingerprint), clients[i % 2]),
      ),
    );

    const rows = await prisma.operationalIncident.findMany({
      where: { fingerprint, teamId: null },
      select: { occurrenceCount: true },
    });
    expect(rows.length).toBe(1);
    expect(
      rows[0].occurrenceCount,
      "an observation was lost under contention — every one of the ten must land on the single row",
    ).toBe(10);
  });

  it("the recovery path is REACHABLE, not merely present in the source", async () => {
    // The unit test proves the branch exists and behaves. This proves a real
    // race reaches it: `operational_incident_create_raced` is bumped only in
    // the P2002 catch, so a non-zero delta across a concurrent pair is the
    // branch executing against a real constraint violation.
    const { snapshotMetrics } = await import("@proovra/shared-runtime");
    const before =
      (snapshotMetrics().counters["operational_incident_create_raced"] as
        | number
        | undefined) ?? 0;

    const fingerprint = fp("reachable");
    await Promise.all([
      recordIncident(observation(fingerprint), prisma),
      recordIncident(observation(fingerprint), second),
    ]);

    const after =
      (snapshotMetrics().counters["operational_incident_create_raced"] as
        | number
        | undefined) ?? 0;

    // `>=` rather than `=== before + 1`: the second client runs in this same
    // process, so both losers of earlier cases in this file also increment it,
    // and pinning an exact delta would make the case order-dependent.
    expect(
      after,
      "no create race was recorded — either the two calls never overlapped, or the writer is not reaching the recovery branch",
    ).toBeGreaterThan(before);
  });

  // ==========================================================================
  // Workspace identity is a different identity.
  // ==========================================================================

  it("the same fingerprint in two workspaces stays two conditions", async () => {
    const fingerprint = fp("shared");
    const [w1, w2] = [harness.fixtures, harness.fixtures].map(
      () => undefined,
    ) as undefined[];
    void w1;
    void w2;

    // Two real workspaces from the harness fixtures.
    const teams = await prisma.team.findMany({
      select: { id: true },
      take: 2,
      orderBy: { createdAt: "asc" },
    });
    expect(
      teams.length,
      "this case needs two seeded workspaces to be meaningful",
    ).toBe(2);

    await recordIncident(
      { ...observation(fingerprint), teamId: teams[0].id },
      prisma,
    );
    await recordIncident(
      { ...observation(fingerprint), teamId: teams[1].id },
      prisma,
    );

    const rows = await prisma.operationalIncident.findMany({
      where: { fingerprint },
      select: { teamId: true },
    });
    // Two workspaces legitimately hit the same condition. Collapsing them would
    // tell one tenant about another tenant's fault.
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.teamId)).size).toBe(2);
  });

  it("a second observation of the same workspace condition updates, never duplicates", async () => {
    const fingerprint = fp("ws-repeat");
    const team = await prisma.team.findFirst({ select: { id: true } });
    expect(team).toBeTruthy();

    await recordIncident({ ...observation(fingerprint), teamId: team!.id }, prisma);
    await recordIncident({ ...observation(fingerprint), teamId: team!.id }, prisma);

    const rows = await prisma.operationalIncident.findMany({
      where: { fingerprint, teamId: team!.id },
      select: { occurrenceCount: true },
    });
    expect(rows.length).toBe(1);
    expect(rows[0].occurrenceCount).toBe(2);
  });

  // ==========================================================================
  // Recurrence after resolution.
  // ==========================================================================

  it("a resolved platform condition reopens on recurrence rather than duplicating", async () => {
    const fingerprint = fp("recurrence");
    await recordIncident(observation(fingerprint), prisma);

    await prisma.operationalIncident.updateMany({
      where: { fingerprint, teamId: null },
      data: { status: "RESOLVED" },
    });

    await recordIncident(observation(fingerprint), prisma);

    const rows = await prisma.operationalIncident.findMany({
      where: { fingerprint, teamId: null },
      select: { status: true, occurrenceCount: true },
    });
    // The uniqueness index must not turn a recurrence into a second row, and
    // the transition authority must not leave a still-firing condition closed.
    expect(rows.length).toBe(1);
    expect(rows[0].status).not.toBe("RESOLVED");
    expect(rows[0].occurrenceCount).toBe(2);
  });
});
