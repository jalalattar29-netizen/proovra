/**
 * Search recovers WITHOUT a user pressing anything. (live PostgreSQL 16)
 *
 * WHAT THIS SUITE EXISTS TO PROVE
 * ---------------------------------------------------------------------------
 * A production workspace with two records sat at `STALLED — 0 of 2`, with no
 * reconciliation run of any kind ever recorded against it, until a person
 * found `Rebuild index` and pressed it. Three separate defects had to line up
 * for that, and this suite drives all three against a real database:
 *
 *   1. THE SWEEP DIED AT ITS FIRST WORKSPACE. `reconcileSearchIndex` does two
 *      things before the caller's body runs — it reads for a stale lock and
 *      then INSERTs the claim row — and neither was inside any per-workspace
 *      error boundary. A database that could not accept the claim (in
 *      production: a `GovernanceReconciliationKind` enum deployed without its
 *      `SEARCH_INDEX` value) therefore threw straight out of the per-workspace
 *      loop and ended the whole tick. Every workspace after the first was
 *      never even attempted, and no run row could be written for any of them
 *      — which is why the readiness projection saw `run: null` and, correctly
 *      under its own rules, said STALLED.
 *
 *   2. THE FAILURE WAS UNOBSERVABLE. `runSearchIndexReconciler` catches its
 *      own discovery failure and RETURNS `ok: false` rather than throwing, so
 *      the caller's `try/catch` — the only thing wired to Sentry — never
 *      fired. A dead sweep produced one log line per tick and no alert.
 *
 *   3. A HEALTHY TICK STILL READ AS STALLED. The scheduler converges by
 *      ENQUEUEING, so its run closes SUCCEEDED in milliseconds while the index
 *      is still empty. Readiness saw a completed run with drift remaining and
 *      called it STALLED — a state that does not poll — so the reading never
 *      corrected itself even as the queue drained.
 *
 * Nothing here reimplements a production decision. The tick is the real
 * scheduler entry point, the run rows are written by the real wrapper, and
 * every readiness state comes out of the real diagnostics endpoint.
 */

