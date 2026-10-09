// Database acquisition: bootOps() -> bootIntegrationHarness() (the ONE canonical helper).
/**
 * OPERATIONS TRUTH CLOSURE — platform conditions (live PostgreSQL + Redis/BullMQ).
 *
 *   OPS-001  a Home page visit writes no telemetry, and workspace discovery
 *            never produces a "telemetry sampler" condition.
 *   OPS-002  the "retry storm" (re-observed conditions counted as job
 *            retries) is never produced.
 *   OPS-009  worker liveness is ONE platform condition, not one per
 *            workspace, and it closes when a live heartbeat lands.
 *   OPS-022  a real BullMQ job that exhausts its retries becomes ONE platform
 *            condition per queue, closed when the failure window clears.
 *   OPS-027  a provider credential refusal is ONE stable platform condition
 *            per provider, closed by the next answered provider call.
 *   OPS-024  queue replay: failed-only, completed -> 409, a concurrent
 *            duplicate -> 409, the audit records BullMQ's real previous
 *            state, and a workspace owner without platform authority -> 403.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addMember,
  bootOps,
  makeUser,
  makeWorkspace,
  seedIncident,
  sweep,
  type Ctx,
} from "./operations-truth-fixtures.js";

const SEARCH_QUEUE = "search-indexing";
const SEARCH_JOB = "RebuildSearchDocument";

async function waitFor(pred: () => Promise<boolean>, ms = 15_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

describe("Operations truth closure — platform conditions (live PostgreSQL 16 + Redis/BullMQ)", () => {
  let c: Ctx;
  beforeAll(async () => {
    c = await bootOps();
    await c.prisma.workerLease.deleteMany({});
  }, 900_000);
  afterAll(async () => {
    await c?.h.cleanup();
  });

  async function failSearchJobs(n: number, tag: string): Promise<string[]> {
    const { getQueueHandle } = await import("../src/services/operations/queue-inventory.service.js");
    const { Worker } = await import("bullmq");
    const q = getQueueHandle(SEARCH_QUEUE)!;
    const url = new URL(process.env.REDIS_URL!);
    const before = (await q.getJobCounts("failed")).failed;
    const w = new Worker(
      SEARCH_QUEUE,
      async () => {
        throw new Error("index backend refused the write");
      },
      { connection: { host: url.hostname, port: Number(url.port) } },
    );
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = `${tag}-${Date.now()}-${i}`;
      ids.push(id);
      await q.add(SEARCH_JOB, { evidenceId: null }, { jobId: id, attempts: 2 });
    }
    await waitFor(async () => (await q.getJobCounts("failed")).failed >= before + n);
    await w.close();
    return ids;
  }

  it("OPS-001 a Home page visit writes no telemetry; discovery never produces a telemetry-sampler condition", async () => {
    const a = c.h.fixtures.teamA;
    const qBefore = await c.prisma.queueTelemetrySnapshot.count();
    const wBefore = await c.prisma.workerTelemetrySnapshot.count();
    for (let i = 0; i < 3; i++) {
      const r = await c.inj("GET", `/v1/dashboard/command-center?teamId=${a.teamId}`, a.ownerToken);
      expect(r.statusCode).toBe(200);
      expect(r.body).not.toContain("retryStormIncidents");
    }
    expect(await c.prisma.queueTelemetrySnapshot.count()).toBe(qBefore);
    expect(await c.prisma.workerTelemetrySnapshot.count()).toBe(wBefore);

    await sweep(a.teamId);
    expect(
      await c.prisma.operationalIncident.count({ where: { sourceId: "platform.telemetry_stale" } }),
    ).toBe(0);
  });

  it("OPS-002 re-observed workspace conditions are never reported as a queue retry storm", async () => {
    const a = c.h.fixtures.teamA;
    for (let i = 0; i < 6; i++) {
      await seedIncident(c, a.teamId, { occurrenceCount: 40 });
    }
    await sweep(a.teamId);
    expect(await c.prisma.operationalIncident.count({ where: { sourceId: "queue.retry_storm" } })).toBe(0);
    expect(
      await c.prisma.operationalIncident.count({ where: { fingerprint: { contains: "retry_storm" } } }),
    ).toBe(0);
  });

  it("OPS-009 worker liveness is ONE platform condition across workspaces, closed by a live heartbeat", async () => {
    const { runWorkspaceOperationsSweep } = await import("../src/jobs/workspace-operations-reconciliation.job.js");
    const owner = await makeUser(c, "hb-owner");
    const w1 = await makeWorkspace(c, owner.id, { name: "hb-one" });
    const w2 = await makeWorkspace(c, owner.id, { name: "hb-two" });
    // The shared test database may hold rows from earlier runs; this proof is
    // about what THIS sweep writes.
    const t0 = new Date();
    const crashedAt = new Date(Date.now() - 60 * 60 * 1000);
    await c.prisma.workerLease.create({
      data: { workerId: `ops-truth-crashed-${Date.now()}`, workerKind: "WORKER", state: "LIVE", startedAtUtc: crashedAt, lastSeenAtUtc: crashedAt },
    });

    await runWorkspaceOperationsSweep({ trigger: "cli", batchSize: 200 });
    await runWorkspaceOperationsSweep({ trigger: "cli", batchSize: 200 });

    const rows = await c.prisma.operationalIncident.findMany({
      where: { sourceId: "platform.worker_heartbeat_stale", status: { in: ["OPEN", "ACKNOWLEDGED"] }, updatedAt: { gte: t0 } },
      select: { teamId: true, scope: true, fingerprint: true },
    });
    expect(rows).toEqual([{ teamId: null, scope: "PLATFORM", fingerprint: "platform:worker_heartbeat_stale" }]);
    for (const teamId of [w1.teamId, w2.teamId]) {
      expect(
        await c.prisma.operationalIncident.count({ where: { teamId, sourceId: "platform.worker_heartbeat_stale" } }),
      ).toBe(0);
    }

    await c.prisma.workerLease.create({
      data: { workerId: `ops-truth-live-${Date.now()}`, workerKind: "WORKER", state: "LIVE", lastSeenAtUtc: new Date() },
    });
    const { reconcilePlatformConditions } = await import("../src/services/operations/platform-conditions.service.js");
    const out = await reconcilePlatformConditions();
    expect(out.heartbeat).toBe("RECOVERED");
    const row = await c.prisma.operationalIncident.findFirst({
      where: { fingerprint: "platform:worker_heartbeat_stale", scope: "PLATFORM" },
      select: { status: true },
    });
    expect(row?.status).toBe("RESOLVED");
  });

  it("OPS-022 a real BullMQ final failure is ONE platform condition per queue, resolved when the window clears", async () => {
    const { reconcilePlatformConditions, queueFailureFingerprint } = await import(
      "../src/services/operations/platform-conditions.service.js"
    );
    await failSearchJobs(2, "ops-truth-fail");
    await reconcilePlatformConditions();
    await reconcilePlatformConditions();
    const fp = queueFailureFingerprint(SEARCH_QUEUE);
    const open = await c.prisma.operationalIncident.findMany({
      where: { fingerprint: fp, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
      select: { teamId: true, scope: true, sourceId: true, title: true },
    });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ teamId: null, scope: "PLATFORM", sourceId: "job.background_failure" });
    expect(open[0]!.title).toContain("Search indexing");

    // The failures leave the window (cleaned): the inventory reports none, so
    // the condition closes from the same authority that opened it.
    const { getQueueHandle } = await import("../src/services/operations/queue-inventory.service.js");
    await getQueueHandle(SEARCH_QUEUE)!.clean(0, 1000, "failed");
    const out = await reconcilePlatformConditions();
    expect(out.queues[SEARCH_QUEUE]).toBe("RECOVERED");
    const row = await c.prisma.operationalIncident.findFirst({ where: { fingerprint: fp }, select: { status: true } });
    expect(row?.status).toBe("RESOLVED");
  });

  it("OPS-027 a provider credential refusal is ONE stable platform condition, closed by the next answered call", async () => {
    const { recordProviderFailureSignal, recordProviderObservationSuccess } = await import(
      "../src/services/billing/pending-payments.service.js"
    );
    // This test's own fingerprint, cleared so a re-run of the suite counts
    // from one rather than reopening the previous run's row.
    await c.prisma.operationalIncident.deleteMany({ where: { fingerprint: "billing-provider-auth:PAYPAL" } });
    recordProviderFailureSignal({ provider: "PAYPAL" as never, operation: "RECHECK_PAYMENT", failure: "AUTHORIZATION_FAILED" as never, paymentId: "p-1" });
    await waitFor(async () => (await c.prisma.operationalIncident.count({ where: { sourceId: "billing.provider_authorization" } })) > 0);
    recordProviderFailureSignal({ provider: "PAYPAL" as never, operation: "ABANDON_PAYMENT", failure: "AUTHORIZATION_FAILED" as never, paymentId: "p-2" });
    await waitFor(async () => {
      const r = await c.prisma.operationalIncident.findFirst({ where: { sourceId: "billing.provider_authorization" }, select: { occurrenceCount: true } });
      return (r?.occurrenceCount ?? 0) >= 2;
    });
    const rows = await c.prisma.operationalIncident.findMany({
      where: { sourceId: "billing.provider_authorization" },
      select: { teamId: true, scope: true, fingerprint: true, status: true, occurrenceCount: true },
    });
    expect(rows).toEqual([
      { teamId: null, scope: "PLATFORM", fingerprint: "billing-provider-auth:PAYPAL", status: "OPEN", occurrenceCount: 2 },
    ]);

    recordProviderObservationSuccess({ provider: "PAYPAL" as never });
    expect(
      await waitFor(async () => {
        const r = await c.prisma.operationalIncident.findFirst({ where: { fingerprint: "billing-provider-auth:PAYPAL" }, select: { status: true } });
        return r?.status === "RESOLVED";
      }),
    ).toBe(true);
  });

  it("OPS-024 replay is failed-only, completed and concurrent duplicates are 409, the audit records BullMQ's state, a customer owner is refused", async () => {
    const a = c.h.fixtures.teamA;
    const admin = await makeUser(c, "replay-platform", { platformRole: "admin" });
    await addMember(c, a.teamId, admin.id, "ADMIN");
    const { getQueueHandle } = await import("../src/services/operations/queue-inventory.service.js");
    const q = getQueueHandle(SEARCH_QUEUE)!;
    const url = (jobId: string) => `/v1/operations/queues/${SEARCH_QUEUE}/jobs/${encodeURIComponent(jobId)}/replay`;
    const body = { teamId: a.teamId, reason: "ops-truth replay proof" };

    // A completed job: refused for what it is, not "not found".
    const { Worker } = await import("bullmq");
    const conn = new URL(process.env.REDIS_URL!);
    const okWorker = new Worker(SEARCH_QUEUE, async () => "done", { connection: { host: conn.hostname, port: Number(conn.port) } });
    const doneId = `ops-truth-done-${Date.now()}`;
    await q.add(SEARCH_JOB, { evidenceId: null }, { jobId: doneId });
    await waitFor(async () => (await (await q.getJob(doneId))?.getState()) === "completed");
    await okWorker.close();
    const done = await c.inj("POST", url(doneId), admin.token, body);
    expect(done.statusCode).toBe(409);
    expect(done.json().error.code).toBe("job_completed");

    // A customer workspace owner holds no platform authority.
    const [failedId] = await failSearchJobs(1, "ops-truth-replay");
    const owner = await c.inj("POST", url(failedId!), a.ownerToken, body);
    expect(owner.statusCode).toBe(403);

    // Two concurrent replays of one failed job: exactly one is queued.
    const [r1, r2] = await Promise.all([
      c.inj("POST", url(failedId!), admin.token, body),
      c.inj("POST", url(failedId!), admin.token, body),
    ]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 409]);

    const audits = await c.prisma.adminAuditLog.findMany({
      where: { action: "operations.queue_job.replay_requested", resourceId: { contains: failedId! } },
      select: { previousState: true },
    });
    expect(audits).toEqual([{ previousState: "FAILED" }]);
  });
});
