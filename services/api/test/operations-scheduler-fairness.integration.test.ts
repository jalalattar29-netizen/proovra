// Database acquisition: bootOps() -> bootIntegrationHarness() (the ONE canonical helper).
/**
 * THE OPERATIONS SCHEDULER KEEPS EVERY WORKSPACE INSIDE THE FRESHNESS CONTRACT
 * (live PostgreSQL 16) — 2026-10-14.
 *
 * The scheduler ticks every 15 minutes and ranks workspaces oldest-first, so no
 * workspace is starved forever. But it took a FIXED 25 per tick — 100 runs an
 * hour — and a workspace's picture expires after 45 minutes: any deployment
 * with more than 75 workspaces had workspaces past the contract on every
 * cycle, with no bound on how far. This simulates the real selection over
 * three hours of ticks for 100 workspaces (recording a completed run for every
 * workspace each tick selects) and measures the oldest any workspace's picture
 * ever gets.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OPERATIONS_FRESHNESS_WINDOW_MS, WORKSPACE_OPERATIONS_RUN_KIND } from "@proovra/shared-runtime";

import { bootOps, makeUser, makeWorkspace, type Ctx } from "./operations-truth-fixtures.js";

const TICK_MS = 15 * 60 * 1000;
const WORKSPACES = 100;
const BATCH = 25;

describe("operations scheduler fairness (live PostgreSQL 16)", () => {
  let c: Ctx;
  const ids: string[] = [];

  beforeAll(async () => {
    c = await bootOps();
    const owner = await makeUser(c, "fleet-owner", { plan: "TEAM" });
    for (let i = 0; i < WORKSPACES; i += 1) {
      const w = await makeWorkspace(c, owner.id, { name: `fleet-${i}` });
      ids.push(w.teamId);
    }
  }, 900_000);
  afterAll(async () => {
    await c?.h.cleanup();
  });

  it("no workspace's picture ever exceeds the 45-minute freshness window, and none is starved", async () => {
    const { workspacesNeedingReconciliation } = await import("../src/jobs/workspace-operations-reconciliation.job.js");
    const mine = new Set(ids);
    // Start well in the future of any other suite's rows, and simulate time.
    const start = Date.now() + 24 * 3600_000;
    // Hermetic: workspaces other suites left in this database are stamped
    // fresh past the simulated window, so the fleet alone is the deployment
    // being measured (they would otherwise all become due at once).
    const others = await c.prisma.team.findMany({ where: { id: { notIn: ids } }, select: { id: true } });
    const beyond = new Date(start + 7 * 24 * 3600_000);
    await c.prisma.governanceReconciliationRun.createMany({
      data: others.map((t) => ({
        teamId: t.id,
        kind: WORKSPACE_OPERATIONS_RUN_KIND as never,
        trigger: "scheduler",
        status: "SUCCEEDED" as never,
        startedAtUtc: beyond,
        finishedAtUtc: beyond,
        lockKey: `fairness:other:${t.id}`,
      })),
    });
    const lastRun = new Map<string, number>();
    let worstAgeMs = 0;
    const TICKS = 12; // three hours
    for (let tick = 0; tick < TICKS; tick += 1) {
      const now = new Date(start + tick * TICK_MS);
      // Before this tick runs, how old is every workspace's picture?
      if (tick >= 4) {
        for (const id of ids) {
          const age = now.getTime() - (lastRun.get(id) ?? start);
          worstAgeMs = Math.max(worstAgeMs, age);
        }
      }
      const { ids: selected } = await workspacesNeedingReconciliation(BATCH, now);
      const fleet = selected.filter((id) => mine.has(id));
      await c.prisma.governanceReconciliationRun.createMany({
        data: selected.map((teamId) => ({
          teamId,
          kind: WORKSPACE_OPERATIONS_RUN_KIND as never,
          trigger: "scheduler",
          status: "SUCCEEDED" as never,
          startedAtUtc: now,
          finishedAtUtc: now,
          lockKey: `fairness:${teamId}:${tick}`,
        })),
      });
      for (const id of fleet) lastRun.set(id, now.getTime());
    }
    // Every workspace was reached (no starvation) …
    expect(ids.filter((id) => !lastRun.has(id))).toEqual([]);
    // … and none was ever older than the freshness contract at a tick.
    expect(worstAgeMs).toBeLessThanOrEqual(OPERATIONS_FRESHNESS_WINDOW_MS);
  }, 900_000);
});
