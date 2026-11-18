/**
 * RG-05 — the AI meters against live PostgreSQL 16.
 *
 *   PRO-BL2-03  a finite AI cap with no tenant row to count on refuses
 *               (it used to admit unmetered, writing nothing).
 *   PRO-AI1-12  owner operation limits hold under concurrency (the write is
 *               bounded) and an answered call's actual cost reaches the
 *               rollups the AI usage page reads.
 *   PRO-AI1-02  settleAiSpend keeps an ANSWERED call on both meters whatever
 *               its status, and gives a NOT_SENT call back.
 *   PRO-AI1-07  copilot runs with the same request id from two users/
 *               workspaces never overwrite each other.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("RG-05 AI meters (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let billing: typeof import("../src/services/billing-enforcement.service.js");
  let ledger: typeof import("../src/services/ai/ai-usage-ledger.service.js");
  let outcome: typeof import("../src/services/ai/ai-provider-outcome.js");
  let runs: typeof import("../src/services/ai/ai-copilot-run-store.service.js");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    await import("../src/register-shared-runtime.js");
    billing = await import("../src/services/billing-enforcement.service.js");
    ledger = await import("../src/services/ai/ai-usage-ledger.service.js");
    outcome = await import("../src/services/ai/ai-provider-outcome.js");
    runs = await import("../src/services/ai/ai-copilot-run-store.service.js");
  }, 180_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  async function consumed(teamId: string): Promise<number> {
    const row = await prisma.entitlementUsage.findUnique({
      where: {
        teamId_key_periodStartUtc: {
          teamId,
          key: billing.AI_USAGE_KEY,
          periodStartUtc: billing.startOfCurrentMonthUtc(),
        },
      },
      select: { consumed: true },
    });
    return Number(row?.consumed ?? 0n);
  }

  it("PRO-BL2-03: a finite cap with no Personal Space row refuses and writes nothing", async () => {
    const allowance = await billing.evaluateWorkspaceAiOperation({ teamId: h.fixtures.teamA.teamId });
    expect(typeof allowance.cap === "number" && allowance.cap > 0).toBe(true);
    // The same commercial subject, as a personal-account scope for an identity
    // that owns no personal Team row.
    const orphanScope = { ...allowance.scope!, teamId: null, ownerUserId: randomUUID() };
    const reserved = await billing.reserveWorkspaceAiOperation(orphanScope as never);
    expect(reserved).toMatchObject({ allowed: false, denial: "AI_NOT_INCLUDED", statusCode: 402 });
  });

  it("PRO-AI1-12: an owner daily operation limit of 3 admits exactly 3 of 8 concurrent requests", async () => {
    const teamId = h.fixtures.teamB.teamId;
    await prisma.workspaceAiPolicy.upsert({
      where: { teamId },
      create: { teamId, dailyOperationLimit: 3 } as never,
      update: { dailyOperationLimit: 3 },
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        ledger.tryReserveAiBudget({
          teamId,
          userId: h.fixtures.teamB.ownerUserId,
          feature: "SUPPORT_CHAT",
          model: "m",
          requestId: `rg05-limit-${randomUUID()}-${i}`,
          estimatedCostUsdMicros: 100_000n,
        }),
      ),
    );
    const admitted = results.filter((r) => r.decision?.allowed === true);
    expect(admitted).toHaveLength(3);
    for (const r of results.filter((x) => x.decision?.allowed !== true)) {
      expect(r.decision).toMatchObject({ allowed: false, code: "DAILY_OP_LIMIT" });
    }
    const day = await prisma.aiUsageDaily.findUnique({
      where: { workspaceId_dayUtc: { workspaceId: teamId, dayUtc: ledger.dayUtcOf(new Date()) } },
    });
    expect(day?.operations).toBe(3);
  });

  it("PRO-AI1-02 / PRO-AI1-12: an ANSWERED call stays spent on both meters and its actual cost replaces the estimate", async () => {
    const teamId = h.fixtures.teamA.teamId;
    await prisma.workspaceAiPolicy.deleteMany({ where: { teamId } });
    await prisma.entitlementUsage.deleteMany({ where: { teamId, key: billing.AI_USAGE_KEY } });
    const allowance = await billing.evaluateWorkspaceAiOperation({ teamId });
    const plan = await billing.reserveWorkspaceAiOperation(allowance.scope!);
    expect(plan.allowed).toBe(true);
    const res = await ledger.tryReserveAiBudget({
      teamId,
      userId: h.fixtures.teamA.ownerUserId,
      feature: "SUPPORT_CHAT",
      model: "m",
      requestId: `rg05-answered-${randomUUID()}`,
      estimatedCostUsdMicros: 100_000n,
    });
    expect(res.reservationId).not.toBeNull();
    // The model wrote a non-ok status; the transport says it answered.
    await outcome.settleAiSpend({
      outcome: "ANSWERED",
      ledgerReservationId: res.reservationId,
      actualCostUsdMicros: 1_200n,
      releasePlanOperation: () => billing.releaseWorkspaceAiOperation(plan.allowed ? plan.reservation : null),
    });
    expect(await consumed(teamId)).toBe(1);
    const event = await prisma.aiUsageEvent.findUnique({ where: { id: res.reservationId! } });
    expect(event).toMatchObject({ status: "completed", actualCostUsdMicros: 1_200n });
    const day = await prisma.aiUsageDaily.findUnique({
      where: { workspaceId_dayUtc: { workspaceId: teamId, dayUtc: ledger.dayUtcOf(new Date()) } },
    });
    expect(day?.costUsdMicros).toBe(1_200n);
  });

  it("PRO-AI1-02: a NOT_SENT call gives both meters back", async () => {
    const teamId = h.fixtures.teamA.teamId;
    const before = await consumed(teamId);
    const allowance = await billing.evaluateWorkspaceAiOperation({ teamId });
    const plan = await billing.reserveWorkspaceAiOperation(allowance.scope!);
    const res = await ledger.tryReserveAiBudget({
      teamId,
      userId: h.fixtures.teamA.ownerUserId,
      feature: "SUPPORT_CHAT",
      model: "m",
      requestId: `rg05-notsent-${randomUUID()}`,
      estimatedCostUsdMicros: 100_000n,
    });
    await outcome.settleAiSpend({
      outcome: "NOT_SENT",
      ledgerReservationId: res.reservationId,
      releasePlanOperation: () => billing.releaseWorkspaceAiOperation(plan.allowed ? plan.reservation : null),
    });
    expect(await consumed(teamId)).toBe(before);
    const event = await prisma.aiUsageEvent.findUnique({ where: { id: res.reservationId! } });
    expect(event?.status).toBe("failed");
  });

  it("PRO-AI1-07: the same request id from another user or workspace creates its own run, never overwrites", async () => {
    const shared = `review:${randomUUID()}`;
    const base = {
      feature: "REVIEWER_COPILOT" as const,
      requestId: shared,
      model: "m",
      workspacePolicyVersion: 1,
      processingMode: "METADATA_ONLY",
      selectedObjectRevisions: [],
    };
    const a = await runs.persistCopilotRun({
      ...base,
      workspaceId: h.fixtures.teamA.teamId,
      userId: h.fixtures.teamA.ownerUserId,
      status: "ok",
      boundedResult: { who: "A" },
    });
    const b = await runs.persistCopilotRun({
      ...base,
      workspaceId: h.fixtures.teamB.teamId,
      userId: h.fixtures.teamB.ownerUserId,
      status: "schema_error",
      boundedResult: { who: "B" },
    });
    expect(a?.id).toBeTruthy();
    expect(b?.id).toBeTruthy();
    expect(b!.id).not.toBe(a!.id);
    const rowA = await prisma.aiCopilotRun.findUnique({ where: { id: a!.id } });
    expect(rowA?.status).toBe("ok");
    expect(rowA?.boundedResultJson).toEqual({ who: "A" });
    // The same user re-running updates their own row.
    const again = await runs.persistCopilotRun({
      ...base,
      workspaceId: h.fixtures.teamA.teamId,
      userId: h.fixtures.teamA.ownerUserId,
      status: "ok",
      boundedResult: { who: "A2" },
    });
    expect(again?.id).toBe(a!.id);
  });
});
