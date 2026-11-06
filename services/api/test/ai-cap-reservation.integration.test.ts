/**
 * PRO-069 / BILLING-10 and the overshoot half of Enterprise BILLING-014 — the
 * monthly AI allowance is reserved before the operation, atomically.
 *
 * Reproduction (retest on 69251a953, AI-01): cap 3, consumed 2, eight
 * concurrent admit-wait-record operations were all admitted, leaving
 * consumed 10 / cap 3. The positive control was the next sequential call,
 * refused AI_MONTHLY_LIMIT_REACHED.
 *
 * Here the same boundary is driven through the real reservation against the
 * real `entitlement_usage` row: at cap - 1, eight concurrent reservations
 * admit exactly one, the counter ends at the cap, a further call is refused,
 * and a released reservation frees its place.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("AI monthly allowance — reserve before the operation (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let billing: typeof import("../src/services/billing-enforcement.service.js");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    await import("../src/register-shared-runtime.js");
    billing = await import("../src/services/billing-enforcement.service.js");
  }, 180_000);

  afterAll(async () => {
    if (prisma && h) {
      await prisma.entitlementUsage
        .deleteMany({ where: { teamId: h.fixtures.teamA.teamId, key: billing.AI_USAGE_KEY } })
        .catch(() => undefined);
    }
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

  it("eight concurrent operations at cap - 1 admit exactly one", async () => {
    const teamId = h.fixtures.teamA.teamId;
    const allowance = await billing.evaluateWorkspaceAiOperation({ teamId });
    expect(allowance.scope, "the fixture workspace resolves a commercial scope").not.toBeNull();
    const cap = allowance.cap;
    expect(typeof cap === "number" && cap > 1, `the fixture plan has a finite AI cap (got ${String(cap)})`).toBe(true);
    const capN = cap as number;

    await prisma.entitlementUsage.upsert({
      where: {
        teamId_key_periodStartUtc: {
          teamId,
          key: billing.AI_USAGE_KEY,
          periodStartUtc: billing.startOfCurrentMonthUtc(),
        },
      },
      create: { teamId, key: billing.AI_USAGE_KEY, periodStartUtc: billing.startOfCurrentMonthUtc(), consumed: BigInt(capN - 1) },
      update: { consumed: BigInt(capN - 1) },
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => billing.reserveWorkspaceAiOperation(allowance.scope!)),
    );
    const admitted = results.filter((r) => r.allowed);
    const refused = results.filter((r) => !r.allowed);
    expect(admitted).toHaveLength(1);
    expect(refused).toHaveLength(7);
    for (const r of refused) {
      expect(r).toMatchObject({ allowed: false, denial: "AI_MONTHLY_LIMIT_REACHED", statusCode: 429 });
    }
    expect(await consumed(teamId)).toBe(capN);

    // Positive control: the next sequential call is refused, by the same gate.
    const next = await billing.reserveWorkspaceAiOperation(allowance.scope!);
    expect(next.allowed).toBe(false);
    expect((await billing.evaluateWorkspaceAiOperation({ teamId })).denial).toBe("AI_MONTHLY_LIMIT_REACHED");

    // An operation that did not spend gives its place back, once.
    const held = admitted[0] as { allowed: true; reservation: { tenantId: string; periodStartUtc: Date } | null };
    await billing.releaseWorkspaceAiOperation(held.reservation);
    expect(await consumed(teamId)).toBe(capN - 1);
    const again = await billing.reserveWorkspaceAiOperation(allowance.scope!);
    expect(again.allowed).toBe(true);
    expect(await consumed(teamId)).toBe(capN);
  });

  it("a release never takes the counter below zero", async () => {
    const teamId = h.fixtures.teamA.teamId;
    await prisma.entitlementUsage.update({
      where: {
        teamId_key_periodStartUtc: {
          teamId,
          key: billing.AI_USAGE_KEY,
          periodStartUtc: billing.startOfCurrentMonthUtc(),
        },
      },
      data: { consumed: 0n },
    });
    await billing.releaseWorkspaceAiOperation({ tenantId: teamId, periodStartUtc: billing.startOfCurrentMonthUtc() });
    expect(await consumed(teamId)).toBe(0);
  });
});
