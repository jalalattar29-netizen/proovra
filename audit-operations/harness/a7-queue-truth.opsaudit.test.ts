// OPS-022 / OPS-024 — real BullMQ on the disposable Redis.
import { execSync } from "node:child_process";
import { apiUrl, recordProof, repoUrl, scrub } from "./lib/proof";
import { boot, incident, makeUser, member, type Ctx } from "./lib/boot";

const INV = "services/api/src/services/operations/queue-inventory.service.ts";
const RA = "services/api/src/services/operations/queue-replay-action.service.ts";
const RS = "services/api/src/services/operations/queue-replay-safety.service.ts";
const QR = "services/api/src/routes/operations-queues.routes.ts";
const WT = "services/worker/src/telemetry.ts";
const WI = "services/worker/src/index.ts";
const LIFE = "packages/shared-runtime/src/ops/source-lifecycle.ts";

describe("A7 queue truth", () => {
  let c: Ctx; const out: Record<string, any> = {};
  beforeAll(async () => {
    process.env.REDIS_URL = process.env.P7_TEST_REDIS_URL ?? "redis://127.0.0.1:56471";
    c = await boot();
  }, 900_000);
  afterAll(async () => {
    recordProof({ proofId: "PR-A7-queue-truth", title: "BullMQ failures/retries vs Operations; replay of completed work", proofType: "RUNTIME_PROVEN", findingIds: ["OPS-022", "OPS-024"], sources: [INV, RA, RS, QR, WT, WI, LIFE],
      expected: "A real repeated job failure is visible to the platform operator as a condition with stable identity; replay refuses completed work and duplicate replays.", observed: out, outcome: "DEFECT_OBSERVED" });
    await c?.h.cleanup().catch(() => {});
  });

  it("job outcomes, telemetry, incidents, replay", async () => {
    const { Worker } = await import(repoUrl("services/api/node_modules/bullmq/dist/esm/index.js")).catch(async () => import("bullmq" as any));
    const inv = await import(apiUrl("src/services/operations/queue-inventory.service.ts"));
    const NAME = "search-indexing";
    const q = inv.getQueueHandle(NAME);
    expect(q).toBeTruthy();
    await q.obliterate({ force: true }).catch(() => {});
    const conn = { url: process.env.REDIS_URL } as any;
    const w = new Worker(NAME, async (job: any) => { if (job.data.fail) throw new Error("opsaudit deterministic failure"); return { ok: true }; }, { connection: { host: "127.0.0.1", port: Number(new URL(process.env.REDIS_URL!).port) }, concurrency: 1 });
    const ok = await q.add("RebuildSearchDocument", { fail: false, teamId: "x" }, { jobId: "opsaudit-ok-1" });
    const bad = await q.add("RebuildSearchDocument", { fail: true, teamId: "x" }, { jobId: "opsaudit-bad-1", attempts: 3, backoff: { type: "fixed", delay: 10 } });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) { const s = await bad.getState(); const s2 = await ok.getState(); if (s === "failed" && s2 === "completed") break; await new Promise((r) => setTimeout(r, 200)); }
    const badJob = await q.getJob("opsaudit-bad-1");
    out.jobs = { ok: await ok.getState(), bad: await badJob?.getState(), badAttemptsMade: badJob?.attemptsMade, counts: await q.getJobCounts("waiting", "active", "completed", "failed", "delayed") };
    await w.close();

    // Does ANY Operations condition exist for it, on any surface?
    out.incidentsMentioningQueueFailure = await c.prisma.operationalIncident.count({ where: { OR: [{ sourceId: "job.background_failure" }, { relatedJobId: "opsaudit-bad-1" }] } });

    // The real worker sampler (services/worker/src/telemetry.ts) — what it persists for this queue.
    try {
      const wt = await import(repoUrl("services/worker/src/telemetry.ts"));
      const sampler = wt.startTelemetrySampler({ intervalMs: 15_000, workerId: "opsaudit-sampler" });
      const until = Date.now() + 15_000;
      let row: any = null;
      while (Date.now() < until && !row) { row = await c.prisma.queueTelemetrySnapshot.findFirst({ where: { queueName: "search.indexing", source: "BULLMQ" }, orderBy: { sampledAtUtc: "desc" } }); if (!row) await new Promise((r) => setTimeout(r, 300)); }
      await sampler.shutdown("opsaudit");
      out.workerSampler = row ? { teamId: row.teamId, failedCount: row.failedCount, retryCount: row.retryCount, stalledCount: row.stalledCount, source: row.source } : "no row written within 15s";
    } catch (e: any) {
      out.workerSampler = { importError: String(e?.message ?? e).slice(0, 300) };
    }

    // Replay safety on COMPLETED work + duplicate replay, as a platform admin member.
    const pa = await makeUser(c, "queue-admin", { platformRole: "admin" });
    await member(c, c.h.fixtures.teamA.teamId, pa.id, "ADMIN");
    const body = { teamId: c.h.fixtures.teamA.teamId, reason: "opsaudit replay probe" };
    const r1 = await c.inj("POST", `/v1/operations/queues/${NAME}/jobs/opsaudit-ok-1/replay`, pa.token, body);
    const stateAfterReplay = await (await q.getJob("opsaudit-ok-1"))?.getState();
    const [d1, d2] = await Promise.all([
      c.inj("POST", `/v1/operations/queues/${NAME}/jobs/opsaudit-bad-1/replay`, pa.token, body),
      c.inj("POST", `/v1/operations/queues/${NAME}/jobs/opsaudit-bad-1/replay`, pa.token, body),
    ]);
    const owner = await c.inj("POST", `/v1/operations/queues/${NAME}/jobs/opsaudit-bad-1/replay`, c.h.fixtures.teamA.ownerToken, body);
    const audits = await c.prisma.adminAuditLog.findMany({ where: { action: { contains: "queue_job" } }, select: { action: true, metadata: true } }).catch(() => []);
    out.replay = { replayCompletedJob: { status: r1.statusCode, body: scrub(r1.json()) }, completedJobStateAfterReplay: stateAfterReplay, concurrentDuplicateReplay: [d1.statusCode, d2.statusCode], duplicateBodies: [scrub(d1.json()), scrub(d2.json())], customerOwnerReplay: owner.statusCode, auditRows: scrub(audits.map((a: any) => ({ action: a.action, previousState: a.metadata?.previousState ?? null }))) };

    // Redis outage as seen by the platform console and by customer Operations.
    const before = await c.inj("GET", `/v1/operations/queues?teamId=${c.h.fixtures.teamA.teamId}`, pa.token);
    execSync("docker pause opsaudit-redis");
    let during: any, custDuring: any;
    try {
      during = await c.inj("GET", `/v1/operations/queues?teamId=${c.h.fixtures.teamA.teamId}`, pa.token);
      custDuring = await c.inj("GET", `/v1/ops/summary?teamId=${c.h.fixtures.teamA.teamId}`, c.h.fixtures.teamA.ownerToken);
    } finally { execSync("docker unpause opsaudit-redis"); }
    const healthOf = (r: any) => { try { const j = r.json(); return (j.queues ?? j.inventory ?? []).slice(0, 3).map((x: any) => ({ q: x.queueName, health: x.health })); } catch { return r.body?.slice(0, 120); } };
    out.redisOutage = { platformConsoleBefore: { status: before.statusCode, sample: healthOf(before) }, platformConsoleDuring: { status: during.statusCode, sample: healthOf(during) }, customerSummaryDuring: { status: custDuring.statusCode, readiness: custDuring.json()?.summary?.readiness ?? null } };
  });
});
