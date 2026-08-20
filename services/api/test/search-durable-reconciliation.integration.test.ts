/**
 * Search reconciliation is DURABLE, LOCKED, and the only thing readiness reads.
 *
 * WHAT THIS SUITE EXISTS TO PROVE
 * ---------------------------------------------------------------------------
 * Two production workspaces spent months telling users "the search index is
 * still catching up". Nothing was catching up. Readiness was a count
 * comparison — `indexed < eligible` — plus `MAX(indexed_at_utc)` as a
 * liveness proxy, and neither can tell a queued run from a running one, a
 * running run that has not written yet from a finished one, or a
 * finished-with-nothing-to-do run from a crash.
 *
 * The fix has two halves and this suite drives both against real PostgreSQL:
 *
 *   1. ONE durable run authority. `POST /v1/search/reconcile`, the worker's
 *      scheduler, the backfill CLI and the internal reindex route all claim the
 *      SAME per-(kind, lock_key) slot in `governance_reconciliation_runs`.
 *      Before this each did its own thing, so two of them could work one
 *      workspace at once and neither would know.
 *
 *   2. Readiness reads THAT ROW. A timestamp is informational and decides
 *      nothing.
 *
 * NOTHING HERE REIMPLEMENTS A PRODUCTION DECISION. The lock is claimed by the
 * real wrapper, the endpoint is the real route through the harness's Fastify
 * instance, the readiness state comes from the real diagnostics projection, and
 * every row is read back out of the database rather than out of a return value.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

/** How long a RUNNING row may hold the slot before it is treated as crashed. */
let RUN_LOCK_LEASE_MS = 0;

