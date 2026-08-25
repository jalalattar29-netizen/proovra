/**
 * THE RECONCILE AUTHORITY — one explicit entry point, and a GET that reads.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS WRONG
 * ---------------------------------------------------------------------------
 * `GET /v1/ops/summary` called `ensureWorkspaceOperationsFresh` before
 * answering, so opening a tab, polling, or pressing the browser's own reload
 * could each start a multi-source discovery sweep. Three consequences, all
 * measured on the surface rather than argued from principle:
 *
 *   * The browser's "Check again" was `refresh()` — a token bump that
 *     re-fetched the SAME summary. A workspace whose last run was PARTIAL
 *     re-read the same PARTIAL run and rendered the same warning, so the
 *     control appeared to do nothing.
 *   * The trigger was invisible. Nothing recorded that a run had been started
 *     because somebody opened a page.
 *   * The read's latency and failure modes became the writer's, which is how
 *     a broken writer became a broken page.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE PINS
 * ---------------------------------------------------------------------------
 *   * the GET performs NO reconciliation, proven by counting run rows;
 *   * the POST does, and reports honestly whether it started one;
 *   * contention is a truthful no-op, not an error and not a second run;
 *   * the mutation is bound to the same membership floor as the read, and a
 *     non-member gets the anti-enumeration 404 rather than a 403 that
 *     confirms the workspace exists;
 *   * a schema-incompatible image REFUSES to run a sweep it knows will fail
 *     the same way, and says the refusal is not retryable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("Operations reconcile authority (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let readiness: typeof import("../src/services/operations/operations-writer-readiness.js");

  let A: { teamId: string; ownerToken: string; viewerToken: string };
  let B: { teamId: string; ownerToken: string };

  async function get(path: string, token: string) {
    return harness.app.inject({
      method: "GET",
      url: path,
      headers: { authorization: `Bearer ${token}` },
    });
  }
  async function post(path: string, token: string, body: unknown) {
    return harness.app.inject({
      method: "POST",
      url: path,
      headers: { authorization: `Bearer ${token}` },
      payload: body as never,
    });
  }

  async function runRows(teamId: string): Promise<number> {
    return prisma.governanceReconciliationRun.count({
      where: { kind: "WORKSPACE_OPERATIONS", teamId },
    });
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    readiness = await import(
      "../src/services/operations/operations-writer-readiness.js"
    );
    A = {
      teamId: harness.fixtures.teamA.teamId,
      ownerToken: harness.fixtures.teamA.ownerToken,
      viewerToken: harness.fixtures.teamA.viewerToken,
    };
    B = {
      teamId: harness.fixtures.teamB.teamId,
      ownerToken: harness.fixtures.teamB.ownerToken,
    };
  }, 900_000);

  afterAll(async () => {
    readiness.resetWriterContractCache();
    await harness?.cleanup?.();
  });

  beforeEach(async () => {
    readiness.resetWriterContractCache();
    await prisma.governanceReconciliationRun.deleteMany({
      where: { kind: "WORKSPACE_OPERATIONS" },
    });
  });

  // =======================================================================
  // The GET is a read.
  // =======================================================================

  it("GET /v1/ops/summary starts no run, however many times it is called", async () => {
    expect(await runRows(A.teamId)).toBe(0);

    for (let i = 0; i < 5; i += 1) {
      const res = await get(`/v1/ops/summary?teamId=${A.teamId}`, A.ownerToken);
      expect(res.statusCode).toBe(200);
    }

    // Zero, not "one because the lock deduplicated them". A GET that starts
    // work is a GET that starts work even when the lock makes it cheap.
    expect(await runRows(A.teamId)).toBe(0);
  });

  it("GET /v1/ops/summary reports NEVER_RUN honestly rather than manufacturing a run", async () => {
    const res = await get(`/v1/ops/summary?teamId=${A.teamId}`, A.ownerToken);
    const body = res.json() as {
      summary: { readiness: string; mayAssertAllClear: boolean; clearRefusalReason: string | null };
    };
    expect(body.summary.readiness).toBe("NEVER_RUN");
    // And a workspace nothing has ever examined may not be called clear —
    // an empty incident table read perfectly is exactly what "never looked"
    // looks like from here.
    expect(body.summary.mayAssertAllClear).toBe(false);
    expect(body.summary.clearRefusalReason).toBe("NEVER_RUN");
  });

  // =======================================================================
  // The POST is the one explicit entry point.
  // =======================================================================

  it("POST /v1/ops/workspace-reconcile starts exactly one run", async () => {
    const res = await post("/v1/ops/workspace-reconcile", A.ownerToken, {
      teamId: A.teamId,
    });
    expect(res.statusCode).toBe(202);
    expect(await runRows(A.teamId)).toBe(1);

    const after = await get(`/v1/ops/summary?teamId=${A.teamId}`, A.ownerToken);
    expect((after.json() as { summary: { readiness: string } }).summary.readiness).not.toBe(
      "NEVER_RUN",
    );
  });

  it("concurrent callers produce ONE run and none of them is told something false", async () => {
    const [a, b, c] = await Promise.all([
      post("/v1/ops/workspace-reconcile", A.ownerToken, { teamId: A.teamId }),
      post("/v1/ops/workspace-reconcile", A.ownerToken, { teamId: A.teamId }),
      post("/v1/ops/workspace-reconcile", A.ownerToken, { teamId: A.teamId }),
    ]);
    for (const res of [a, b, c]) expect(res.statusCode).toBe(202);
    // The durable per-workspace lock IS the idempotency key. A double-click,
    // a retry and fifty operators pressing at once are one run.
    expect(await runRows(A.teamId)).toBe(1);
  });

  it("a VIEWER may ask for a fresh check — seeing a stale picture without being able to correct it is not read-only, it is misleading", async () => {
    const res = await post("/v1/ops/workspace-reconcile", A.viewerToken, {
      teamId: A.teamId,
    });
    expect(res.statusCode).toBe(202);
    expect(await runRows(A.teamId)).toBe(1);
  });

  it("a non-member gets the anti-enumeration 404 and starts nothing", async () => {
    const res = await post("/v1/ops/workspace-reconcile", B.ownerToken, {
      teamId: A.teamId,
    });
    // 404, not 403: a 403 confirms the workspace exists to somebody who has
    // no business learning that.
    expect(res.statusCode).toBe(404);
    expect(await runRows(A.teamId)).toBe(0);
  });

  it("an unauthenticated caller starts nothing", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/ops/workspace-reconcile",
      payload: { teamId: A.teamId } as never,
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(await runRows(A.teamId)).toBe(0);
  });

  // =======================================================================
  // A schema-incompatible image refuses rather than producing a second
  // identical failure.
  // =======================================================================

  it("refuses to sweep when the writer contract is unsatisfied, and says a retry cannot fix it", async () => {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "operational_incidents" DROP COLUMN IF EXISTS "runbook_slug"`,
    );
    readiness.resetWriterContractCache();
    try {
      const res = await post("/v1/ops/workspace-reconcile", A.ownerToken, {
        teamId: A.teamId,
      });
      expect(res.statusCode).toBe(503);
      const body = res.json() as {
        started: boolean;
        refusedReason: string;
        retryable: boolean;
      };
      expect(body.started).toBe(false);
      expect(body.refusedReason).toBe("schema_mismatch");
      expect(body.retryable).toBe(false);

      // Nothing was attempted. Running the sweep would have found the same
      // conditions, failed the same writes and left a second identical
      // PARTIAL run — noise that makes the real cause harder to see.
      expect(await runRows(A.teamId)).toBe(0);

      // The refusal carries no SQL, no column name and no table name.
      const raw = res.body;
      expect(raw).not.toContain("runbook_slug");
      expect(raw).not.toContain("operational_incidents");
      expect(raw).not.toContain("SELECT");

      // And the instance takes itself out of rotation rather than claiming
      // it can serve traffic it cannot record conditions for.
      const ready = await harness.app.inject({ method: "GET", url: "/readyz" });
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toMatchObject({
        reason: "operations_writer_schema_mismatch",
      });
    } finally {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "operational_incidents" ADD COLUMN IF NOT EXISTS "runbook_slug" VARCHAR(64)`,
      );
      readiness.resetWriterContractCache();
    }
  });

  it("recovers on its own once the migration lands — no restart required", async () => {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "operational_incidents" DROP COLUMN IF EXISTS "runbook_slug"`,
    );
    readiness.resetWriterContractCache();
    expect((await harness.app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(
      503,
    );

    await prisma.$executeRawUnsafe(
      `ALTER TABLE "operational_incidents" ADD COLUMN IF NOT EXISTS "runbook_slug" VARCHAR(64)`,
    );
    // A FAILING contract result is cached for a much shorter window than a
    // passing one precisely so an instance notices the repair by itself.
    const recovered = await readiness.checkWriterSchemaContract(Date.now() + 60_000);
    expect(recovered.ok).toBe(true);

    const ready = await harness.app.inject({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).toBe(200);
  });
});