import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("Search automatic recovery (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let workerPrisma: (typeof import("../../worker/src/db.js"))["prisma"];
  let runtime: typeof import("@proovra/shared-runtime");
  let workerRecon: typeof import("../../worker/src/search-index-reconciler.js");

  let A: { teamId: string; ownerToken: string; ownerUserId: string };
  let B: { teamId: string; ownerToken: string };

  const KIND = "SEARCH_INDEX" as const;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    runtime = await import("@proovra/shared-runtime");
    runtime.registerPrisma(prisma as never);
    workerRecon = await import("../../worker/src/search-index-reconciler.js");
    ({ prisma: workerPrisma } = await import("../../worker/src/db.js"));

    A = {
      teamId: harness.fixtures.teamA.teamId,
      ownerToken: harness.fixtures.teamA.ownerToken,
      ownerUserId: harness.fixtures.teamA.ownerUserId,
    };
    B = {
      teamId: harness.fixtures.teamB.teamId,
      ownerToken: harness.fixtures.teamB.ownerToken,
    };
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  beforeEach(async () => {
    await prisma.governanceReconciliationRun.deleteMany({ where: { kind: KIND } });
  });

  // =========================================================================
  // Helpers
  // =========================================================================

  async function runs(teamId: string) {
    return prisma.governanceReconciliationRun.findMany({
      where: { teamId, kind: KIND },
      orderBy: { startedAtUtc: "asc" },
    });
  }

  /** The REAL readiness projection, from the real diagnostics endpoint. */
  async function readiness(
    teamId: string,
    token: string,
  ): Promise<Record<string, unknown>> {
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/search/diagnostics?teamId=${teamId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { readiness: Record<string, unknown> }).readiness;
  }

  /**
   * Put the workspace into the shape the production incident had: N eligible
   * evidence rows, M of them represented in the index, and the sources settled
   * long enough ago that the reconciler's grace window has passed.
   */
  async function setIndexPopulation(input: {
    teamId: string;
    eligible: number;
    indexed: number;
    /** How long ago the sources last changed. Past the grace window by default. */
    settledMsAgo?: number;
  }): Promise<string[]> {
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: input.teamId },
      select: { organizationId: true },
    });
    await prisma.evidenceSearchDocument.deleteMany({
      where: { teamId: input.teamId },
    });
    await prisma.evidence.updateMany({
      where: { teamId: input.teamId },
      data: { lifecycleState: "DESTROYED" },
    });

    const settled = new Date(
      Date.now() - (input.settledMsAgo ?? 48 * 60 * 60 * 1000),
    );
    const ids: string[] = [];
    for (let i = 0; i < input.eligible; i += 1) {
      const row = await prisma.evidence.create({
        data: {
          title: `auto-recovery-${randomUUID()}`,
          type: "PHOTO",
          status: "CREATED",
          teamId: input.teamId,
          organizationId: team.organizationId,
          ownerUserId: harness.fixtures.teamA.ownerUserId,
          lifecycleState: "ACTIVE",
        },
        select: { id: true },
      });
      ids.push(row.id);
    }
    // `updated_at` is `@updatedAt`, so it has to be set out of band for the
    // drift selector to see these rows as settled rather than in-flight.
    if (ids.length > 0) {
      await prisma.$executeRawUnsafe(
        `UPDATE "evidence" SET "updated_at" = $1 WHERE "id" = ANY($2::uuid[])`,
        settled,
        ids,
      );
    }
    for (let i = 0; i < input.indexed; i += 1) {
      await prisma.evidenceSearchDocument.create({
        data: {
          teamId: input.teamId,
          documentType: "EVIDENCE",
          sourceId: ids[i] as string,
          title: `doc-${i}`,
          indexedAtUtc: new Date(),
          sourceUpdatedAtUtc: settled,
        },
      });
    }
    return ids;
  }

  /** A completed run row, optionally recording scheduled follow-on work. */
  async function seedCompletedRun(input: {
    teamId: string;
    scheduled: number;
    finishedMsAgo: number;
    status?: "SUCCEEDED" | "PARTIAL" | "FAILED";
    errorSummary?: string;
  }) {
    const finished = new Date(Date.now() - input.finishedMsAgo);
    return prisma.governanceReconciliationRun.create({
      data: {
        kind: KIND,
        status: input.status ?? "SUCCEEDED",
        teamId: input.teamId,
        trigger: "scheduler",
        lockKey: runtime.searchIndexLockKey(input.teamId),
        startedAtUtc: new Date(finished.getTime() - 1000),
        finishedAtUtc: finished,
        errorSummary: input.errorSummary ?? null,
        metadata:
          input.scheduled > 0
            ? { [runtime.SEARCH_RUN_SCHEDULED_METADATA_KEY]: input.scheduled }
            : undefined,
      },
      select: { id: true },
    });
  }

  // =========================================================================
  // 1. One workspace's claim failure must not end the sweep
  // =========================================================================

  describe("a database that cannot accept the claim", () => {
    const originalCreate = { fn: null as unknown };

    afterEach(() => {
      if (originalCreate.fn) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (workerPrisma.governanceReconciliationRun as any).create =
          originalCreate.fn;
        originalCreate.fn = null;
      }
    });

    /**
     * Reproduce the PRODUCTION failure exactly: the claim INSERT rejects with
     * the Postgres enum error that Sentry recorded, for ONE workspace.
     *
     * The rejection is injected at the claim, not inside the body, because
     * that is where the real one happened and it is the only place that used
     * to be outside every error boundary. Anything injected into the body
     * would be caught by the run wrapper and would prove nothing.
     */
    function failClaimFor(teamIdToFail: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const target = workerPrisma.governanceReconciliationRun as any;
      originalCreate.fn = target.create.bind(
        workerPrisma.governanceReconciliationRun,
      );
      const real = originalCreate.fn as (args: unknown) => Promise<unknown>;
      target.create = async (args: { data?: { teamId?: string } }) => {
        if (args?.data?.teamId === teamIdToFail) {
          throw new Error(
            'invalid input value for enum "GovernanceReconciliationKind": "SEARCH_INDEX"',
          );
        }
        return real(args);
      };
    }

    it("fails that workspace only, records it, and still reconciles the others", async () => {
      await setIndexPopulation({ teamId: A.teamId, eligible: 2, indexed: 0 });
      await setIndexPopulation({ teamId: B.teamId, eligible: 2, indexed: 0 });

      failClaimFor(A.teamId);

      // MUST NOT THROW. The old loop propagated this straight out of the tick.
      const tick = await workerRecon.runSearchIndexReconciler({
        trigger: "test-enum-incompat",
      });

      expect(tick.workspacesFailed).toBeGreaterThanOrEqual(1);
      // The workspace whose claim was accepted was still reached — the failure
      // of the other did not abandon it.
      expect(tick.workspacesReconciled).toBeGreaterThanOrEqual(1);

      // A has no run row, because its claim could not be written. That is the
      // production state, and it is now REACHED without stopping the sweep.
      expect(await runs(A.teamId)).toHaveLength(0);
      // B does, and it completed.
      const bRuns = await runs(B.teamId);
      expect(bRuns.length).toBeGreaterThanOrEqual(1);
      expect(bRuns.at(-1)?.status).not.toBe("RUNNING");
    });

    it("a tick where NO workspace could be claimed reports itself unhealthy", async () => {
      await setIndexPopulation({ teamId: A.teamId, eligible: 2, indexed: 0 });
      await prisma.evidenceSearchDocument.deleteMany({
        where: { teamId: B.teamId },
      });
      await prisma.evidence.updateMany({
        where: { teamId: B.teamId },
        data: { lifecycleState: "DESTROYED" },
      });

      failClaimFor(A.teamId);

      const tick = await workerRecon.runSearchIndexReconciler({
        trigger: "test-enum-incompat-total",
      });

      // `ok: false` is what the worker's tick wrapper escalates on. Before
      // this, a totally dead sweep returned `ok: true` with silent zeros and
      // nothing was ever raised.
      expect(tick.ok).toBe(false);
      expect(tick.error).toBe("workspace_claims_failed");
      expect(tick.workspacesReconciled).toBe(0);
      expect(tick.workspacesFailed).toBeGreaterThanOrEqual(1);
    });

    it("recovers on the very next tick once the database is compatible again", async () => {
      await setIndexPopulation({ teamId: A.teamId, eligible: 2, indexed: 0 });

      failClaimFor(A.teamId);
      const broken = await workerRecon.runSearchIndexReconciler({
        trigger: "test-before-migration",
      });
      expect(broken.workspacesFailed).toBeGreaterThanOrEqual(1);
      expect(await runs(A.teamId)).toHaveLength(0);

      // The migration lands. Nothing else changes — no restart, no user visit.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (workerPrisma.governanceReconciliationRun as any).create =
        originalCreate.fn;
      originalCreate.fn = null;

      const healed = await workerRecon.runSearchIndexReconciler({
        trigger: "test-after-migration",
      });
      expect(healed.workspacesReconciled).toBeGreaterThanOrEqual(1);
      const after = await runs(A.teamId);
      expect(after).toHaveLength(1);
      expect(after[0]?.status).not.toBe("RUNNING");
      expect(after[0]?.trigger).toBe("scheduler");
    });
  });

  // =========================================================================
  // 2. Drift with no run at all is picked up automatically
  // =========================================================================

  it("a 0/N workspace with NO run history is claimed by the scheduler with no user action", async () => {
    await setIndexPopulation({ teamId: A.teamId, eligible: 2, indexed: 0 });

    // The exact production reading, before anything runs.
    const before = await readiness(A.teamId, A.ownerToken);
    expect(before.eligibleCount).toBe(2);
    expect(before.indexedCount).toBe(0);
    expect(before.runStatus).toBeNull();
    expect(before.state).toBe("STALLED");

    await workerRecon.runSearchIndexReconciler({ trigger: "test-auto" });

    const recorded = await runs(A.teamId);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.trigger).toBe("scheduler");
    expect(recorded[0]?.scannedCount).toBeGreaterThanOrEqual(2);
  });

  it("an EMPTY workspace is EMPTY_WORKSPACE and is never claimed", async () => {
    await setIndexPopulation({ teamId: A.teamId, eligible: 0, indexed: 0 });

    const state = await readiness(A.teamId, A.ownerToken);
    expect(state.state).toBe("EMPTY_WORKSPACE");
    expect(state.eligibleCount).toBe(0);

    await workerRecon.runSearchIndexReconciler({ trigger: "test-empty" });

    // Nothing outstanding means nothing to claim. A run row here would be a
    // permanent, unfixable "work in progress" signal on an empty workspace.
    expect(await runs(A.teamId)).toHaveLength(0);
  });

  it("a converged workspace is READY and is left alone", async () => {
    await setIndexPopulation({ teamId: A.teamId, eligible: 2, indexed: 2 });

    expect((await readiness(A.teamId, A.ownerToken)).state).toBe("READY");
    await workerRecon.runSearchIndexReconciler({ trigger: "test-converged" });
    expect(await runs(A.teamId)).toHaveLength(0);
  });

  // =========================================================================
  // 3. A completed run that scheduled work is not STALLED
  // =========================================================================

  it("a completed run holding scheduled work reports INITIALIZING, and polls", async () => {
    await setIndexPopulation({ teamId: A.teamId, eligible: 2, indexed: 0 });
    await seedCompletedRun({
      teamId: A.teamId,
      scheduled: 2,
      finishedMsAgo: 5_000,
    });

    const state = await readiness(A.teamId, A.ownerToken);
    // Work IS assigned and the evidence for that is on the run row. Calling
    // this STALLED told a user with a healthy system that their records would
    // never appear — and STALLED does not poll, so the reading could not
    // correct itself when the queue drained a second later.
    expect(state.state).toBe("INITIALIZING");
    expect(state.shouldPoll).toBe(true);
    // …and it is still honest about what is indexed.
    expect(state.indexedCount).toBe(0);
    expect(state.outstandingCount).toBe(2);
  });

  it("PARTIAL when some records are already searchable", async () => {
    await setIndexPopulation({ teamId: A.teamId, eligible: 3, indexed: 1 });
    await seedCompletedRun({
      teamId: A.teamId,
      scheduled: 2,
      finishedMsAgo: 5_000,
    });

    const state = await readiness(A.teamId, A.ownerToken);
    expect(state.state).toBe("PARTIAL");
    expect(state.shouldPoll).toBe(true);
    expect(state.indexedCount).toBe(1);
  });

  it("the credit EXPIRES — scheduled work that never landed reverts to STALLED", async () => {
    await setIndexPopulation({ teamId: A.teamId, eligible: 2, indexed: 0 });
    await seedCompletedRun({
      teamId: A.teamId,
      scheduled: 2,
      finishedMsAgo: runtime.SEARCH_CONTINUATION_CREDIT_MS + 60_000,
    });

    // The bounded half of the claim. Without it, one tick's enqueue would let
    // a queue nobody consumes report "still working" forever — the exact class
    // of unfalsifiable reassurance the readiness model exists to remove.
    const state = await readiness(A.teamId, A.ownerToken);
    expect(state.state).toBe("STALLED");
    expect(state.shouldPoll).toBe(false);
  });

  it("a completed run that scheduled NOTHING is STALLED immediately", async () => {
    await setIndexPopulation({ teamId: A.teamId, eligible: 2, indexed: 0 });
    await seedCompletedRun({
      teamId: A.teamId,
      scheduled: 0,
      finishedMsAgo: 1_000,
    });

    // Drift remains and the run assigned no work to close it. There is no
    // honest reading other than STALLED.
    expect((await readiness(A.teamId, A.ownerToken)).state).toBe("STALLED");
  });

  it("the reconciler RECORDS what it scheduled, so the next read can credit it", async () => {
    await setIndexPopulation({ teamId: A.teamId, eligible: 2, indexed: 0 });

    await workerRecon.runSearchIndexReconciler({ trigger: "test-metadata" });

    const [row] = await runs(A.teamId);
    expect(row).toBeDefined();
    const metadata = (row?.metadata ?? {}) as Record<string, unknown>;
    // The counter is present on the row whether or not the queue accepted the
    // jobs — a durable statement about what this run handed on, which is what
    // readiness reads instead of guessing from silence.
    expect(
      Object.prototype.hasOwnProperty.call(
        metadata,
        runtime.SEARCH_RUN_SCHEDULED_METADATA_KEY,
      ),
    ).toBe(true);
    expect(
      typeof metadata[runtime.SEARCH_RUN_SCHEDULED_METADATA_KEY],
    ).toBe("number");
  });

  // =========================================================================
  // 4. Nothing internal reaches the browser
  // =========================================================================

  it("a raw database error on the run row never becomes the user-facing reason", async () => {
    await setIndexPopulation({ teamId: A.teamId, eligible: 2, indexed: 0 });
    await seedCompletedRun({
      teamId: A.teamId,
      scheduled: 0,
      finishedMsAgo: 1_000,
      status: "FAILED",
      errorSummary:
        'invalid input value for enum "GovernanceReconciliationKind": "SEARCH_INDEX"',
    });

    const state = await readiness(A.teamId, A.ownerToken);
    expect(state.state).toBe("FAILED");
    const reason = String(state.failureReason ?? "");
    // The run row KEEPS the detail — an operator needs it. The wire gets a
    // bounded category. This projection used to hand the Postgres message
    // straight through to the browser.
    expect(reason).not.toMatch(/enum/i);
    expect(reason).not.toMatch(/GovernanceReconciliationKind/);
    expect(reason).not.toMatch(/invalid input value/i);
    expect(reason.length).toBeGreaterThan(0);

    const row = await prisma.governanceReconciliationRun.findFirstOrThrow({
      where: { teamId: A.teamId, kind: KIND },
      select: { errorSummary: true },
    });
    expect(row.errorSummary).toMatch(/GovernanceReconciliationKind/);
  });

  it("the readiness projection never carries a run id, lock key or trigger user", async () => {
    await setIndexPopulation({ teamId: A.teamId, eligible: 2, indexed: 0 });
    await seedCompletedRun({
      teamId: A.teamId,
      scheduled: 2,
      finishedMsAgo: 5_000,
    });
    const state = await readiness(A.teamId, A.ownerToken);
    const serialized = JSON.stringify(state);
    expect(serialized).not.toMatch(/lockKey|lock_key/);
    expect(serialized).not.toMatch(runtime.searchIndexLockKey(A.teamId));
    expect(state).not.toHaveProperty("runId");
    expect(state).not.toHaveProperty("triggeredByUserId");
  });

  // =========================================================================
  // 5. Reads are reads
  // =========================================================================

  it("GET /v1/search/diagnostics mutates nothing", async () => {
    await setIndexPopulation({ teamId: A.teamId, eligible: 2, indexed: 1 });

    const docsBefore = await prisma.evidenceSearchDocument.count({
      where: { teamId: A.teamId },
    });
    const runsBefore = await prisma.governanceReconciliationRun.count();

    for (let i = 0; i < 3; i += 1) {
      await readiness(A.teamId, A.ownerToken);
    }

    expect(
      await prisma.evidenceSearchDocument.count({ where: { teamId: A.teamId } }),
    ).toBe(docsBefore);
    // Reading readiness must never START indexing. A GET that schedules work
    // makes the diagnosis change the thing it is diagnosing.
    expect(await prisma.governanceReconciliationRun.count()).toBe(runsBefore);
  });

  // =========================================================================
  // 6. Tenant isolation
  // =========================================================================

  it("one workspace's run never changes another workspace's readiness", async () => {
    await setIndexPopulation({ teamId: A.teamId, eligible: 2, indexed: 0 });
    await setIndexPopulation({ teamId: B.teamId, eligible: 2, indexed: 2 });

    await seedCompletedRun({
      teamId: A.teamId,
      scheduled: 2,
      finishedMsAgo: 5_000,
    });

    expect((await readiness(A.teamId, A.ownerToken)).state).toBe("INITIALIZING");
    // B is converged and has no run of its own. A's scheduled work is not
    // evidence about B, and the run query is tenant-bound in SQL.
    const bState = await readiness(B.teamId, B.ownerToken);
    expect(bState.state).toBe("READY");
    expect(bState.runStatus).toBeNull();
  });

  it("a member of one workspace cannot read another workspace's readiness", async () => {
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/search/diagnostics?teamId=${B.teamId}`,
      headers: { authorization: `Bearer ${A.ownerToken}` },
    });
    // Anti-enumerating: a refusal, never a state and never a count.
    expect([403, 404]).toContain(res.statusCode);
    expect(res.body).not.toMatch(/eligibleCount/);
  });
});
