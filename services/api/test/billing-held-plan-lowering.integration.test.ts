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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedPersonalTenant, type FixtureDeps } from "./point7/product-fixtures.js";

/** PayPal's transport only: the cancel is "accepted" and counted, never sent. */
const PAYPAL = vi.hoisted(() => ({ cancelled: [] as string[] }));
vi.mock("../src/services/paypal.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    cancelPayPalSubscription: async (id: string) => {
      PAYPAL.cancelled.push(id);
    },
  };
});

describe("PRO-W2C-01 — held plan lowering is revisited (live PostgreSQL)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;
  let handlers: typeof import("../src/services/billing/subscription-lifecycle.handlers.js");
  let cancel: typeof import("../src/services/billing/subscription-cancellation.service.js")["requestSubscriptionCancellation"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    handlers = await import("../src/services/billing/subscription-lifecycle.handlers.js");
    ({ requestSubscriptionCancellation: cancel } = await import(
      "../src/services/billing/subscription-cancellation.service.js"
    ));
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

  // ---- BILLING HOLDS (review HIGH-MONEY-DISCLOSURE, 2026-11-19) -------------
  // `finalizeEndedPayPalPaidPeriods` lowered EVERY ended PayPal row to FREE with
  // no switch test, including rows the same sweep pass had just held. The case
  // that stood here asserted that as intended, on a row with nothing but
  // `canceledAtUtc` (which every provider fact writes).

  const payPalId = () => `I-${randomUUID().slice(0, 12).toUpperCase()}`;
  const heldItems = (providerSubId: string) =>
    prisma.billingReviewItem.count({
      where: { provider: "PAYPAL", providerResourceId: providerSubId, reason: "AUTOMATIC_PLAN_LOWERING_HELD" },
    });

  /** A PayPal Pro plan whose end the SWEEP learned of after the paid period, with lowering held. */
  async function sweepHeldPayPal() {
    const t = await seedPersonalTenant(deps, "PRO");
    const providerSubId = payPalId();
    const periodEnd = new Date(Date.now() - 86_400_000);
    const row = await prisma.subscription.create({
      data: {
        userId: t.owner.userId,
        provider: "PAYPAL",
        providerSubId,
        status: "ACTIVE",
        plan: "PRO",
        currentPeriodEnd: periodEnd,
        activatedAtUtc: new Date(Date.now() - 40 * 86_400_000),
      },
    });
    // The production writer, exactly as reconciliation calls it with the switch off.
    await handlers.syncPlanForSubscription({
      userId: t.owner.userId,
      plan: "PRO",
      provider: "PAYPAL",
      providerSubId,
      status: "CANCELED",
      currentPeriodEnd: periodEnd,
      observedAtUtc: new Date(),
      holdPlanLowering: true,
    });
    return { userId: t.owner.userId, providerSubId, subscriptionId: row.id };
  }

  it("a sweep-held PayPal row is NOT lowered by the paid-period step while the switch is off", async () => {
    const s = await sweepHeldPayPal();
    expect(await planOf(s.userId)).toBe("PRO");
    expect(await heldItems(s.providerSubId)).toBe(1);

    // The same sweep run reaches this step next. At the base it lowered to FREE.
    const result = await handlers.finalizeEndedPayPalPaidPeriods();
    expect(await planOf(s.userId)).toBe("PRO");
    expect(result.held).toBeGreaterThanOrEqual(1);
    const listed = (await handlers.endedPayPalPaidPeriodCandidates()).find((c) => c.userId === s.userId);
    expect(listed).toMatchObject({ subscriptionId: s.subscriptionId, customerCancelled: false, sweepHeld: true });
    // And again: still held, still one review item.
    await handlers.finalizeEndedPayPalPaidPeriods();
    expect(await planOf(s.userId)).toBe("PRO");
    expect(await heldItems(s.providerSubId)).toBe(1);
  });

  it("an ended PayPal row with no proof of a customer cancellation is held and gets a review item", async () => {
    // Cancelled at PayPal (or by a payment failure): the webhook kept the paid
    // period; `canceledAtUtc` is set by the provider fact and proves nothing.
    const t = await seedPersonalTenant(deps, "PRO");
    const providerSubId = payPalId();
    await prisma.subscription.create({
      data: {
        userId: t.owner.userId,
        provider: "PAYPAL",
        providerSubId,
        status: "CANCELED",
        plan: "PRO",
        currentPeriodEnd: new Date(Date.now() - 60_000),
        activatedAtUtc: new Date(Date.now() - 30 * 86_400_000),
        canceledAtUtc: new Date(Date.now() - 86_400_000),
      },
    });
    await handlers.finalizeEndedPayPalPaidPeriods();
    expect(await planOf(t.owner.userId)).toBe("PRO");
    expect(await heldItems(providerSubId)).toBe(1);
    // The held set the release step reads now contains it too.
    expect((await handlers.heldPlanLoweringCandidates()).map((c) => c.userId)).toContain(t.owner.userId);
  });

  it("a customer's own cancellation (PROOVRA's cancel path) keeps the paid period, then the plan ends — switch off", async () => {
    const t = await seedPersonalTenant(deps, "PRO");
    const providerSubId = payPalId();
    const row = await prisma.subscription.create({
      data: {
        userId: t.owner.userId,
        provider: "PAYPAL",
        providerSubId,
        status: "ACTIVE",
        plan: "PRO",
        currentPeriodEnd: new Date(Date.now() + 3 * 86_400_000),
        activatedAtUtc: new Date(Date.now() - 27 * 86_400_000),
      },
    });
    // The real cancel service; only PayPal's transport is replaced.
    const outcome = await cancel({ subscriptionId: row.id });
    expect(outcome.mode).toBe("IMMEDIATE");
    expect(PAYPAL.cancelled).toContain(providerSubId);
    const recorded = await prisma.subscription.findUniqueOrThrow({ where: { id: row.id } });
    expect(recorded.customerCancelRequestedAtUtc).not.toBeNull();

    // PayPal's CANCELLED event lands (webhook path: no sweep hold).
    await handlers.syncPlanForSubscription({
      userId: t.owner.userId,
      plan: "PRO",
      provider: "PAYPAL",
      providerSubId,
      status: "CANCELED",
      currentPeriodEnd: recorded.currentPeriodEnd,
      observedAtUtc: new Date(),
    });
    // Inside the paid period: kept (DEC-02).
    await handlers.finalizeEndedPayPalPaidPeriods();
    expect(await planOf(t.owner.userId)).toBe("PRO");

    // The period is over: the plan ends although automatic lowering is off.
    await prisma.subscription.update({ where: { id: row.id }, data: { currentPeriodEnd: new Date(Date.now() - 60_000) } });
    const listed = (await handlers.endedPayPalPaidPeriodCandidates()).find((c) => c.userId === t.owner.userId);
    expect(listed).toMatchObject({ customerCancelled: true, sweepHeld: false });
    await handlers.finalizeEndedPayPalPaidPeriods();
    expect(await planOf(t.owner.userId)).toBe("FREE");
    expect(await heldItems(providerSubId)).toBe(0);
  });

  it("with the switch ON the held PayPal row is lowered", async () => {
    const s = await sweepHeldPayPal();
    await handlers.finalizeEndedPayPalPaidPeriods();
    expect(await planOf(s.userId)).toBe("PRO");

    process.env.BILLING_AUTO_PLAN_LOWERING = "on";
    await handlers.finalizeEndedPayPalPaidPeriods();
    expect(await planOf(s.userId)).toBe("FREE");
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
