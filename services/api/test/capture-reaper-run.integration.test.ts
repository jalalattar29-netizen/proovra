/**
 * THE WORKER REAPER IS THE ONLY REAPER — operational proof (2026-09-30).
 * Live PostgreSQL 16; the worker's real `runCaptureReaperSweep`.
 *
 * Since ET-SEC-24 retired the API's in-process sweep, the worker reaper alone
 * expires abandoned capture drafts and releases abandoned evidence
 * reservations. It ran on a bare timer: one page of 100 per pass, its failure
 * swallowed, nothing recorded — so a stopped, disabled or always-failing reaper
 * was indistinguishable from a healthy one, and a backlog larger than a page
 * drained at 100 rows per half hour.
 *
 * Proven here: one run reaches past a page to old rows; a repeated or
 * concurrent run releases nothing twice; every run leaves a row; and the
 * last-run / last-success / failure facts are read from outside the worker.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("capture reaper run — recorded, paged, idempotent, observable (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let reaper: typeof import("../../worker/src/capture-reaper.js");
  let health: (typeof import("@proovra/shared-runtime"))["readScheduledSweepHealth"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const runtime = await import("@proovra/shared-runtime");
    runtime.registerPrisma(prisma as never);
    health = runtime.readScheduledSweepHealth;
    reaper = await import("../../worker/src/capture-reaper.js");
    // A clean slate for THIS kind's history, so the health assertions below
    // are about the runs this suite makes.
    await prisma.governanceReconciliationRun.deleteMany({ where: { kind: "CAPTURE_REAPER" } });
  }, 180_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  const HOUR = 3600_000;
  async function seedExpiredDrafts(n: number, tag: string): Promise<string[]> {
    const A = h.fixtures.teamA;
    const ids = Array.from({ length: n }, () => randomUUID());
    await prisma.captureSession.createMany({
      data: ids.map((id, i) => ({
        id,
        ownerUserId: A.ownerUserId,
        teamId: A.teamId,
        status: "DRAFT" as const,
        templateName: tag,
        // Oldest first: row 0 expired longest ago.
        expiresAtUtc: new Date(Date.now() - (n - i + 1) * 60_000 - 24 * HOUR),
      })),
    });
    return ids;
  }
  const statusCounts = async (ids: string[]) => {
    const rows = await prisma.captureSession.groupBy({ by: ["status"], where: { id: { in: ids } }, _count: true });
    return Object.fromEntries(rows.map((r) => [r.status, r._count]));
  };
  const expiredEvents = (ids: string[]) =>
    prisma.captureSessionEvent.count({ where: { sessionId: { in: ids }, eventType: "EXPIRED" } });

  it("one run pages past a full page and reaches every expired draft, oldest included", async () => {
    const ids = await seedExpiredDrafts(230, "reaper-paging");
    const run = await reaper.runCaptureReaperSweep({ trigger: "test", batchSize: 100 });

    expect(["SUCCEEDED", "PARTIAL"]).toContain(run.status);
    expect(run.pages).toBeGreaterThanOrEqual(3);
    expect(run.draftsExpired).toBeGreaterThanOrEqual(230);
    expect(await statusCounts(ids)).toEqual({ EXPIRED: 230 });
    // Exactly one EXPIRED event per draft.
    expect(await expiredEvents(ids)).toBe(230);

    const row = await prisma.governanceReconciliationRun.findUniqueOrThrow({ where: { id: run.runId! } });
    expect(row).toMatchObject({ kind: "CAPTURE_REAPER", status: run.status, trigger: "test" });
    expect(row.finishedAtUtc).toBeInstanceOf(Date);
    expect(row.createdCount).toBeGreaterThanOrEqual(230);
    expect((row.metadata as { draftsExpired: number }).draftsExpired).toBeGreaterThanOrEqual(230);
  });

  it("a repeated run and concurrent runs expire nothing twice", async () => {
    const ids = await seedExpiredDrafts(40, "reaper-idempotent");
    const runs = await Promise.all(
      Array.from({ length: 4 }, () => reaper.runCaptureReaperSweep({ trigger: "test", batchSize: 25 })),
    );
    // The run lock admits one body at a time; the rest are no-ops that say so.
    expect(runs.filter((r) => r.status !== "RUNNING").length).toBeGreaterThanOrEqual(1);
    await reaper.runCaptureReaperSweep({ trigger: "test", batchSize: 25 });
    await reaper.runCaptureReaperSweep({ trigger: "test", batchSize: 25 });

    expect(await statusCounts(ids)).toEqual({ EXPIRED: 40 });
    expect(await expiredEvents(ids)).toBe(40);
  });

  it("an abandoned reservation is released exactly once across repeated runs", async () => {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    const old = new Date(Date.now() - 30 * HOUR);
    const ev = await prisma.evidence.create({
      data: {
        title: "reaper-reservation",
        type: "PHOTO",
        status: "CREATED",
        teamId: A.teamId,
        organizationId: team.organizationId,
        ownerUserId: A.ownerUserId,
        createdAt: old,
      } as never,
      select: { id: true },
    });
    await prisma.$executeRaw`UPDATE evidence SET updated_at = ${old} WHERE id = ${ev.id}::uuid`;

    for (let i = 0; i < 3; i++) await reaper.runCaptureReaperSweep({ trigger: "test" });
    const after = await prisma.evidence.findUniqueOrThrow({ where: { id: ev.id } });
    expect(after.deletedAt).not.toBeNull();
    expect(await prisma.custodyEvent.count({ where: { evidenceId: ev.id, eventType: "EVIDENCE_DELETED" } })).toBe(1);
  });

  it("rows a page could not process are skipped by the next page (excludeIds), so paging moves on", async () => {
    const ids = await seedExpiredDrafts(6, "reaper-exclude");
    const res = await reaper.reapExpiredCaptureDrafts({ trigger: "test", batchSize: 500, excludeIds: ids.slice(0, 2) });
    expect(res.failedIds).toEqual([]);
    expect(await statusCounts(ids)).toEqual({ DRAFT: 2, EXPIRED: 4 });
    await reaper.reapExpiredCaptureDrafts({ trigger: "test", batchSize: 500 });
    expect(await statusCounts(ids)).toEqual({ EXPIRED: 6 });
  });

  it("last run, last success and failure are read from the run rows — from outside the worker", async () => {
    const ok = await health(prisma, "CAPTURE_REAPER");
    expect(ok.state).toBe("OK");
    expect(ok.lastRunAtUtc).toBeInstanceOf(Date);
    expect(ok.lastSuccessAtUtc).toBeInstanceOf(Date);
    expect(ok.lastFailureAtUtc).toBeNull();

    // A reaper that last succeeded five hours ago and has been silent since.
    const later = new Date(Date.now() + 5 * HOUR);
    const stale = await health(prisma, "CAPTURE_REAPER", later);
    expect(stale.state).toBe("STALE");
    expect(stale.silenceMs).toBeGreaterThan(stale.maxSilenceMs);

    // Its latest run failed.
    await prisma.governanceReconciliationRun.create({
      data: {
        kind: "CAPTURE_REAPER",
        status: "FAILED",
        trigger: "test",
        lockKey: `CAPTURE_REAPER:failed-${randomUUID()}`,
        startedAtUtc: new Date(),
        finishedAtUtc: new Date(),
        errorSummary: "connection terminated unexpectedly",
      } as never,
    });
    const failing = await health(prisma, "CAPTURE_REAPER");
    expect(failing).toMatchObject({ state: "FAILING", lastError: "connection terminated unexpectedly" });
    expect(failing.lastFailureAtUtc).toBeInstanceOf(Date);
    // …and the last success is still reported beside it.
    expect(failing.lastSuccessAtUtc).toBeInstanceOf(Date);

    // The next successful run clears it.
    await reaper.runCaptureReaperSweep({ trigger: "test" });
    expect((await health(prisma, "CAPTURE_REAPER")).state).toBe("OK");
  });

  it("a kind with no run on record is NEVER_RAN, not OK", async () => {
    await prisma.governanceReconciliationRun.deleteMany({ where: { kind: "CAPTURE_REAPER" } });
    expect(await health(prisma, "CAPTURE_REAPER")).toMatchObject({
      state: "NEVER_RAN",
      lastRunAtUtc: null,
      lastSuccessAtUtc: null,
    });
  });
});
