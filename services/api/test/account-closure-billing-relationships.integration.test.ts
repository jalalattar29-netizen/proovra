/**
 * PRO-N1-01 / PRO-N1-12 (WS-BILL, 2026-11-18) — account closure never
 * abandons a provider billing relationship, against live PostgreSQL with the
 * real route registration, preflight and closure processor.
 *
 * At the base, each of these states passed the preflight (blockers []) and the
 * closure processor anonymised the payer while the provider could still bill:
 *   - a recurring storage add-on with no live base subscription;
 *   - an ACTIVE subscription row beside a FREE entitlement;
 *   - a transferred OWNED workspace whose subscription the previous owner bought;
 *   - an add-on bought during the cooling-off window.
 * A cancelled-but-not-ended subscription now SCHEDULES the closure (DEC-21),
 * which completes only after the relationship has ended.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  seedOrganizationTenant,
  seedOwnedWorkspace,
  seedPersonalTenant,
  type FixtureDeps,
} from "./point7/product-fixtures.js";

const GB = BigInt(1024) ** BigInt(3);
const PASSWORD = "ClosureBillingPass123";

describe("PRO-N1-01 — closure and open provider billing relationships (live PostgreSQL)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;
  let preflight: typeof import("../src/services/identity/account-lifecycle-preflight.service.js");
  let closure: typeof import("../src/services/identity/account-closure.service.js");
  let hashPassword: (typeof import("../src/services/email-password-auth.service.js"))["hashPassword"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    preflight = await import("../src/services/identity/account-lifecycle-preflight.service.js");
    closure = await import("../src/services/identity/account-closure.service.js");
    ({ hashPassword } = await import("../src/services/email-password-auth.service.js"));
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `acb-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          secret,
          3600,
        ),
    };
  }, 900_000);

  afterAll(async () => {
    await harness?.cleanup();
  }, 300_000);

  const addon = (ownerUserId: string, teamId: string | null = null) =>
    prisma.workspaceStorageAddon.create({
      data: {
        ownerUserId,
        teamId,
        addonKey: "PERSONAL_10_GB",
        extraStorageBytes: BigInt(10) * GB,
        billingCycle: "MONTHLY",
        status: "ACTIVE",
        paymentProvider: "STRIPE",
        externalSubscriptionId: `sub_addon_${randomUUID().slice(0, 12)}`,
        currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
      },
      select: { id: true },
    });

  const subscription = (userId: string, over: Record<string, unknown> = {}) =>
    prisma.subscription.create({
      data: {
        userId,
        provider: "STRIPE",
        providerSubId: `sub_${randomUUID().slice(0, 12)}`,
        status: "ACTIVE",
        plan: "PRO",
        currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
        ...over,
      },
      select: { id: true },
    });

  const codes = async (userId: string) =>
    (await preflight.evaluateAccountClosurePreflight(userId)).blockers.map((b) => b.code);

  const dueRequest = (userId: string, status = "COOLING_OFF") =>
    prisma.accountClosureRequest.create({
      data: { userId, status, coolingOffEndsAtUtc: new Date(Date.now() - 60_000) },
      select: { id: true },
    });

  const notAnonymised = async (userId: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(u.email).not.toBeNull();
    expect(u.providerUserId).not.toBe(`closed:${userId}`);
  };

  it("a monthly storage add-on alone blocks closure, and the route refuses with 409", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    await addon(t.owner.userId, t.personalTeamId);
    expect(await codes(t.owner.userId)).toContain("BILLING_ADDON_ACTIVE");

    await prisma.user.update({ where: { id: t.owner.userId }, data: { passwordHash: await hashPassword(PASSWORD) } });
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/identity/account-closure",
      headers: { authorization: `Bearer ${t.owner.token}`, "content-type": "application/json" },
      payload: { confirmation: "close my account", stepUp: { method: "password", currentPassword: PASSWORD } },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.body).toContain("BILLING_ADDON_ACTIVE");
    expect(await prisma.accountClosureRequest.count({ where: { userId: t.owner.userId, status: "COOLING_OFF" } })).toBe(0);
  });

  it("an ACTIVE subscription row beside a FREE entitlement still blocks (no FREE short-circuit)", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    await subscription(t.owner.userId);
    expect(await codes(t.owner.userId)).toContain("BILLING_SUBSCRIPTION_ACTIVE");
  });

  it("PAST_DUE beyond grace (the provider may still retry) blocks", async () => {
    const t = await seedPersonalTenant(deps, "PRO");
    await subscription(t.owner.userId, { status: "PAST_DUE", currentPeriodEnd: new Date(Date.now() - 30 * 86_400_000) });
    expect(await codes(t.owner.userId)).toContain("BILLING_SUBSCRIPTION_ACTIVE");
  });

  it("a transferred OWNED workspace's subscription bought by the previous owner blocks the new owner", async () => {
    const previous = await seedPersonalTenant(deps, "PRO");
    const next = await seedPersonalTenant(deps, "FREE");
    const ws = await seedOwnedWorkspace(deps, { ownerUserId: next.owner.userId });
    await subscription(previous.owner.userId, { teamId: ws.teamId });
    // Review G2 — still blocked, but never with "Cancel it": the cancel route
    // acts on the caller's OWN subscription and answers 404 for this one.
    const { blockers } = await preflight.evaluateAccountClosurePreflight(next.owner.userId);
    expect(blockers.map((b) => b.code)).toContain("BILLING_WORKSPACE_PAYER_ACTIVE");
    expect(blockers.map((b) => b.code)).not.toContain("BILLING_SUBSCRIPTION_ACTIVE");
    const told = blockers.find((b) => b.code === "BILLING_WORKSPACE_PAYER_ACTIVE")!;
    expect(told.message).toMatch(/only the person who pays for it can/i);
    expect(told.message).toMatch(/transfer the workspace/i);
    expect(told.message).toMatch(/contact support/i);

    // The dead end the old copy sent them into.
    const cancelAttempt = await harness.app.inject({
      method: "POST",
      url: "/v1/billing/subscription/cancel",
      headers: { authorization: `Bearer ${next.owner.token}`, "content-type": "application/json" },
      payload: "{}",
    });
    expect(cancelAttempt.statusCode).toBe(404);

    // The payer themselves is told to cancel it (their own subscription).
    expect(await codes(previous.owner.userId)).toContain("BILLING_SUBSCRIPTION_ACTIVE");
    // Once the payer has cancelled and it ended, the new owner is no longer blocked.
    await prisma.subscription.updateMany({ where: { teamId: ws.teamId }, data: { status: "CANCELED" } });
    expect(await codes(next.owner.userId)).not.toContain("BILLING_WORKSPACE_PAYER_ACTIVE");
  });

  // ---- Review G1 (a): an open checkout is an open provider relationship -----
  it("an open checkout attempt blocks closure (preflight, route 409, and at execution); a finished one does not", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const attempt = await prisma.billingCheckoutAttempt.create({
      data: {
        userId: t.owner.userId,
        product: "PLAN",
        provider: "STRIPE",
        planKey: "PRO",
        amountCents: 1900,
        currency: "EUR",
        status: "PENDING",
        checkoutState: "AWAITING_CUSTOMER_APPROVAL",
        providerResourceId: `cs_test_${randomUUID().slice(0, 12)}`,
      },
      select: { id: true },
    });
    expect(await codes(t.owner.userId)).toContain("BILLING_CHECKOUT_OPEN");

    await prisma.user.update({ where: { id: t.owner.userId }, data: { passwordHash: await hashPassword(PASSWORD) } });
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/identity/account-closure",
      headers: { authorization: `Bearer ${t.owner.token}`, "content-type": "application/json" },
      payload: { confirmation: "close my account", stepUp: { method: "password", currentPassword: PASSWORD } },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.body).toContain("BILLING_CHECKOUT_OPEN");

    // A checkout opened during cooling-off stops execution too.
    const req = await dueRequest(t.owner.userId);
    await closure.processAccountClosures(new Date());
    expect((await prisma.accountClosureRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("BLOCKED");
    await notAnonymised(t.owner.userId);

    // Cancelled in Billing (ABANDONED), expired or completed: no longer open.
    await prisma.billingCheckoutAttempt.update({ where: { id: attempt.id }, data: { status: "ABANDONED" } });
    expect(await codes(t.owner.userId)).not.toContain("BILLING_CHECKOUT_OPEN");
  });

  // ---- Review G1 (b): a payment arriving after anonymisation ---------------
  it("a plan payment arriving after the account was closed activates nothing and records a review item", async () => {
    const { syncPlanForSubscription } = await import("../src/services/billing/subscription-lifecycle.handlers.js");
    const t = await seedPersonalTenant(deps, "FREE");
    const req = await dueRequest(t.owner.userId);
    await closure.processAccountClosures(new Date());
    expect((await prisma.accountClosureRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("COMPLETED");

    const providerSubId = `sub_${randomUUID().slice(0, 14)}`;
    const outcome = await syncPlanForSubscription({
      userId: t.owner.userId,
      plan: "PRO",
      provider: "STRIPE",
      providerSubId,
      status: "ACTIVE",
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      observedAtUtc: new Date(),
    });
    expect(outcome).toEqual({ outcome: "REFUSED_ACCOUNT_CLOSED" });
    // No live row, no paid entitlement.
    expect(await prisma.subscription.count({ where: { providerSubId } })).toBe(0);
    expect(await prisma.entitlement.count({ where: { userId: t.owner.userId, active: true, plan: "PRO" } })).toBe(0);
    const item = await prisma.billingReviewItem.findFirstOrThrow({
      where: { providerResourceId: providerSubId, reason: "PAYMENT_AFTER_ACCOUNT_CLOSURE" },
    });
    expect(item).toMatchObject({ product: "PLAN", refundReviewRequired: true, providerAction: "NONE", status: "OPEN" });
  });

  it("a storage add-on payment arriving after the account was closed grants no capacity and records a review item", async () => {
    const { applyStorageSubscriptionObservation } = await import("../src/services/billing/storage-activation.service.js");
    const t = await seedPersonalTenant(deps, "FREE");
    const req = await dueRequest(t.owner.userId);
    await closure.processAccountClosures(new Date());
    expect((await prisma.accountClosureRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("COMPLETED");

    const subscriptionId = `sub_addon_${randomUUID().slice(0, 12)}`;
    let providerCancels = 0;
    const result = await applyStorageSubscriptionObservation(
      {
        provider: "STRIPE",
        subscriptionId,
        status: "ACTIVE",
        planId: null,
        claimed: { userId: t.owner.userId, teamId: null, addonKey: "PERSONAL_10_GB" },
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
        observedAtUtc: new Date(),
        source: "provider_webhook",
      },
      {
        cancelAtProvider: (async () => {
          providerCancels += 1;
          return { canceled: true };
        }) as never,
      },
    );
    expect(result).toMatchObject({ outcome: "REFUSED", reason: "ACCOUNT_CLOSED", canceledAtProvider: false });
    expect(providerCancels).toBe(0);
    expect(
      await prisma.workspaceStorageAddon.count({
        where: { externalSubscriptionId: subscriptionId, status: { in: ["ACTIVE", "PAST_DUE"] } },
      }),
    ).toBe(0);
    expect(
      await prisma.billingReviewItem.count({
        where: { providerResourceId: subscriptionId, reason: "PAYMENT_AFTER_ACCOUNT_CLOSURE", refundReviewRequired: true },
      }),
    ).toBe(1);
  });

  it("an add-on bought during cooling-off: BLOCKED at execution, nothing anonymised, the person is told", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const req = await dueRequest(t.owner.userId);
    await addon(t.owner.userId, t.personalTeamId);
    await closure.processAccountClosures(new Date());
    expect((await prisma.accountClosureRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("BLOCKED");
    await notAnonymised(t.owner.userId);
    // PRO-N1-12 — no longer an audit row only.
    expect(
      await prisma.notificationDelivery.count({
        where: { recipientUserId: t.owner.userId, eventType: "ACCOUNT_CLOSURE_BLOCKED" },
      }),
    ).toBe(1);
  });

  it("DEC-21 — a cancelled, not yet ended subscription schedules closure and execution waits for its end", async () => {
    const t = await seedPersonalTenant(deps, "PRO");
    const endsAt = new Date(Date.now() + 20 * 86_400_000);
    const sub = await subscription(t.owner.userId, { cancelAtPeriodEnd: true, canceledAtUtc: new Date(), currentPeriodEnd: endsAt });

    const pre = await preflight.evaluateAccountClosurePreflight(t.owner.userId);
    expect(pre.blockers).toEqual([]);
    expect(pre.billingPending).toEqual({ count: 1, endsAtUtc: endsAt });
    expect(pre.consequences.map((c) => c.code)).toContain("CLOSURE_WAITS_FOR_BILLING_END");

    await prisma.user.update({ where: { id: t.owner.userId }, data: { passwordHash: await hashPassword(PASSWORD) } });
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/identity/account-closure",
      headers: { authorization: `Bearer ${t.owner.token}`, "content-type": "application/json" },
      payload: { confirmation: "close my account", stepUp: { method: "password", currentPassword: PASSWORD } },
    });
    expect(res.statusCode, res.body).toBe(201);
    const created = (JSON.parse(res.body) as { request: { id: string; status: string; coolingOffEndsAtUtc: string } }).request;
    expect(created.status).toBe("SCHEDULED");
    expect(new Date(created.coolingOffEndsAtUtc).getTime()).toBeGreaterThanOrEqual(endsAt.getTime());

    // Due now, but the row is still live (the provider's end not yet recorded).
    await prisma.accountClosureRequest.update({ where: { id: created.id }, data: { coolingOffEndsAtUtc: new Date(Date.now() - 60_000) } });
    await closure.processAccountClosures(new Date());
    const waiting = await prisma.accountClosureRequest.findUniqueOrThrow({ where: { id: created.id } });
    expect(waiting.status).toBe("SCHEDULED");
    expect(waiting.coolingOffEndsAtUtc!.getTime()).toBeGreaterThan(Date.now());
    await notAnonymised(t.owner.userId);

    // The provider's end arrives: the next due run completes the closure.
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: "CANCELED" } });
    await prisma.accountClosureRequest.update({ where: { id: created.id }, data: { coolingOffEndsAtUtc: new Date(Date.now() - 60_000) } });
    await closure.processAccountClosures(new Date());
    expect((await prisma.accountClosureRequest.findUniqueOrThrow({ where: { id: created.id } })).status).toBe("COMPLETED");
  });

  it("no provider relationship at all — closure proceeds", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const req = await dueRequest(t.owner.userId);
    await closure.processAccountClosures(new Date());
    expect((await prisma.accountClosureRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("COMPLETED");
  });

  it("workspace closure uses the same predicate: a workspace add-on blocks it", async () => {
    const t = await seedPersonalTenant(deps, "PRO");
    const ws = await seedOwnedWorkspace(deps, { ownerUserId: t.owner.userId });
    await addon(t.owner.userId, ws.teamId);
    const { blockers } = await preflight.evaluateWorkspaceClosurePreflight(ws.teamId);
    expect(blockers.map((b) => b.code)).toContain("BILLING_SUBSCRIPTION_ACTIVE");
  });

  // ---- Review G3 (d): organisation closure shares the predicate ------------
  it("organisation closure uses the same predicate: a provider-billed add-on or subscription on its workspace blocks it", async () => {
    const org = await seedOrganizationTenant(deps, { billingStatus: "INACTIVE" });
    const orgCodes = async () =>
      (await preflight.evaluateOrganizationClosurePreflight(org.organizationId, org.owner.userId)).blockers.map(
        (b) => b.code,
      );
    // team.billingStatus says nothing is active: the base preflight passed.
    expect(await orgCodes()).not.toContain("BILLING_SUBSCRIPTION_ACTIVE");
    expect(await orgCodes()).not.toContain("BILLING_CONTRACT_ACTIVE");

    const a = await addon(org.owner.userId, org.workspaceId);
    expect(await orgCodes()).toContain("BILLING_SUBSCRIPTION_ACTIVE");
    await prisma.workspaceStorageAddon.update({ where: { id: a.id }, data: { status: "CANCELED" } });
    expect(await orgCodes()).not.toContain("BILLING_SUBSCRIPTION_ACTIVE");

    const sub = await subscription(org.owner.userId, { teamId: org.workspaceId });
    expect(await orgCodes()).toContain("BILLING_SUBSCRIPTION_ACTIVE");
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: "CANCELED" } });
    expect(await orgCodes()).not.toContain("BILLING_SUBSCRIPTION_ACTIVE");
  });
});
