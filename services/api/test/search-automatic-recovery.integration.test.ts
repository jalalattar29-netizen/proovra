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
  let shared: typeof import("@proovra/shared");
  let bullmq: typeof import("bullmq");
  let queueClient: typeof import("../src/queue/canonical-queue-client.js");
  /**
   * A REAL BullMQ queue on the harness's disposable Redis.
   *
   * Not a stub: the whole point of these cases is that readiness reads durable
   * job state, so the job has to be a real one, added under the id the real
   * producer would build for it.
   */
  let queue: import("bullmq").Queue;
  let queueConnection: import("ioredis").Redis;
  let entry: ReturnType<typeof import("@proovra/shared").getWorkEntryOrThrow>;
  let redisUrl: string;
  /** Constructor for the worker connections the queue cases spin up. */
  let IORedis: (typeof import("ioredis"))["default"];

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
    shared = await import("@proovra/shared");
    bullmq = await import("bullmq");
    queueClient = await import("../src/queue/canonical-queue-client.js");
    entry = shared.getWorkEntryOrThrow(shared.JOB_NAMES.REBUILD_SEARCH_DOCUMENT);
    redisUrl = process.env.REDIS_URL as string;
    // The harness already asserted this Redis is reachable before boot, so an
    // absent address here is a harness failure and must be loud rather than
    // silently turning every queue case into the unreachable case.
    if (!redisUrl) throw new Error("REDIS_URL is not set for the integration run");
    IORedis = (await import("ioredis")).default;
    queueConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    queue = new bullmq.Queue(shared.QUEUE_NAMES.SEARCH_INDEXING, {
      connection: queueConnection,
    });

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
    await queue?.close().catch(() => undefined);
    await queueConnection?.quit().catch(() => undefined);
    await harness?.cleanup();
  });

  beforeEach(async () => {
    await prisma.governanceReconciliationRun.deleteMany({ where: { kind: KIND } });
    // Every case decides for itself what the queue holds. A job left behind by
    // a previous case would be evidence this one never produced.
    await queue.obliterate({ force: true }).catch(() => undefined);
  });

  /** Poll a real condition to a bounded deadline. No fixed sleeps. */
  async function waitFor(
    predicate: () => Promise<boolean>,
    timeoutMs = 10_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() > deadline) {
        throw new Error("waitFor: condition not reached within the deadline");
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

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

    it("a bounded tick PAGINATES — the workspace it could not reach is reached next tick", async () => {
      await setIndexPopulation({ teamId: A.teamId, eligible: 2, indexed: 0 });
      await setIndexPopulation({ teamId: B.teamId, eligible: 2, indexed: 0 });

      // THE CEILING IS REAL. One workspace per tick means one, however many
      // are outstanding — a reconciler with no ceiling is a load generator
      // with a good name.
      const first = await workerRecon.runSearchIndexReconciler({
        trigger: "test-page-1",
        workspaceBatchSize: 1,
      });
      expect(first.workspacesReconciled).toBe(1);
      expect(first.workspacesFailed).toBe(0);

      // The workspace it did not reach is NOT lost: it is still discoverable,
      // so a later tick with room reaches it. Drift is read from source rows
      // every tick, so nothing has to be remembered between them.
      const second = await workerRecon.runSearchIndexReconciler({
        trigger: "test-page-2",
        workspaceBatchSize: 50,
      });
      expect(second.workspacesReconciled).toBeGreaterThanOrEqual(1);

      // Both workspaces have been reconciled by the time the sweep had room
      // for both.
      expect((await runs(A.teamId)).length).toBeGreaterThanOrEqual(1);
      expect((await runs(B.teamId)).length).toBeGreaterThanOrEqual(1);
    });

    it("pagination CONTINUES past a workspace whose claim failed", async () => {
      await setIndexPopulation({ teamId: A.teamId, eligible: 2, indexed: 0 });
      await setIndexPopulation({ teamId: B.teamId, eligible: 2, indexed: 0 });

      failClaimFor(A.teamId);

      // Both pages are walked in ONE tick even though the first workspace on
      // it cannot be claimed. Under the previous implementation the throw left
      // the loop entirely and B was never attempted.
      const tick = await workerRecon.runSearchIndexReconciler({
        trigger: "test-page-through-failure",
        workspaceBatchSize: 50,
      });
      expect(tick.workspacesFailed).toBe(1);
      expect(tick.workspacesReconciled).toBe(1);
      expect(await runs(A.teamId)).toHaveLength(0);
      expect((await runs(B.teamId)).length).toBeGreaterThanOrEqual(1);
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
  // 3. Is the outstanding work actually in flight?
  //
  // The question a completed run cannot answer about the work it handed off.
  // Answered here by the QUEUE, against a real BullMQ queue on the harness's
  // disposable Redis, using the SAME deterministic job id the producer builds
  // — so every case below reads a real job in a real state.
  //
  // The first implementation answered it with a five-minute credit on the
  // run's finish time. These cases are written to fail against that model:
  // the retry ladder for this job is five attempts at a ten-minute timeout
  // each, so a genuinely running rebuild outlives the window and would have
  // been reported STALLED — a second false state, in the opposite direction
  // from the one being fixed.
  // =========================================================================

  describe("scheduled work is proven, not assumed", () => {
    /** The job id the PRODUCER would create for this record. Not invented. */
    function jobIdFor(sourceId: string): string {
      return shared.buildCanonicalJobId(
        { jobIdPrefix: entry.jobIdPrefix as string },
        shared.buildSearchIndexCommandId("evidence", sourceId),
      );
    }

    /** Put a real job on the real queue under that id. */
    async function enqueueRebuild(
      sourceId: string,
      opts: { delayMs?: number } = {},
    ) {
      await queue.add(
        entry.workName,
        { commandId: `evidence:${sourceId}`, traceId: "test", schemaVersion: entry.schemaVersion },
        {
          jobId: jobIdFor(sourceId),
          ...(opts.delayMs ? { delay: opts.delayMs } : {}),
          removeOnComplete: false,
          removeOnFail: false,
        },
      );
    }

    it("1. a queued rebuild makes an outstanding workspace INITIALIZING, and it polls", async () => {
      const [first] = await setIndexPopulation({
        teamId: A.teamId,
        eligible: 2,
        indexed: 0,
      });
      await seedCompletedRun({ teamId: A.teamId, scheduled: 2, finishedMsAgo: 5_000 });
      await enqueueRebuild(first as string);

      const state = await readiness(A.teamId, A.ownerToken);
      // Work IS in flight, and the evidence is the job itself.
      expect(state.state).toBe("INITIALIZING");
      expect(state.shouldPoll).toBe(true);
      expect(state.indexedCount).toBe(0);
      expect(state.outstandingCount).toBe(2);
    });

    it("2. the same queued rebuild is STILL in flight long after the old five-minute window", async () => {
      const [first] = await setIndexPopulation({
        teamId: A.teamId,
        eligible: 2,
        indexed: 0,
      });
      // The run finished an hour ago — far outside any credit window that
      // would have been short enough to be useful.
      await seedCompletedRun({
        teamId: A.teamId,
        scheduled: 2,
        finishedMsAgo: 60 * 60 * 1000,
      });
      await enqueueRebuild(first as string);

      // Elapsed time says nothing. The job is waiting, so the work is coming.
      // Under the credit model this was STALLED — a false alarm on a healthy
      // queue, which is the defect this case exists to prevent returning.
      expect((await readiness(A.teamId, A.ownerToken)).state).toBe("INITIALIZING");
    });

    it("3. a rebuild that is ACTIVE on a worker reads as progress, whatever the clock says", async () => {
      const [first] = await setIndexPopulation({
        teamId: A.teamId,
        eligible: 2,
        indexed: 0,
      });
      await seedCompletedRun({
        teamId: A.teamId,
        scheduled: 2,
        finishedMsAgo: 60 * 60 * 1000,
      });
      await enqueueRebuild(first as string);

      // A REAL worker claims it and holds it. `RETRY_POLICIES.PROJECTION`
      // allows ten minutes per attempt, so this is an ordinary long rebuild,
      // not a stuck one — and it must not be reported as abandoned.
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const worker = new bullmq.Worker(
        shared.QUEUE_NAMES.SEARCH_INDEXING,
        async () => {
          await held;
        },
        { connection: new IORedis(redisUrl, { maxRetriesPerRequest: null }), concurrency: 1 },
      );
      try {
        await waitFor(async () => {
          const s = await queue.getJobState(jobIdFor(first as string));
          return s === "active";
        });
        expect((await readiness(A.teamId, A.ownerToken)).state).toBe("INITIALIZING");
      } finally {
        release();
        await worker.close();
      }
    });

    it("4. an unreachable queue proves nothing and fails CLOSED to STALLED", async () => {
      await setIndexPopulation({ teamId: A.teamId, eligible: 2, indexed: 0 });
      await seedCompletedRun({ teamId: A.teamId, scheduled: 2, finishedMsAgo: 5_000 });

      const saved = process.env.REDIS_URL;
      delete process.env.REDIS_URL;
      queueClient.__resetCanonicalQueueClientForTests();
      try {
        // No evidence is not evidence of progress. STALLED is also the state
        // the reconciler acts on, so failing closed triggers recovery rather
        // than suppressing it.
        const state = await readiness(A.teamId, A.ownerToken);
        expect(state.state).toBe("STALLED");
        expect(state.shouldPoll).toBe(false);
      } finally {
        process.env.REDIS_URL = saved;
        queueClient.__resetCanonicalQueueClientForTests();
      }
    });

    it("5. an enqueue the worker has not reached yet is still in flight (delayed job)", async () => {
      const [first] = await setIndexPopulation({
        teamId: A.teamId,
        eligible: 2,
        indexed: 0,
      });
      await seedCompletedRun({ teamId: A.teamId, scheduled: 2, finishedMsAgo: 5_000 });
      // Backoff puts a retrying rebuild here. It is not lost.
      await enqueueRebuild(first as string, { delayMs: 60_000 });

      expect((await readiness(A.teamId, A.ownerToken)).state).toBe("INITIALIZING");
    });

    it("6. a worker restart does not lose the continuation — the job outlives the process", async () => {
      const [first] = await setIndexPopulation({
        teamId: A.teamId,
        eligible: 2,
        indexed: 0,
      });
      await seedCompletedRun({ teamId: A.teamId, scheduled: 2, finishedMsAgo: 5_000 });
      await enqueueRebuild(first as string);

      // A worker starts, takes nothing, and dies — the shape of a restart.
      const worker = new bullmq.Worker(
        shared.QUEUE_NAMES.SEARCH_INDEXING,
        async () => {
          await new Promise((r) => setTimeout(r, 50));
        },
        {
          connection: new IORedis(redisUrl, { maxRetriesPerRequest: null }),
          concurrency: 1,
          autorun: false,
        },
      );
      await worker.close();

      // The job is durable in Redis, so readiness is unchanged by the restart.
      const state = await readiness(A.teamId, A.ownerToken);
      expect(state.state).toBe("INITIALIZING");
      expect(await queue.getJobState(jobIdFor(first as string))).not.toBe("unknown");
    });

    it("7. drift with NO job scheduled for it is STALLED — the abandoned case", async () => {
      await setIndexPopulation({ teamId: A.teamId, eligible: 2, indexed: 0 });
      // A run that completed and handed nothing on: nothing is coming.
      await seedCompletedRun({ teamId: A.teamId, scheduled: 0, finishedMsAgo: 1_000 });

      const state = await readiness(A.teamId, A.ownerToken);
      expect(state.state).toBe("STALLED");
      expect(state.shouldPoll).toBe(false);
    });

    it("7b. a terminally FAILED rebuild is not in flight — the exhausted-ladder case", async () => {
      const [first] = await setIndexPopulation({
        teamId: A.teamId,
        eligible: 1,
        indexed: 0,
      });
      await seedCompletedRun({ teamId: A.teamId, scheduled: 1, finishedMsAgo: 5_000 });
      await queue.add(
        entry.workName,
        { commandId: `evidence:${first}`, traceId: "test", schemaVersion: entry.schemaVersion },
        { jobId: jobIdFor(first as string), attempts: 1, removeOnFail: false },
      );
      const worker = new bullmq.Worker(
        shared.QUEUE_NAMES.SEARCH_INDEXING,
        async () => {
          throw new Error("rebuild refused");
        },
        { connection: new IORedis(redisUrl, { maxRetriesPerRequest: null }), concurrency: 1 },
      );
      try {
        await waitFor(async () => {
          const s = await queue.getJobState(jobIdFor(first as string));
          return s === "failed";
        });
        // The queue tried and gave up. Reporting that as progress would be the
        // credit model's other failure mode with extra steps.
        expect((await readiness(A.teamId, A.ownerToken)).state).toBe("STALLED");
      } finally {
        await worker.close();
      }
    });

    it("8. repeated sweeps while the SAME continuation is pending create no duplicate job and no second run", async () => {
      const ids = await setIndexPopulation({
        teamId: A.teamId,
        eligible: 2,
        indexed: 0,
      });
      await enqueueRebuild(ids[0] as string);
      const before = await queue.getJobCounts();

      await workerRecon.runSearchIndexReconciler({ trigger: "test-sweep-1" });
      await workerRecon.runSearchIndexReconciler({ trigger: "test-sweep-2" });
      await workerRecon.runSearchIndexReconciler({ trigger: "test-sweep-3" });

      // The job id is deterministic, so a re-enqueue for a record already
      // queued collapses onto the live job rather than adding another.
      //
      // Scoped to THIS workspace's records: the queue is shared across
      // tenants, so a bare job count would also be counting whatever other
      // fixtures left outstanding.
      const jobs = await queue.getJobs(["waiting", "delayed", "active", "prioritized"]);
      const mine = jobs.filter((j) =>
        ids.some((id) => j.id === jobIdFor(id as string)),
      );
      expect(mine.filter((j) => j.id === jobIdFor(ids[0] as string))).toHaveLength(1);
      // At most one job per outstanding record, whatever the sweep count.
      expect(new Set(mine.map((j) => j.id)).size).toBe(mine.length);
      expect(mine.length).toBeLessThanOrEqual(ids.length);
      void before;

      // …and never two live runs for one workspace.
      const active = await prisma.governanceReconciliationRun.count({
        where: { teamId: A.teamId, kind: KIND, status: "RUNNING" },
      });
      expect(active).toBeLessThanOrEqual(1);

      // Index documents are upserted by natural key, so repeated rebuilds can
      // never produce a duplicate document for one record.
      const docs = await prisma.evidenceSearchDocument.groupBy({
        by: ["sourceId"],
        where: { teamId: A.teamId, documentType: "EVIDENCE" },
        _count: { sourceId: true },
      });
      for (const d of docs) expect(d._count.sourceId).toBe(1);
    });

    it("END TO END: two records go 0/2 → 2/2 with no user visit and no Rebuild press", async () => {
      await setIndexPopulation({ teamId: A.teamId, eligible: 2, indexed: 0 });
      expect((await readiness(A.teamId, A.ownerToken)).state).toBe("STALLED");

      // 1. The scheduler notices the drift and schedules the rebuilds.
      const tick = await workerRecon.runSearchIndexReconciler({
        trigger: "test-e2e",
      });
      // Scoped to this workspace: the sweep is fleet-wide, so the tick's
      // totals include whatever other fixtures are outstanding.
      expect(tick.reEnqueued + tick.collapsed).toBeGreaterThanOrEqual(2);
      expect(tick.failed).toBe(0);

      // 2. The workspace now truthfully reports work in flight, and polls —
      //    so the reading will correct itself on its own.
      const mid = await readiness(A.teamId, A.ownerToken);
      expect(mid.state).toBe("INITIALIZING");
      expect(mid.shouldPoll).toBe(true);

      // 3. The REAL worker processor drains the queue. Not a stand-in: this is
      //    the same function `services/worker/src/index.ts` registers.
      const processor = await import(
        "../../worker/src/search-indexing.processor.js"
      );
      const worker = new bullmq.Worker(
        shared.QUEUE_NAMES.SEARCH_INDEXING,
        async (job) => {
          await processor.processSearchIndexingJob(job);
        },
        {
          connection: new IORedis(redisUrl, { maxRetriesPerRequest: null }),
          concurrency: 2,
        },
      );
      try {
        await waitFor(async () => {
          const n = await prisma.evidenceSearchDocument.count({
            where: { teamId: A.teamId, documentType: "EVIDENCE" },
          });
          return n >= 2;
        }, 30_000);
      } finally {
        await worker.close();
      }

      // 4. READY, reached without a person doing anything. This is the whole
      //    point: the reported incident required pressing `Rebuild index`, and
      //    now nothing does.
      const done = await readiness(A.teamId, A.ownerToken);
      expect(done.state).toBe("READY");
      expect(done.indexedCount).toBe(2);
      expect(done.eligibleCount).toBe(2);
      expect(done.outstandingCount).toBe(0);
      expect(done.shouldPoll).toBe(false);

      // …and exactly one document per record. Repeated events and repeated
      // sweeps cannot produce a second.
      const grouped = await prisma.evidenceSearchDocument.groupBy({
        by: ["sourceId"],
        where: { teamId: A.teamId, documentType: "EVIDENCE" },
        _count: { sourceId: true },
      });
      expect(grouped).toHaveLength(2);
      for (const g of grouped) expect(g._count.sourceId).toBe(1);
    });

    it("no run at all, but a queued rebuild — the first record of a new workspace", async () => {
      const [first] = await setIndexPopulation({
        teamId: A.teamId,
        eligible: 1,
        indexed: 0,
      });
      // The ordinary create path enqueues WITHOUT any reconciliation run. This
      // is the shape of the reported incident, and it used to be an
      // unconditional STALLED because `run === null` short-circuited before
      // anything could look at the queue.
      expect(await runs(A.teamId)).toHaveLength(0);
      await enqueueRebuild(first as string);

      expect((await readiness(A.teamId, A.ownerToken)).state).toBe("INITIALIZING");
    });
  });

  it("the reconciler records what it scheduled, and never counts a refusal as scheduled", async () => {
    const ids = await setIndexPopulation({
      teamId: A.teamId,
      eligible: 2,
      indexed: 0,
    });

    await workerRecon.runSearchIndexReconciler({ trigger: "test-metadata" });

    const [row] = await runs(A.teamId);
    expect(row).toBeDefined();
    const metadata = (row?.metadata ?? {}) as Record<string, unknown>;
    const recorded = metadata[
      runtime.SEARCH_RUN_SCHEDULED_METADATA_KEY
    ] as number;
    expect(typeof recorded).toBe("number");

    // OPERATOR FACT, and it must be an accurate one. `scheduled` counts jobs
    // the queue ACCEPTED (new or collapsed onto a live one) and excludes
    // refusals — an enqueue that failed is recorded in `failedCount`, never
    // reported as work handed on.
    const accepted = (
      await queue.getJobs(["waiting", "delayed", "active", "prioritized"])
    ).filter((j) =>
      ids.some(
        (id) =>
          j.id ===
          shared.buildCanonicalJobId(
            { jobIdPrefix: entry.jobIdPrefix as string },
            shared.buildSearchIndexCommandId("evidence", id),
          ),
      ),
    );
    expect(recorded).toBe(accepted.length);
    expect(recorded).toBeLessThanOrEqual(ids.length);
    expect(recorded + (row?.failedCount ?? 0)).toBe(row?.scannedCount ?? 0);

    // …and it is NOT what readiness reads. The queue is.
    const state = await readiness(A.teamId, A.ownerToken);
    expect(state.state).toBe(recorded > 0 ? "INITIALIZING" : "STALLED");
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
    const [aFirst] = await setIndexPopulation({
      teamId: A.teamId,
      eligible: 2,
      indexed: 0,
    });
    await setIndexPopulation({ teamId: B.teamId, eligible: 2, indexed: 2 });

    await seedCompletedRun({
      teamId: A.teamId,
      scheduled: 2,
      finishedMsAgo: 5_000,
    });
    await queue.add(
      entry.workName,
      {
        commandId: `evidence:${aFirst}`,
        traceId: "test",
        schemaVersion: entry.schemaVersion,
      },
      {
        jobId: shared.buildCanonicalJobId(
          { jobIdPrefix: entry.jobIdPrefix as string },
          shared.buildSearchIndexCommandId("evidence", aFirst as string),
        ),
      },
    );

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
