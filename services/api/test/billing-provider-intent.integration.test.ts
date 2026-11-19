/**
 * PRO-BL1-01 (WS-BILL, 2026-11-18) — provider mutations carry a durable
 * business-intent identity, against live PostgreSQL.
 *
 * WHAT IS REAL HERE
 * ---------------------------------------------------------------------------
 * `requestSubscriptionCancellation`, `requestSubscriptionResume`, the intent
 * columns, the dependent-obligation writes and `upsertSubscription`. Only the
 * Stripe TRANSPORT is replaced, by a fake that implements Stripe's documented
 * idempotency contract: a repeated `Idempotency-Key` returns the STORED first
 * response without executing. That contract is exactly what made the old
 * hour-bucketed key unsafe: cancel -> restart -> cancel inside one UTC hour
 * replayed the first cancel's answer while the subscription kept renewing.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedPersonalTenant, type FixtureDeps } from "./point7/product-fixtures.js";

/** The fake provider: live state per subscription plus an idempotency store. */
const FAKE = vi.hoisted(() => ({
  live: new Map<string, { cancel_at_period_end: boolean; current_period_end: number }>(),
  stored: new Map<string, Record<string, unknown>>(),
  keys: [] as string[],
  /** Make the NEXT keyed POST execute and then lose its answer. */
  loseNextAnswer: false,
  /** Make the NEXT keyed POST be refused with a 4xx (nothing executed). */
  refuseNext: false,
  /** Answer the NEXT keyed POST with this stored body, executing nothing. */
  staleAnswer: null as Record<string, unknown> | null,
  /** PRO-BL1-02 — customers a portal session was opened for. */
  portalCustomers: [] as string[],
}));

vi.mock("../src/services/stripe.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const StripeHttpError = actual.StripeHttpError as new (...args: unknown[]) => Error;
  return {
    ...actual,
    stripeRequest: async (path: string, body: URLSearchParams, options: { idempotencyKey?: string | null } = {}) => {
      const key = options.idempotencyKey ?? null;
      if (key) {
        FAKE.keys.push(key);
        const replay = FAKE.stored.get(key);
        if (replay) return { ...replay };
      }
      if (FAKE.staleAnswer) {
        const stale = FAKE.staleAnswer;
        FAKE.staleAnswer = null;
        return { ...stale };
      }
      if (FAKE.refuseNext) {
        FAKE.refuseNext = false;
        const err = Object.create(StripeHttpError.prototype) as Error & { status: number };
        err.message = "stripe refused";
        err.status = 400;
        throw err;
      }
      if (path === "/billing_portal/sessions") {
        FAKE.portalCustomers.push(body.get("customer") ?? "");
        return { id: "bps_test", url: "https://billing.stripe.com/p/session/test_bl102" };
      }
      const id = decodeURIComponent(path.replace("/subscriptions/", ""));
      const state = FAKE.live.get(id);
      if (!state) throw new Error(`unknown fake subscription ${id}`);
      if (body.has("cancel_at_period_end")) state.cancel_at_period_end = body.get("cancel_at_period_end") === "true";
      const response = { id, ...state };
      if (key) FAKE.stored.set(key, { ...response });
      if (FAKE.loseNextAnswer) {
        FAKE.loseNextAnswer = false;
        throw new Error("socket hang up");
      }
      return response;
    },
    stripeGet: async (path: string) => {
      const id = decodeURIComponent(path.replace("/subscriptions/", ""));
      const state = FAKE.live.get(id);
      if (!state) throw new Error(`unknown fake subscription ${id}`);
      return { id, customer: `cus_${id}`, ...state };
    },
    stripeRequestRaw: async () => ({}),
  };
});

const PERIOD_END = Math.floor(new Date("2027-01-01T00:00:00.000Z").getTime() / 1000);

