/**
 * FREE-AUDIT REMEDIATION (2026-11-13, DUP-STORAGE) — the settlement half of the
 * personal storage duplicate rule, on live PostgreSQL. No provider is called: the
 * provider cancellation is an injected canceller, and observations are what the
 * webhooks, return routes and sweep hand to the ONE activation authority.
 *
 * The rule: stacking a size is allowed only knowingly (checkout asks the customer
 * to confirm a size they hold). A purchase STARTED before another add-on of the
 * same size went live was never that decision. Its activation is not granted: it
 * is stopped at the provider and sent to refund review — or, in the sweep while
 * BILLING_AUTO_ADDON_CANCELLATION is held, left ungranted and uncancelled with a
 * review item that says so.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedPersonalTenant, type FixtureDeps } from "./point7/product-fixtures.js";
import type { StorageObservation } from "../src/services/billing/storage-activation.service.js";

const KEY = "PERSONAL_10_GB" as const;
const OTHER_KEY = "PERSONAL_50_GB" as const;
const PLAN_ID = "P-DUPTEST";

describe("personal storage duplicate activation (live PostgreSQL)", () => {
  let harness: IntegrationHarness;
  let deps: FixtureDeps;
  // Loaded once, after the harness has pointed the application at its database
  // (the established pattern: the db module reads its URL when first imported).
  let prisma: typeof import("../src/db.js")["prisma"];
  let applyStorageSubscriptionObservation: typeof import("../src/services/billing/storage-activation.service.js")["applyStorageSubscriptionObservation"];
  const tag = `sdup-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ applyStorageSubscriptionObservation } = await import("../src/services/billing/storage-activation.service.js"));
    const { signJwt } = await import("../src/services/jwt.js");
    deps = {
      prisma: prisma as never,
      tag,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          process.env.AUTH_JWT_SECRET!,
          60 * 60,
        ),
    };
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  const freeUser = async () => (await seedPersonalTenant(deps, "FREE")).owner.userId;
  const ago = (ms: number) => new Date(Date.now() - ms);

  /** A PayPal storage purchase: the add-on row IS its attempt. */
  const paypalPurchase = (userId: string, startedAt: Date, addonKey: typeof KEY | typeof OTHER_KEY = KEY) =>
    prisma.workspaceStorageAddon.create({
      data: {
        ownerUserId: userId,
        teamId: null,
        addonKey,
        extraStorageBytes: 1n,
        billingCycle: "MONTHLY",
        status: "PENDING",
        paymentProvider: "PAYPAL",
        currency: "EUR",
        externalSubscriptionId: `I-${randomUUID().slice(0, 12).toUpperCase()}`,
        createdAt: startedAt,
        metadata: { providerPlanId: PLAN_ID, checkoutState: "AWAITING_CUSTOMER_APPROVAL" },
      },
    });

  /** A Stripe storage purchase: a checkout attempt bound to its session. */
  const stripePurchase = (userId: string, startedAt: Date, addonKey: typeof KEY | typeof OTHER_KEY = KEY) =>
    prisma.billingCheckoutAttempt.create({
      data: {
        userId,
        product: "STORAGE_ADDON",
        provider: "STRIPE",
        storageAddonKey: addonKey,
        amountCents: 299,
        currency: "EUR",
        status: "PENDING",
        checkoutState: "AWAITING_CUSTOMER_APPROVAL",
        providerResourceId: `cs_test_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        createdAt: startedAt,
      },
    });

  const paypalActivated = (
    row: { id: string; ownerUserId: string; addonKey: string; externalSubscriptionId: string | null },
    source = "paypal.webhook",
  ): StorageObservation => ({
    provider: "PAYPAL",
    subscriptionId: row.externalSubscriptionId!,
    status: "ACTIVE",
    planId: PLAN_ID,
    claimed: { userId: row.ownerUserId, teamId: null, addonKey: row.addonKey as typeof KEY, attemptId: row.id },
    currentPeriodEnd: null,
    observedAtUtc: new Date(),
    source,
  });

  const stripeActivated = (
    attempt: { id: string; userId: string; storageAddonKey: string | null },
    source = "stripe.webhook",
  ): StorageObservation => ({
    provider: "STRIPE",
    subscriptionId: `sub_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
    status: "ACTIVE",
    planId: null,
    claimed: { userId: attempt.userId, teamId: null, addonKey: attempt.storageAddonKey as typeof KEY, attemptId: null },
    currentPeriodEnd: null,
    observedAtUtc: new Date(),
    source,
    checkoutAttemptId: attempt.id,
  });

  const liveCount = (userId: string, addonKey: string = KEY) =>
    prisma.workspaceStorageAddon.count({
      where: { ownerUserId: userId, addonKey: addonKey as typeof KEY, status: { in: ["ACTIVE", "PAST_DUE"] } },
    });

  it("card and PayPal bought the same size: the first to go live is granted, the other is stopped and sent to refund review", async () => {
    const userId = await freeUser();
    const paypal = await paypalPurchase(userId, ago(10 * 60_000));
    const stripe = await stripePurchase(userId, ago(5 * 60_000));
    const cancelAtProvider = vi.fn(async () => ({ ok: true }));

    const first = await applyStorageSubscriptionObservation(stripeActivated(stripe), { cancelAtProvider: cancelAtProvider as never });
    expect(first.outcome).toBe("GRANTED");

    const second = await applyStorageSubscriptionObservation(paypalActivated(paypal), { cancelAtProvider: cancelAtProvider as never });
    expect(second).toMatchObject({ outcome: "REFUSED", reason: "DUPLICATE_PURCHASE", canceledAtProvider: true });
    expect(cancelAtProvider).toHaveBeenCalledWith({
      provider: "PAYPAL",
      providerRef: paypal.externalSubscriptionId,
      mode: "IMMEDIATE",
    });
    expect((await prisma.workspaceStorageAddon.findUniqueOrThrow({ where: { id: paypal.id } })).status).toBe("FAILED");
    expect(await liveCount(userId)).toBe(1);
    const review = await prisma.billingReviewItem.findFirstOrThrow({
      where: { userId, providerResourceId: paypal.externalSubscriptionId! },
    });
    expect(review).toMatchObject({
      reason: "DUPLICATE_STORAGE_PURCHASE",
      product: "STORAGE_ADDON",
      providerAction: "CANCELED_AT_PROVIDER",
      refundReviewRequired: true,
    });

    // A redelivery decides nothing new and calls the provider no more.
    const again = await applyStorageSubscriptionObservation(paypalActivated(paypal), { cancelAtProvider: cancelAtProvider as never });
    expect(again.outcome).toBe("UNCHANGED");
    expect(cancelAtProvider).toHaveBeenCalledTimes(1);
    expect(await liveCount(userId)).toBe(1);
  });

  it("a purchase made after the first went live (a confirmed addition) and a different size are both granted", async () => {
    const userId = await freeUser();
    const cancelAtProvider = vi.fn(async () => ({ ok: true }));
    const earlier = await stripePurchase(userId, ago(2 * 86_400_000));
    expect((await applyStorageSubscriptionObservation(stripeActivated(earlier), { cancelAtProvider: cancelAtProvider as never })).outcome).toBe("GRANTED");
    // Started after the first was live: checkout asked, and the customer confirmed.
    await prisma.workspaceStorageAddon.updateMany({
      where: { ownerUserId: userId, addonKey: KEY, status: "ACTIVE" },
      data: { activatedAtUtc: ago(86_400_000) },
    });
    const addition = await paypalPurchase(userId, ago(60_000));
    expect((await applyStorageSubscriptionObservation(paypalActivated(addition), { cancelAtProvider: cancelAtProvider as never })).outcome).toBe("GRANTED");
    const otherSize = await stripePurchase(userId, ago(30 * 86_400_000), OTHER_KEY);
    expect((await applyStorageSubscriptionObservation(stripeActivated(otherSize), { cancelAtProvider: cancelAtProvider as never })).outcome).toBe("GRANTED");
    expect(cancelAtProvider).not.toHaveBeenCalled();
    expect(await liveCount(userId)).toBe(2);
    expect(await liveCount(userId, OTHER_KEY)).toBe(1);
  });

  it("the sweep holds the stop while automatic add-on cancellation is off: nothing granted, nothing cancelled, a review item", async () => {
    const previous = process.env.BILLING_AUTO_ADDON_CANCELLATION;
    delete process.env.BILLING_AUTO_ADDON_CANCELLATION;
    try {
      const userId = await freeUser();
      const paypal = await paypalPurchase(userId, ago(10 * 60_000));
      const stripe = await stripePurchase(userId, ago(5 * 60_000));
      const cancelAtProvider = vi.fn(async () => ({ ok: true }));
      expect((await applyStorageSubscriptionObservation(stripeActivated(stripe), { cancelAtProvider: cancelAtProvider as never })).outcome).toBe("GRANTED");

      const held = await applyStorageSubscriptionObservation(paypalActivated(paypal, "billing_reconciliation"), {
        cancelAtProvider: cancelAtProvider as never,
      });
      expect(held).toMatchObject({ outcome: "REFUSED", reason: "DUPLICATE_PURCHASE", canceledAtProvider: false });
      expect(cancelAtProvider).not.toHaveBeenCalled();
      expect((await prisma.workspaceStorageAddon.findUniqueOrThrow({ where: { id: paypal.id } })).status).toBe("PENDING");
      expect(await liveCount(userId)).toBe(1);
      expect(
        await prisma.billingReviewItem.findFirstOrThrow({ where: { userId, providerResourceId: paypal.externalSubscriptionId! } }),
      ).toMatchObject({ reason: "DUPLICATE_STORAGE_PURCHASE", providerAction: "NONE", refundReviewRequired: true });

      // The provider's own event still applies the refusal in full, onto the same review item.
      const webhook = await applyStorageSubscriptionObservation(paypalActivated(paypal), { cancelAtProvider: cancelAtProvider as never });
      expect(webhook).toMatchObject({ outcome: "REFUSED", canceledAtProvider: true });
      expect(await prisma.billingReviewItem.count({ where: { userId, providerResourceId: paypal.externalSubscriptionId! } })).toBe(1);
      expect(
        (await prisma.billingReviewItem.findFirstOrThrow({ where: { userId, providerResourceId: paypal.externalSubscriptionId! } })).providerAction,
      ).toBe("CANCELED_AT_PROVIDER");
    } finally {
      if (previous === undefined) delete process.env.BILLING_AUTO_ADDON_CANCELLATION;
      else process.env.BILLING_AUTO_ADDON_CANCELLATION = previous;
    }
  });

  it("two activations at the same moment: exactly one is granted, every time", async () => {
    for (let round = 0; round < 4; round++) {
      const userId = await freeUser();
      const paypal = await paypalPurchase(userId, ago(10 * 60_000));
      const stripe = await stripePurchase(userId, ago(9 * 60_000));
      const cancelAtProvider = vi.fn(async () => ({ ok: true }));
      const results = await Promise.all([
        applyStorageSubscriptionObservation(paypalActivated(paypal), { cancelAtProvider: cancelAtProvider as never }),
        applyStorageSubscriptionObservation(stripeActivated(stripe), { cancelAtProvider: cancelAtProvider as never }),
      ]);
      expect(results.map((r) => r.outcome).sort()).toEqual(["GRANTED", "REFUSED"]);
      expect(await liveCount(userId)).toBe(1);
      expect(cancelAtProvider).toHaveBeenCalledTimes(1);
    }
  });

  it("the same activation delivered twice is not a duplicate of itself", async () => {
    const userId = await freeUser();
    const paypal = await paypalPurchase(userId, ago(60_000));
    const cancelAtProvider = vi.fn(async () => ({ ok: true }));
    const results = await Promise.all([
      applyStorageSubscriptionObservation(paypalActivated(paypal), { cancelAtProvider: cancelAtProvider as never }),
      applyStorageSubscriptionObservation(paypalActivated(paypal, "paypal.return_confirm"), { cancelAtProvider: cancelAtProvider as never }),
    ]);
    expect(results.some((r) => r.outcome === "REFUSED")).toBe(false);
    expect(cancelAtProvider).not.toHaveBeenCalled();
    expect(await liveCount(userId)).toBe(1);
  });
});