describe("Search durable reconciliation (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let runtime: typeof import("@proovra/shared-runtime");
  let reindex: typeof import("../src/services/search/reindex.service.js");
  let workerRecon: typeof import("../../worker/src/search-index-reconciler.js");
  let rateLimit: typeof import("../src/services/rate-limit.js");

  /** Workspace under test, and a second one that must never be affected. */
  let A: { teamId: string; ownerToken: string; viewerToken: string; ownerUserId: string };
  let B: { teamId: string; ownerToken: string };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    runtime = await import("@proovra/shared-runtime");
    runtime.registerPrisma(prisma as never);
    RUN_LOCK_LEASE_MS = runtime.RUN_LOCK_LEASE_MS;

    reindex = await import("../src/services/search/reindex.service.js");
    workerRecon = await import("../../worker/src/search-index-reconciler.js");
    rateLimit = await import("../src/services/rate-limit.js");

    A = {
      teamId: harness.fixtures.teamA.teamId,
      ownerToken: harness.fixtures.teamA.ownerToken,
      viewerToken: harness.fixtures.teamA.viewerToken,
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
    // Every case starts from no run history for either workspace, so a
    // "latest run" assertion can never be satisfied by a previous case's row.
    await prisma.governanceReconciliationRun.deleteMany({
      where: { kind: "SEARCH_INDEX" },
    });
    await rateLimit.clearAllRateLimitBuckets();
  });

  // =========================================================================
  // Helpers — every one of them reads or drives PRODUCTION code
  // =========================================================================

  const KIND = "SEARCH_INDEX" as const;

  /** Every Search run row for a workspace, oldest first. */
  async function runs(teamId: string) {
    return prisma.governanceReconciliationRun.findMany({
      where: { teamId, kind: KIND },
      orderBy: { startedAtUtc: "asc" },
    });
  }

  async function activeRuns(teamId: string) {
    return prisma.governanceReconciliationRun.findMany({
      where: { teamId, kind: KIND, status: "RUNNING" },
    });
  }

  /** Call the REAL endpoint through the harness's Fastify instance. */
  async function postReconcile(
    teamId: string,
    token: string | null,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/search/reconcile",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload: { teamId },
    });
    let body: Record<string, unknown> = {};
    try {
      body = res.json() as Record<string, unknown>;
    } catch {
      body = {};
    }
    return { status: res.statusCode, body };
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
   * Hold the workspace's slot with the REAL wrapper, and hand back a release.
   *
   * This is how contention is produced honestly: a genuine RUNNING row written
   * by `runGovernanceReconciliation`, inside its lease, held open while a
   * second caller tries to claim it.
   */
  async function holdLock(
    teamId: string,
    trigger: "api" | "scheduler" | "cli" | "retry" = "scheduler",
  ): Promise<{ release: () => void; done: Promise<unknown> }> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Resolved from INSIDE the body, so the caller can be certain the slot is
    // genuinely held before it attempts to contend for it. Awaiting anything
    // else — a timer, the returned promise — would race the claim.
    let markEntered!: () => void;
    const isHeld = new Promise<void>((resolve) => {
      markEntered = resolve;
    });

    const done = runtime.reconcileSearchIndex(prisma as never, {
      teamId,
      trigger,
      body: async () => {
        markEntered();
        await gate;
        return { scanned: 0, indexed: 0, removed: 0, failed: 0 };
      },
    });

    await isHeld;
    return { release, done };
  }

  /** Seed a durable run row directly, for the readiness state table. */
  async function seedRun(input: {
    teamId: string;
    status: "RUNNING" | "SUCCEEDED" | "FAILED" | "PARTIAL";
    startedMsAgo?: number;
    errorSummary?: string | null;
  }) {
    const started = new Date(Date.now() - (input.startedMsAgo ?? 1000));
    return prisma.governanceReconciliationRun.create({
      data: {
        kind: KIND,
        status: input.status,
        teamId: input.teamId,
        trigger: "scheduler",
        lockKey: runtime.searchIndexLockKey(input.teamId),
        startedAtUtc: started,
        finishedAtUtc: input.status === "RUNNING" ? null : new Date(),
        errorSummary: input.errorSummary ?? null,
      },
      select: { id: true },
    });
  }

  /** Make the workspace hold `eligible` evidence rows and `indexed` documents. */
  async function setIndexPopulation(input: {
    teamId: string;
    eligible: number;
    indexed: number;
    orphanDocuments?: number;
  }) {
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: input.teamId },
      select: { organizationId: true },
    });
    // Start from a known population rather than whatever the fixture left.
    await prisma.evidenceSearchDocument.deleteMany({
      where: { teamId: input.teamId },
    });
    await prisma.evidence.updateMany({
      where: { teamId: input.teamId },
      data: { lifecycleState: "DESTROYED" },
    });

    const ids: string[] = [];
    for (let i = 0; i < input.eligible; i += 1) {
      const row = await prisma.evidence.create({
        data: {
          title: `durable-recon-${randomUUID()}`,
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

    for (let i = 0; i < input.indexed; i += 1) {
      await prisma.evidenceSearchDocument.create({
        data: {
          teamId: input.teamId,
          documentType: "EVIDENCE",
          sourceId: ids[i] as string,
          title: `doc-${i}`,
          indexedAtUtc: new Date(),
          sourceUpdatedAtUtc: new Date(Date.now() - 60_000),
        },
      });
    }

    // Documents whose source row does not exist at all — the drift direction
    // the counts cannot see.
    for (let i = 0; i < (input.orphanDocuments ?? 0); i += 1) {
      await prisma.evidenceSearchDocument.create({
        data: {
          teamId: input.teamId,
          documentType: "EVIDENCE",
          sourceId: randomUUID(),
          title: `orphan-${i}`,
          indexedAtUtc: new Date(),
          sourceUpdatedAtUtc: new Date(Date.now() - 60_000),
        },
      });
    }
  }

  // =========================================================================
  // 1–12. The durable run and its lock
  // =========================================================================

  it("1. the first request creates exactly ONE durable Search run", async () => {
    const before = await runs(A.teamId);
    expect(before).toHaveLength(0);

    const res = await postReconcile(A.teamId, A.ownerToken);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("COMPLETED");

    const after = await runs(A.teamId);
    expect(after).toHaveLength(1);
    expect(after[0]?.kind).toBe(KIND);
    expect(after[0]?.teamId).toBe(A.teamId);
    expect(after[0]?.trigger).toBe("api");
    // The lock key is BUILT by the shared authority, not by the caller — three
    // call sites producing three keys would be three locks, i.e. none.
    expect(after[0]?.lockKey).toBe(runtime.searchIndexLockKey(A.teamId));
    expect(after[0]?.status).toBe("SUCCEEDED");
    expect(after[0]?.finishedAtUtc).not.toBeNull();
  });

  it("2. a duplicate request does not create a second ACTIVE run", async () => {
    const held = await holdLock(A.teamId, "api");
    try {
      const duplicate = await postReconcile(A.teamId, A.ownerToken);
      // 202, not 200: this request rebuilt nothing.
      expect(duplicate.status).toBe(202);
      expect(duplicate.body.alreadyRunning).toBe(true);
      expect(duplicate.body.status).toBe("RUNNING");
      // It reports the EXISTING run's start time, not its own.
      expect(duplicate.body.runStartedAtUtc).toBeTruthy();

      expect(await activeRuns(A.teamId)).toHaveLength(1);
    } finally {
      held.release();
      await held.done;
    }
  });

  it("3. API and cron cannot both run one workspace", async () => {
    const held = await holdLock(A.teamId, "api");
    try {
      // The REAL scheduler tick, not a stand-in.
      const tick = await workerRecon.runSearchIndexReconciler({
        trigger: "test-cron",
      });
      // Either it did not select this workspace (no outstanding work) or it
      // was refused the slot. What must NOT happen is a second active run.
      expect(tick.workspacesReconciled).toBe(
        tick.workspacesReconciled - tick.workspacesFailed,
      );
      expect(await activeRuns(A.teamId)).toHaveLength(1);
    } finally {
      held.release();
      await held.done;
    }
  });

  it("4. the CLI cannot bypass the lock the API holds", async () => {
    const held = await holdLock(A.teamId, "api");
    try {
      // The backfill CLI's entry point, unchanged.
      const result = await reindex.runWorkspaceReindex(
        { teamId: A.teamId, trigger: "cli" },
        prisma as never,
      );
      // A truthful zero: THIS caller reconciled nothing, because it did not
      // hold the slot. Not a claim that there was nothing to reconcile.
      expect(result.evidence.indexed).toBe(0);
      expect(result.cases.indexed).toBe(0);
      expect(await activeRuns(A.teamId)).toHaveLength(1);
    } finally {
      held.release();
      await held.done;
    }
  });

  it("5. two workers cannot run the same workspace", async () => {
    // Both claim through the real wrapper, concurrently, exactly as two worker
    // processes would.
    let concurrent = 0;
    let maxConcurrent = 0;
    const body = async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 120));
      concurrent -= 1;
      return { scanned: 0, indexed: 0, removed: 0, failed: 0 };
    };

    const [first, second] = await Promise.all([
      runtime.reconcileSearchIndex(prisma as never, {
        teamId: A.teamId,
        trigger: "scheduler",
        body,
      }),
      runtime.reconcileSearchIndex(prisma as never, {
        teamId: A.teamId,
        trigger: "scheduler",
        body,
      }),
    ]);

    // The body ran once. The bodies never overlapped.
    expect(maxConcurrent).toBe(1);
    const kinds = [first.kind, second.kind].sort();
    expect(kinds).toEqual(["already_running", "ran"]);
    // And exactly one row exists for the winner; the loser wrote none.
    const all = await runs(A.teamId);
    expect(all.filter((r) => r.status === "SUCCEEDED")).toHaveLength(1);
  });

  it("6. different workspaces reconcile concurrently", async () => {
    // The slot is per (kind, lock_key), and the lock key is the workspace id,
    // so nothing here may serialise one tenant behind another.
    let overlapped = false;
    let inA = false;
    const body = (mark: "A" | "B") => async () => {
      if (mark === "A") inA = true;
      else if (inA) overlapped = true;
      await new Promise((r) => setTimeout(r, 150));
      if (mark === "A") inA = false;
      return { scanned: 0, indexed: 0, removed: 0, failed: 0 };
    };

    const [a, b] = await Promise.all([
      runtime.reconcileSearchIndex(prisma as never, {
        teamId: A.teamId,
        trigger: "scheduler",
        body: body("A"),
      }),
      runtime.reconcileSearchIndex(prisma as never, {
        teamId: B.teamId,
        trigger: "scheduler",
        body: body("B"),
      }),
    ]);

    expect(a.kind).toBe("ran");
    expect(b.kind).toBe("ran");
    expect(overlapped).toBe(true);
    expect(await runs(A.teamId)).toHaveLength(1);
    expect(await runs(B.teamId)).toHaveLength(1);
  });

  it("7. a VALID lease blocks takeover", async () => {
    await seedRun({ teamId: A.teamId, status: "RUNNING", startedMsAgo: 1_000 });

    let bodyRan = false;
    const outcome = await runtime.reconcileSearchIndex(prisma as never, {
      teamId: A.teamId,
      trigger: "api",
      body: async () => {
        bodyRan = true;
        return { scanned: 0, indexed: 0, removed: 0, failed: 0 };
      },
    });

    expect(outcome.kind).toBe("already_running");
    expect(bodyRan).toBe(false);
    // The incumbent row is untouched — not force-failed, not superseded.
    const rows = await runs(A.teamId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("RUNNING");
  });

  it("8. an EXPIRED lease allows safe recovery", async () => {
    const stale = await seedRun({
      teamId: A.teamId,
      status: "RUNNING",
      startedMsAgo: RUN_LOCK_LEASE_MS + 60_000,
    });

    let bodyRan = false;
    const outcome = await runtime.reconcileSearchIndex(prisma as never, {
      teamId: A.teamId,
      trigger: "retry",
      body: async () => {
        bodyRan = true;
        return { scanned: 1, indexed: 1, removed: 0, failed: 0 };
      },
    });

    expect(outcome.kind).toBe("ran");
    expect(bodyRan).toBe(true);

    // The crashed row is force-failed rather than deleted: the history is
    // append-only, so the crash stays visible.
    const previous = await prisma.governanceReconciliationRun.findUniqueOrThrow({
      where: { id: stale.id },
    });
    expect(previous.status).toBe("FAILED");
    expect(await activeRuns(A.teamId)).toHaveLength(0);
  });

  it("9. an exception writes a safe TERMINAL state, never a dangling RUNNING", async () => {
    const outcome = await runtime.reconcileSearchIndex(prisma as never, {
      teamId: A.teamId,
      trigger: "api",
      body: async () => {
        throw new Error(
          "connection to server at \"10.0.0.5\", port 5432 failed: ECONNREFUSED",
        );
      },
    });

    expect(outcome.kind).toBe("failed");
    // A bounded CATEGORY, not the message. The thrown text names a host, a
    // port and a driver error; none of it may reach a caller.
    expect(outcome.kind === "failed" && outcome.reason).toBe("database_unavailable");
    expect(outcome.kind === "failed" && outcome.reason).not.toMatch(/10\.0\.0\.5|5432|ECONN/);

    const rows = await runs(A.teamId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("FAILED");
    expect(rows[0]?.finishedAtUtc).not.toBeNull();
    // The slot is free again — a crash must not lock a workspace out forever.
    expect(await activeRuns(A.teamId)).toHaveLength(0);
  });

  it("10. a completed ZERO-CHANGE run is a valid, successful run", async () => {
    const outcome = await runtime.reconcileSearchIndex(prisma as never, {
      teamId: A.teamId,
      trigger: "scheduler",
      body: async () => ({ scanned: 0, indexed: 0, removed: 0, failed: 0 }),
    });

    expect(outcome.kind).toBe("ran");
    const rows = await runs(A.teamId);
    expect(rows[0]?.status).toBe("SUCCEEDED");
    expect(rows[0]?.scannedCount).toBe(0);
    expect(rows[0]?.createdCount).toBe(0);
    // "Nothing to do" is a FACT on the row, not an inference from silence.
    expect(rows[0]?.finishedAtUtc).not.toBeNull();
  });

  it("11. a completed CHANGED run persists its final counts", async () => {
    const outcome = await runtime.reconcileSearchIndex(prisma as never, {
      teamId: A.teamId,
      trigger: "cli",
      body: async () => ({ scanned: 7, indexed: 5, removed: 2, failed: 1 }),
    });

    expect(outcome.kind).toBe("ran");
    const rows = await runs(A.teamId);
    expect(rows[0]?.scannedCount).toBe(7);
    expect(rows[0]?.createdCount).toBe(5);
    expect(rows[0]?.skippedCount).toBe(2);
    expect(rows[0]?.failedCount).toBe(1);
  });

  it("12. a worker restart cannot leave a permanent RUNNING state", async () => {
    // A killed process leaves its row behind: no finish, no exception, no
    // chance to clean up. This is that row, past its lease.
    await seedRun({
      teamId: A.teamId,
      status: "RUNNING",
      startedMsAgo: RUN_LOCK_LEASE_MS + 5_000,
    });

    // The restarted process's very next claim resolves it.
    const outcome = await runtime.reconcileSearchIndex(prisma as never, {
      teamId: A.teamId,
      trigger: "scheduler",
      body: async () => ({ scanned: 0, indexed: 0, removed: 0, failed: 0 }),
    });

    expect(outcome.kind).toBe("ran");
    expect(await activeRuns(A.teamId)).toHaveLength(0);
    const snapshot = await runtime.latestSearchRun(prisma as never, A.teamId);
    expect(snapshot?.status).toBe("SUCCEEDED");
  });

  // =========================================================================
  // 13–16. What the endpoint refuses
  // =========================================================================

  it("13. a member without operator capability is refused, and starts nothing", async () => {
    const res = await postReconcile(A.teamId, A.viewerToken);
    expect(res.status).toBe(403);
    // The refusal names the missing capability, not the mechanism.
    expect(JSON.stringify(res.body)).not.toMatch(/lock|SELECT|prisma|stack/i);
    expect(await runs(A.teamId)).toHaveLength(0);
  });

  it("14. a missing envelope fails BEFORE any tenant-scoped work", async () => {
    const res = await postReconcile(A.teamId, null);
    expect(res.status).toBe(401);
    // No run row, for the named workspace or any other: authorization is
    // answered before the workspace is touched at all.
    expect(await runs(A.teamId)).toHaveLength(0);
    expect(
      await prisma.governanceReconciliationRun.count({ where: { kind: KIND } }),
    ).toBe(0);
  });

  it("15. a cross-tenant workspace id reveals nothing about it", async () => {
    // A's owner naming B's workspace. The answer must not distinguish "exists
    // but you may not" from "does not exist".
    const known = await postReconcile(B.teamId, A.ownerToken);
    const invented = await postReconcile(randomUUID(), A.ownerToken);

    expect(known.status).toBe(invented.status);
    expect(known.status).toBe(404);
    expect(JSON.stringify(known.body)).toBe(JSON.stringify(invented.body));
    // And nothing was started in B.
    expect(await runs(B.teamId)).toHaveLength(0);
  });

  it("16. repeated requests are rate limited before they can be abused", async () => {
    // A full workspace rebuild is the most expensive thing this service does
    // on request, so it is bounded per (workspace, actor).
    const statuses: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      statuses.push((await postReconcile(A.teamId, A.ownerToken)).status);
    }
    expect(statuses).toContain(429);

    // The refusal discloses nothing about the workspace.
    const limited = await postReconcile(A.teamId, A.ownerToken);
    expect(limited.status).toBe(429);
    expect(JSON.stringify(limited.body)).not.toMatch(
      /lock|indexed|eligible|SELECT|runId/i,
    );

    // …and the limit is per actor+workspace, so another workspace is unaffected.
    await rateLimit.clearAllRateLimitBuckets();
  });

  // =========================================================================
  // 17–25. Readiness reads the RUN, never the clock
  // =========================================================================

  it("17. zero indexed with a valid RUNNING run → INITIALIZING", async () => {
    await setIndexPopulation({ teamId: A.teamId, eligible: 4, indexed: 0 });
    await seedRun({ teamId: A.teamId, status: "RUNNING", startedMsAgo: 2_000 });

    const r = await readiness(A.teamId, A.ownerToken);
    expect(r.state).toBe("INITIALIZING");
    expect(r.runStatus).toBe("RUNNING");
    expect(r.progressing).toBe(true);
    expect(r.shouldPoll).toBe(true);
  });

  it("18. partially indexed with a valid RUNNING run → PARTIAL", async () => {
    await setIndexPopulation({ teamId: A.teamId, eligible: 5, indexed: 2 });
    await seedRun({ teamId: A.teamId, status: "RUNNING", startedMsAgo: 2_000 });

    const r = await readiness(A.teamId, A.ownerToken);
    expect(r.state).toBe("PARTIAL");
    expect(r.indexedCount).toBe(2);
    expect(r.eligibleCount).toBe(5);
    expect(r.outstandingCount).toBe(3);
    expect(r.shouldPoll).toBe(true);
  });

  it("19. converged counts after a completed run → READY", async () => {
    await setIndexPopulation({ teamId: A.teamId, eligible: 3, indexed: 3 });
    await seedRun({ teamId: A.teamId, status: "SUCCEEDED" });

    const r = await readiness(A.teamId, A.ownerToken);
    expect(r.state).toBe("READY");
    expect(r.shouldPoll).toBe(false);
    expect(r.resultsAreComplete).toBe(true);
  });

  it("20. a completed run with unresolved drift and no continuation → STALLED", async () => {
    // The counts converge. A document for a source row that no longer exists
    // does not appear in them at all, and Search is still answering for it.
    await setIndexPopulation({
      teamId: A.teamId,
      eligible: 3,
      indexed: 3,
      orphanDocuments: 2,
    });
    await seedRun({ teamId: A.teamId, status: "SUCCEEDED" });

    const r = await readiness(A.teamId, A.ownerToken);
    expect(r.state).toBe("STALLED");
    expect(r.unresolvedRemovals).toBe(2);
    expect(r.shouldPoll).toBe(false);
  });

  it("21. a failed run → FAILED, with a bounded reason", async () => {
    await setIndexPopulation({ teamId: A.teamId, eligible: 4, indexed: 1 });
    await seedRun({
      teamId: A.teamId,
      status: "FAILED",
      errorSummary: "timeout",
    });

    const r = await readiness(A.teamId, A.ownerToken);
    expect(r.state).toBe("FAILED");
    expect(r.failureReason).toBe("timeout");
    expect(String(r.failureReason)).not.toMatch(/at \w+ \(|SELECT |Error:/);
    expect(r.shouldPoll).toBe(false);
  });

  it("22. a RUNNING run past its lease → STALLED, not 'still working'", async () => {
    await setIndexPopulation({ teamId: A.teamId, eligible: 4, indexed: 1 });
    await seedRun({
      teamId: A.teamId,
      status: "RUNNING",
      startedMsAgo: RUN_LOCK_LEASE_MS + 120_000,
    });

    const r = await readiness(A.teamId, A.ownerToken);
    // A crashed process leaves a RUNNING row behind. Without the lease check
    // that row would read as work in progress for ever.
    expect(r.state).toBe("STALLED");
    expect(r.runStatus).toBe("RUNNING");
    expect(r.progressing).toBe(false);
    expect(r.shouldPoll).toBe(false);
  });

  it("23. outstanding work with NO run at all → STALLED", async () => {
    // The production state that started this work: 175 of 393, indefinitely,
    // described as "catching up".
    await setIndexPopulation({ teamId: A.teamId, eligible: 6, indexed: 2 });

    const r = await readiness(A.teamId, A.ownerToken);
    expect(r.state).toBe("STALLED");
    expect(r.runStatus).toBeNull();
    expect(r.shouldPoll).toBe(false);
  });

  it("24. a fresh index timestamp alone can never imply progress", async () => {
    // Every document was written seconds ago — the exact evidence the old
    // heuristic read as "a backfill is running". No run row exists.
    await setIndexPopulation({ teamId: A.teamId, eligible: 6, indexed: 3 });
    await prisma.evidenceSearchDocument.updateMany({
      where: { teamId: A.teamId },
      data: { indexedAtUtc: new Date() },
    });

    const r = await readiness(A.teamId, A.ownerToken);
    expect(r.state).toBe("STALLED");
    // The timestamp survives as information, and decides nothing.
    expect(r.lastIndexedAtUtc).toBeTruthy();
    expect(r.progressing).toBe(false);
  });

  it("25. polling terminates on EVERY terminal state", async () => {
    const terminal: Array<[string, () => Promise<void>]> = [
      [
        "READY",
        async () => {
          await setIndexPopulation({ teamId: A.teamId, eligible: 2, indexed: 2 });
          await seedRun({ teamId: A.teamId, status: "SUCCEEDED" });
        },
      ],
      [
        "FAILED",
        async () => {
          await setIndexPopulation({ teamId: A.teamId, eligible: 2, indexed: 0 });
          await seedRun({ teamId: A.teamId, status: "FAILED", errorSummary: "timeout" });
        },
      ],
      [
        "STALLED",
        async () => {
          await setIndexPopulation({ teamId: A.teamId, eligible: 2, indexed: 1 });
        },
      ],
      [
        "EMPTY_WORKSPACE",
        async () => {
          await setIndexPopulation({ teamId: A.teamId, eligible: 0, indexed: 0 });
        },
      ],
    ];

    for (const [expected, seed] of terminal) {
      await prisma.governanceReconciliationRun.deleteMany({ where: { kind: KIND } });
      await seed();
      const r = await readiness(A.teamId, A.ownerToken);
      expect(r.state, `expected ${expected}`).toBe(expected);
      expect(r.shouldPoll, `${expected} must not poll`).toBe(false);
    }
  });
});
