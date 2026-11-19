/**
 * WS-REL / PRO-W2-09 — a running sweep heartbeats, and a stopped one is
 * released by heartbeat age or by its own process's shutdown (live
 * PostgreSQL, the real run authority).
 *
 *  - a RUNNING row older than the 60-minute lease whose holder heartbeated a
 *    minute ago is ALIVE: a second starter is refused (no duplicate run);
 *  - a RUNNING row whose last heartbeat is older than the stale window is
 *    taken over at once, long before 60 minutes;
 *  - a run still executing when its process shuts down is closed as
 *    interrupted_by_shutdown, so the next tick claims the slot.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("PRO-W2-09 reconciliation-run heartbeat (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let runtime: typeof import("@proovra/shared-runtime");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    runtime = await import("@proovra/shared-runtime");
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const lockKey = (s: string) => `ws-rel-heartbeat:${s}`;

  it("a long run that heartbeats is not force-failed and is not joined by a second run", async () => {
    const key = lockKey("alive");
    const held = await prisma.governanceReconciliationRun.create({
      data: {
        kind: "RETENTION",
        trigger: "test",
        lockKey: key,
        status: "RUNNING",
        startedAtUtc: new Date(Date.now() - (runtime.RUN_LOCK_LEASE_MS + 30 * 60_000)),
        heartbeatAtUtc: new Date(Date.now() - 60_000),
      },
    });
    let bodies = 0;
    const r = await runtime.runGovernanceReconciliation(prisma as never, {
      kind: "RETENTION",
      trigger: "test",
      lockKey: key,
      body: async () => {
        bodies += 1;
      },
    });
    expect(bodies).toBe(0);
    expect(r.status).toBe("RUNNING");
    expect(r.runId).toBe(held.id);
    const row = await prisma.governanceReconciliationRun.findUniqueOrThrow({ where: { id: held.id } });
    expect(row.status).toBe("RUNNING");
  });

  it("a holder whose heartbeat stopped is taken over within the stale window, not after an hour", async () => {
    const key = lockKey("dead");
    const dead = await prisma.governanceReconciliationRun.create({
      data: {
        kind: "RETENTION",
        trigger: "test",
        lockKey: key,
        status: "RUNNING",
        startedAtUtc: new Date(Date.now() - 10 * 60_000),
        heartbeatAtUtc: new Date(Date.now() - (runtime.RUN_HEARTBEAT_STALE_MS + 60_000)),
      },
    });
    let bodies = 0;
    const r = await runtime.runGovernanceReconciliation(prisma as never, {
      kind: "RETENTION",
      trigger: "test",
      lockKey: key,
      body: async () => {
        bodies += 1;
      },
    });
    expect(bodies).toBe(1);
    expect(r.status).toBe("SUCCEEDED");
    const old = await prisma.governanceReconciliationRun.findUniqueOrThrow({ where: { id: dead.id } });
    expect(old.status).toBe("FAILED");
    const fresh = await prisma.governanceReconciliationRun.findUniqueOrThrow({ where: { id: r.runId } });
    expect(fresh.heartbeatAtUtc).not.toBeNull();
  });

  it("a run executing at shutdown is closed as interrupted and the slot is free", async () => {
    const key = lockKey("shutdown");
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inBody = new Promise<void>((r) => (entered = r));
    const running = runtime.runGovernanceReconciliation(prisma as never, {
      kind: "RETENTION",
      trigger: "test",
      lockKey: key,
      body: async () => {
        entered();
        await blocked;
      },
    });
    await inBody;
    expect(await runtime.markActiveReconciliationRunsInterrupted()).toBe(1);
    const rows = await prisma.governanceReconciliationRun.findMany({ where: { lockKey: key } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("FAILED");
    expect(rows[0]!.errorSummary).toBe("interrupted_by_shutdown");
    // The slot is free: another starter claims it at once.
    let other = 0;
    const next = await runtime.runGovernanceReconciliation(prisma as never, {
      kind: "RETENTION",
      trigger: "test",
      lockKey: key,
      body: async () => {
        other += 1;
      },
    });
    expect(other).toBe(1);
    expect(next.status).toBe("SUCCEEDED");
    release();
    await running;
  });
});