describe("PRO-BL1-01 — provider intent identity (live PostgreSQL)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;
  let cancel: typeof import("../src/services/billing/subscription-cancellation.service.js")["requestSubscriptionCancellation"];
  let resume: typeof import("../src/services/billing/subscription-resume.service.js")["requestSubscriptionResume"];
  let upsertSubscription: typeof import("../src/services/billing.service.js")["upsertSubscription"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ requestSubscriptionCancellation: cancel } = await import(
      "../src/services/billing/subscription-cancellation.service.js"
    ));
    ({ requestSubscriptionResume: resume } = await import(
      "../src/services/billing/subscription-resume.service.js"
    ));
    ({ upsertSubscription } = await import("../src/services/billing.service.js"));
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `bpi-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          {
            sub: userId,
            provider: "EMAIL",
            email,
            authMethod: "PASSWORD",
            authAt: Math.floor(Date.now() / 1000),
          },
          secret,
          60 * 60,
        ),
    };
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  beforeEach(() => {
    FAKE.stored.clear();
    FAKE.keys.length = 0;
    FAKE.loseNextAnswer = false;
    FAKE.refuseNext = false;
    FAKE.staleAnswer = null;
  });

  async function seedStripePro() {
    const t = await seedPersonalTenant(deps, "PRO", { credits: 0 });
    const providerSubId = `sub_${randomUUID().replace(/-/g, "")}`;
    FAKE.live.set(providerSubId, { cancel_at_period_end: false, current_period_end: PERIOD_END });
    const sub = await prisma.subscription.create({
      data: {
        userId: t.owner.userId,
        provider: "STRIPE",
        providerSubId,
        status: "ACTIVE",
        plan: "PRO",
        currentPeriodEnd: new Date(PERIOD_END * 1000),
        activatedAtUtc: new Date(),
      },
      select: { id: true },
    });
    return { userId: t.owner.userId, subscriptionId: sub.id, providerSubId, token: t.owner.token };
  }

  it("cancel -> restart -> cancel inside one hour really cancels at the provider", async () => {
    const s = await seedStripePro();

    const first = await cancel({ subscriptionId: s.subscriptionId });
    expect(first.cancelAtPeriodEnd).toBe(true);
    expect(FAKE.live.get(s.providerSubId)!.cancel_at_period_end).toBe(true);

    const restarted = await resume({ subscriptionId: s.subscriptionId });
    expect(restarted.result).toBe("RESUMED");
    expect(FAKE.live.get(s.providerSubId)!.cancel_at_period_end).toBe(false);

    const second = await cancel({ subscriptionId: s.subscriptionId });
    expect(second.cancelAtPeriodEnd).toBe(true);
    expect(second.alreadyScheduled).toBe(false);
    // THE regression: at the base the second cancel re-sent the first key, the
    // provider replayed "true" without executing, and it kept renewing.
    expect(FAKE.live.get(s.providerSubId)!.cancel_at_period_end).toBe(true);

    const cancelKeys = FAKE.keys.filter((k) => k.startsWith("proovra-cancel-"));
    expect(cancelKeys).toHaveLength(2);
    expect(new Set(cancelKeys).size).toBe(2);

    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: s.subscriptionId } });
    expect(row.cancelAtPeriodEnd).toBe(true);
    // The intent is settled once the provider confirmed and it was recorded.
    expect(row.providerIntentKey).toBeNull();
  });

  it("a stale stored answer is never recorded: the live read must agree", async () => {
    const s = await seedStripePro();
    // A provider answering from a stored response although the subscription
    // still renews (what a replayed key does).
    FAKE.staleAnswer = { id: s.providerSubId, cancel_at_period_end: true, current_period_end: PERIOD_END };
    await expect(cancel({ subscriptionId: s.subscriptionId })).rejects.toMatchObject({
      publicCode: "PROVIDER_CANCELLATION_FAILED",
    });
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: s.subscriptionId } });
    expect(row.cancelAtPeriodEnd).toBe(false);
    expect(row.canceledAtUtc).toBeNull();
    // Refused-and-settled: the next attempt is a new intent.
    expect(row.providerIntentKey).toBeNull();
  });

  it("a lost answer is retried under the SAME intent key and then verified", async () => {
    const s = await seedStripePro();
    FAKE.loseNextAnswer = true;
    await expect(cancel({ subscriptionId: s.subscriptionId })).rejects.toMatchObject({
      publicCode: "PROVIDER_CANCELLATION_OUTCOME_UNKNOWN",
    });
    const pending = await prisma.subscription.findUniqueOrThrow({ where: { id: s.subscriptionId } });
    // Nothing recorded locally; the intent stays open for the retry.
    expect(pending.cancelAtPeriodEnd).toBe(false);
    expect(pending.providerIntentKey).toMatch(/^proovra-cancel-/);

    const retried = await cancel({ subscriptionId: s.subscriptionId });
    expect(retried.cancelAtPeriodEnd).toBe(true);
    const cancelKeys = FAKE.keys.filter((k) => k.startsWith("proovra-cancel-"));
    expect(cancelKeys).toHaveLength(2);
    expect(cancelKeys[0]).toBe(cancelKeys[1]);
  });

  it("a provider refusal leaves the row untouched and closes the intent", async () => {
    const s = await seedStripePro();
    FAKE.refuseNext = true;
    await expect(cancel({ subscriptionId: s.subscriptionId })).rejects.toMatchObject({
      publicCode: "PROVIDER_CANCELLATION_FAILED",
    });
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: s.subscriptionId } });
    expect(row.cancelAtPeriodEnd).toBe(false);
    expect(row.canceledAtUtc).toBeNull();
    expect(row.providerIntentKey).toBeNull();
    const dependants = await prisma.workspaceStorageAddon.count({
      where: { ownerUserId: s.userId, dependentCancellationTriggeredBySubscriptionId: s.subscriptionId },
    });
    expect(dependants).toBe(0);
  });

  it("PRO-BL1-02 — the payer opens the provider's billing page for their own subscription's customer; no subscription is 404", async () => {
    const s = await seedStripePro();
    const token = s.token;
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/billing/subscription/payment-management",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: "{}",
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).paymentManagement).toEqual({
      provider: "STRIPE",
      url: "https://billing.stripe.com/p/session/test_bl102",
    });
    expect(FAKE.portalCustomers).toEqual([`cus_${s.providerSubId}`]);

    const free = await seedPersonalTenant(deps, "FREE", { credits: 0 });
    const none = await harness.app.inject({
      method: "POST",
      url: "/v1/billing/subscription/payment-management",
      headers: { authorization: `Bearer ${free.owner.token}`, "content-type": "application/json" },
      payload: "{}",
    });
    expect(none.statusCode).toBe(404);
  });

  it("a renewing fact against a confirmed customer cancellation is never silent", async () => {
    const s = await seedStripePro();
    await cancel({ subscriptionId: s.subscriptionId });
    const cancelled = await prisma.subscription.findUniqueOrThrow({ where: { id: s.subscriptionId } });

    // An OLDER fact (the state before the cancellation) does not undo it.
    await upsertSubscription({
      userId: s.userId,
      provider: "STRIPE",
      providerSubId: s.providerSubId,
      status: "ACTIVE",
      plan: "PRO",
      cancelAtPeriodEnd: false,
      observedAtUtc: new Date(cancelled.canceledAtUtc!.getTime() - 60_000),
    });
    const afterStale = await prisma.subscription.findUniqueOrThrow({ where: { id: s.subscriptionId } });
    expect(afterStale.cancelAtPeriodEnd).toBe(true);
    expect(
      await prisma.billingReviewItem.count({
        where: { providerResourceId: s.providerSubId, reason: "CANCELLATION_REVERSED_AT_PROVIDER" },
      }),
    ).toBe(0);

    // A NEWER provider fact is the truth about billing: applied, and reviewed.
    await upsertSubscription({
      userId: s.userId,
      provider: "STRIPE",
      providerSubId: s.providerSubId,
      status: "ACTIVE",
      plan: "PRO",
      cancelAtPeriodEnd: false,
      observedAtUtc: new Date(cancelled.canceledAtUtc!.getTime() + 60_000),
    });
    const afterNewer = await prisma.subscription.findUniqueOrThrow({ where: { id: s.subscriptionId } });
    expect(afterNewer.cancelAtPeriodEnd).toBe(false);
    expect(
      await prisma.billingReviewItem.count({
        where: { providerResourceId: s.providerSubId, reason: "CANCELLATION_REVERSED_AT_PROVIDER", status: "OPEN" },
      }),
    ).toBe(1);
  });
});
