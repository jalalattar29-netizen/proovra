/**
 * PRO-W2C-01 (WS-BILL, 2026-11-18) — a plan lowering the sweep held is applied
 * once BILLING_AUTO_PLAN_LOWERING is switched on, and is listed before then.
 * Live PostgreSQL; the production writer (`syncPlanForSubscription` with the
 * sweep's hold) reproduces the held state, and `applyHeldPlanLowerings` is the
 * sweep step.
 *
 * At the base the held account kept entitlements.plan=PRO for ever: its row
 * was already CANCELED, so nothing selected it again.
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedPersonalTenant, type FixtureDeps } from "./point7/product-fixtures.js";

describe("PRO-W2C-01 — held plan lowering is revisited (live PostgreSQL)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;
  let handlers: typeof import("../src/services/billing/subscription-lifecycle.handlers.js");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    handlers = await import("../src/services/billing/subscription-lifecycle.handlers.js");
    const { signJwt } = await import("../src/services/jwt.js");
    deps = {
      prisma: prisma as never,
      tag: `hpl-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
  }, 900_000);

  afterEach(() => {
    delete process.env.BILLING_AUTO_PLAN_LOWERING;
  });

  afterAll(async () => {
    await harness?.cleanup();
  }, 300_000);

  const planOf = async (userId: string) =>
    (await prisma.entitlement.findFirstOrThrow({ where: { userId, active: true }, select: { plan: true } })).plan;

  /** A Pro payer whose lost cancellation webhook the SWEEP learned of, with lowering held. */
  async function heldPro(periodEnd: Date) {
    const t = await seedPersonalTenant(deps, "PRO");
    const providerSubId = `sub_${randomUUID().slice(0, 12)}`;
    await prisma.subscription.create({
      data: {
        userId: t.owner.userId,
        provider: "STRIPE",
        providerSubId,
        status: "ACTIVE",
        plan: "PRO",
        currentPeriodEnd: periodEnd,
        activatedAtUtc: new Date(Date.now() - 40 * 86_400_000),
      },
    });
    await handlers.syncPlanForSubscription({
      userId: t.owner.userId,
      plan: "PRO",
      provider: "STRIPE",
      providerSubId,
      status: "CANCELED",
      currentPeriodEnd: periodEnd,
      observedAtUtc: new Date(),
      holdPlanLowering: true,
    });
    return t.owner.userId;
  }

  it("held with the switch off; listed; lowered to FREE once on; exactly one plan-change audit", async () => {
    const userId = await heldPro(new Date(Date.now() - 86_400_000));
    expect(await planOf(userId)).toBe("PRO");
    expect(await prisma.billingReviewItem.count({ where: { userId, reason: "AUTOMATIC_PLAN_LOWERING_HELD" } })).toBe(1);

    // Switch off: unchanged, but enumerated (the preview reads the same list).
    expect((await handlers.heldPlanLoweringCandidates()).map((c) => c.userId)).toContain(userId);
    await handlers.applyHeldPlanLowerings();
    expect(await planOf(userId)).toBe("PRO");

    // Switch on: the next sweep step lowers it. At the base nothing ever did.
    process.env.BILLING_AUTO_PLAN_LOWERING = "on";
    await handlers.applyHeldPlanLowerings();
    expect(await planOf(userId)).toBe("FREE");
    // A late webhook / second pass changes nothing more.
    await handlers.applyHeldPlanLowerings();
    expect(
      await prisma.adminAuditLog.count({
        where: { action: "billing.entitlement_plan_changed", resourceId: userId, resultingState: "FREE" },
      }),
    ).toBe(1);
  });

  it("a paid period not yet over is not lowered, even with the switch on", async () => {
    const userId = await heldPro(new Date(Date.now() + 5 * 86_400_000));
    process.env.BILLING_AUTO_PLAN_LOWERING = "on";
    await handlers.applyHeldPlanLowerings();
    expect(await planOf(userId)).toBe("PRO");
  });

  it("a payer who bought again (a live subscription) is never lowered", async () => {
    const userId = await heldPro(new Date(Date.now() - 86_400_000));
    await prisma.subscription.create({
      data: {
        userId,
        provider: "STRIPE",
        providerSubId: `sub_${randomUUID().slice(0, 12)}`,
        status: "ACTIVE",
        plan: "PRO",
        currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
        activatedAtUtc: new Date(),
      },
    });
    process.env.BILLING_AUTO_PLAN_LOWERING = "on";
    await handlers.applyHeldPlanLowerings();
    expect(await planOf(userId)).toBe("PRO");
  });
});
