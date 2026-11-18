/**
 * WS-SCHED / PRO-W2C-02 — the worker's retention reconciliation progresses
 * past expired records it must skip, through the REAL reconciler against a
 * disposable PostgreSQL.
 *
 * At base the expired scan read the oldest `batchSize` rows every tick, so
 * records it skips (here: a person declined their review after expiry) held the
 * head forever and a later-expiring ordinary record never got its review. Now
 * a global run pages by a durable id cursor. The drift scan records one ledger
 * row per stale pointer instead of one per tick.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("PRO-W2C-02 retention reconciliation keyset (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let reconciler: typeof import("../../worker/src/governance/retention-reconciliation.worker.js");
  const A = () => h.fixtures.teamA;

  async function expired(daysAgo: number) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    return prisma.evidence.create({
      data: {
        title: "ws-sched retention",
        type: "PHOTO",
        status: "SIGNED",
        teamId: A().teamId,
        organizationId: team.organizationId,
        ownerUserId: A().ownerUserId,
        retentionUntilUtc: new Date(Date.now() - daysAgo * 86_400_000),
      } as never,
      select: { id: true },
    });
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    reconciler = await import("../../worker/src/governance/retention-reconciliation.worker.js");
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  it("30 declined expired records ahead of one ordinary record: the ordinary one gets its review within two ticks", async () => {
    for (let i = 0; i < 30; i += 1) {
      const ev = await expired(400 - i);
      await prisma.destructionReview.create({
        data: {
          teamId: A().teamId,
          evidenceId: ev.id,
          status: "DENIED",
          reason: "retention_expired",
          decidedByUserId: A().ownerUserId,
          decidedAtUtc: new Date(),
        },
      });
    }
    const ordinary = await expired(1);
    await reconciler.runRetentionReconciliation({ trigger: "test", batchSize: 30 });
    await reconciler.runRetentionReconciliation({ trigger: "test", batchSize: 30 });
    const row = await prisma.evidence.findUniqueOrThrow({
      where: { id: ordinary.id },
      select: { activeDestructionReviewId: true },
    });
    expect(row.activeDestructionReviewId).not.toBeNull();
  });

  it("a stale PENDING_DESTRUCTION pointer is recorded once, not once per tick", async () => {
    const ev = await expired(10);
    await prisma.evidence.update({
      where: { id: ev.id },
      data: { lifecycleState: "PENDING_DESTRUCTION", activeDestructionReviewId: null },
    });
    for (let i = 0; i < 3; i += 1) await reconciler.runRetentionReconciliation({ trigger: "test", teamId: A().teamId });
    const events = await prisma.evidenceLifecycleEvent.count({
      where: { evidenceId: ev.id, summary: "Lifecycle drift detected — pointer stale" },
    });
    expect(events).toBe(1);
  });
});
