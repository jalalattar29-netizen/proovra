/**
 * NEW-RG-02-1 (owner decision H, 2026-11-21) — the sweep keeps retrying the
 * provider cancel of a superseded duplicate base subscription ONLY for a
 * conclusive duplicate with a valid retained subscription; everything else is a
 * review item and no provider mutation. Live PostgreSQL; the provider side is
 * faked (an injected reader and canceller), and the real Stripe / PayPal
 * transports are replaced so no request can leave the process.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

vi.mock("../src/services/stripe.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    stripeGet: async () => {
      throw new Error("no real Stripe read in this test");
    },
    stripeRequestRaw: async () => {
      throw new Error("no real Stripe write in this test");
    },
  };
});
vi.mock("../src/services/paypal.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getPayPalSubscription: async () => {
      throw new Error("no real PayPal read in this test");
    },
    cancelPayPalSubscription: async () => {
      throw new Error("no real PayPal write in this test");
    },
  };
});

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY = 86_400_000;

type ObservedState = "SUCCEEDED" | "FAILED" | "CANCELED" | "EXPIRED" | "PENDING" | "UNKNOWN";

describe("NEW-RG-02-1 — superseded duplicate cancellation is a narrow exception (live PostgreSQL)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let handlers: typeof import("../src/services/billing/subscription-lifecycle.handlers.js");
  let billing: typeof import("../src/services/billing.service.js");
  let effects: typeof import("../src/services/billing/automatic-effects.js");

  /** Provider facts by subscription reference; anything absent does not answer. */
  const facts = new Map<string, { state: ObservedState; cancelAtPeriodEnd?: boolean; providerStatus?: string }>();
  /** Every cancel the step asked for, across the whole file. */
  const cancelCalls: Array<{ provider: string; ref: string }> = [];
  /** References that must never be cancelled (retained subscriptions). */
  const retainedRefs = new Set<string>();

  const readProvider = async (_provider: string, ref: string) => {
    const f = facts.get(ref);
    if (!f) return null;
    const raw = f.providerStatus ?? (f.state === "SUCCEEDED" ? "active" : f.state === "CANCELED" ? "canceled" : null);
    return { state: f.state, cancelAtPeriodEnd: f.cancelAtPeriodEnd === true, observedAtUtc: new Date(), providerStatus: raw };
  };
  const cancel = async (provider: string, ref: string) => {
    cancelCalls.push({ provider, ref });
    facts.set(ref, { state: "CANCELED" });
    return { canceled: true, observedAtUtc: new Date() };
  };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    handlers = await import("../src/services/billing/subscription-lifecycle.handlers.js");
    billing = await import("../src/services/billing.service.js");
    effects = await import("../src/services/billing/automatic-effects.js");
  }, 900_000);

  afterEach(() => {
    // The step never cancels a retained subscription, in any case.
    for (const call of cancelCalls) expect(retainedRefs.has(call.ref), call.ref).toBe(false);
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  async function user(plan: "PRO" | "TEAM" = "PRO") {
    const id = randomUUID();
    const email = `rg02-${id}@example.test`;
    await prisma.user.create({ data: { id, email, provider: "EMAIL", providerUserId: email } });
    await billing.ensureEntitlement(id);
    await billing.setPersonalPlan(id, plan);
    return id;
  }

  async function sub(userId: string, data: Record<string, unknown> = {}) {
    const ref = `sub_${randomUUID().slice(0, 14)}`;
    return prisma.subscription.create({
      data: {
        userId,
        provider: "STRIPE",
        providerSubId: ref,
        plan: "PRO",
        status: "ACTIVE",
        currentPeriodEnd: new Date(Date.now() + 20 * DAY),
        activatedAtUtc: new Date(Date.now() - 10 * DAY),
        ...data,
      } as never,
    });
  }

  /** A retained subscription (active at the provider) and its superseded duplicate, due now. */
  async function pair(opts: {
    retainedOwner?: string;
    retained?: Record<string, unknown>;
    retainedAtProvider?: ObservedState | null;
    duplicateAtProvider?: ObservedState | null;
    retainedId?: string;
  } = {}) {
    const userId = await user("PRO");
    const retained = opts.retainedId
      ? null
      : await sub(opts.retainedOwner ?? userId, { provider: "STRIPE", ...opts.retained });
    if (retained) {
      retainedRefs.add(retained.providerSubId);
      if (opts.retainedAtProvider !== null) facts.set(retained.providerSubId, { state: opts.retainedAtProvider ?? "SUCCEEDED" });
    }
    const duplicate = await sub(userId, {
      provider: "PAYPAL",
      providerSubId: `I-${randomUUID().slice(0, 12)}`,
      supersededBySubscriptionId: opts.retainedId ?? retained!.id,
      supersessionCancelState: "RETRY_SCHEDULED",
      supersessionCancelAttemptCount: 1,
      supersessionCancelNextRetryAtUtc: new Date(Date.now() - 60_000),
    });
    if (opts.duplicateAtProvider !== null) facts.set(duplicate.providerSubId, { state: opts.duplicateAtProvider ?? "SUCCEEDED" });
    return { userId, retained, duplicate };
  }

  const row = (id: string) => prisma.subscription.findUniqueOrThrow({ where: { id } });
  const plan = async (userId: string) =>
    (await prisma.entitlement.findFirstOrThrow({ where: { userId, active: true }, orderBy: { createdAt: "desc" } })).plan;
  const reviews = (ref: string) => prisma.billingReviewItem.findMany({ where: { providerResourceId: ref } });
  const callsFor = (ref: string) => cancelCalls.filter((c) => c.ref === ref);
  const retry = (now = new Date()) =>
    handlers.retrySupersededCancellations({ now, cancel: cancel as never, readProvider: readProvider as never, limit: 500 });

  it("a conclusive duplicate is cancelled once at the provider; a second sweep asks nothing (idempotent)", async () => {
    const { userId, retained, duplicate } = await pair();
    await retry();
    expect(callsFor(duplicate.providerSubId)).toEqual([{ provider: "PAYPAL", ref: duplicate.providerSubId }]);
    expect(await row(duplicate.id)).toMatchObject({ status: "CANCELED", supersessionCancelState: "CONFIRMED" });
    expect(await reviews(duplicate.providerSubId)).toEqual([
      expect.objectContaining({
        reason: "DUPLICATE_BASE_SUBSCRIPTION",
        providerAction: "CANCELED_AT_PROVIDER",
        refundReviewRequired: true,
        detail: expect.objectContaining({ keptSubscriptionId: retained!.id, exception: "DUPLICATE_CHARGE_PREVENTION" }),
      }),
    ]);
    // The retained subscription and the entitlement are untouched; nothing refunded.
    expect(await row(retained!.id)).toMatchObject({ status: "ACTIVE", canceledAtUtc: null, cancelAtPeriodEnd: false });
    expect(await plan(userId)).toBe("PRO");
    expect(await prisma.payment.count({ where: { userId, status: "REFUNDED" } })).toBe(0);

    await retry(new Date(Date.now() + 2 * DAY));
    expect(callsFor(duplicate.providerSubId)).toHaveLength(1);
  });

  it("a duplicate the provider already ended is confirmed without a cancel call", async () => {
    const { duplicate } = await pair({ duplicateAtProvider: "CANCELED" });
    await retry();
    expect(callsFor(duplicate.providerSubId)).toEqual([]);
    expect(await row(duplicate.id)).toMatchObject({ status: "CANCELED", supersessionCancelState: "CONFIRMED" });
    // Recorded as what happened: no cancel was sent.
    expect((await reviews(duplicate.providerSubId))[0]).toMatchObject({
      reason: "DUPLICATE_BASE_SUBSCRIPTION",
      providerAction: "ALREADY_ENDED_AT_PROVIDER",
    });
  });

  it("a retained subscription that is only TRIALING at the provider is review, never a cancel", async () => {
    const { retained, duplicate } = await pair();
    facts.set(retained!.providerSubId, { state: "SUCCEEDED", providerStatus: "trialing" });
    await retry();
    expect(callsFor(duplicate.providerSubId)).toEqual([]);
    expect(await row(duplicate.id)).toMatchObject({ status: "ACTIVE", supersessionCancelState: "REVIEW_REQUIRED" });
    expect((await reviews(duplicate.providerSubId))[0]).toMatchObject({
      reason: "DUPLICATE_BASE_SUBSCRIPTION_UNCONFIRMED",
      detail: expect.objectContaining({ why: "RETAINED_STATUS_NOT_ACTIVE_AT_PROVIDER" }),
    });
  });

  it("no valid retained subscription: review item, no provider call", async () => {
    const cases = [
      await pair({ retainedId: randomUUID() }), // retained row missing
      await pair({ retained: { status: "CANCELED", canceledAtUtc: new Date() } }),
      await pair({ retained: { status: "PAST_DUE" } }),
      await pair({ retained: { cancelAtPeriodEnd: true } }),
      await pair({ retainedAtProvider: "CANCELED" }), // locally ACTIVE, ended at the provider
    ];
    const expected = [
      "RETAINED_MISSING",
      "RETAINED_NOT_ACTIVE",
      "RETAINED_NOT_ACTIVE",
      "RETAINED_ENDING",
      "RETAINED_NOT_ACTIVE_AT_PROVIDER",
    ];
    await retry();
    for (const [i, { duplicate, userId }] of cases.entries()) {
      expect(callsFor(duplicate.providerSubId), expected[i]).toEqual([]);
      expect(await row(duplicate.id)).toMatchObject({
        status: "ACTIVE",
        supersessionCancelState: "REVIEW_REQUIRED",
        supersessionCancelAttemptCount: 1,
      });
      expect(await reviews(duplicate.providerSubId)).toEqual([
        expect.objectContaining({
          reason: "DUPLICATE_BASE_SUBSCRIPTION_UNCONFIRMED",
          providerAction: "NONE",
          detail: expect.objectContaining({ why: expected[i] }),
        }),
      ]);
      expect(await plan(userId)).toBe("PRO");
    }
  });

  it("missing provider facts: review item, no provider call", async () => {
    const noRetainedFact = await pair({ retainedAtProvider: null });
    const unknownRetained = await pair({ retainedAtProvider: "UNKNOWN" });
    const noDuplicateFact = await pair({ duplicateAtProvider: null });
    await retry();
    for (const [c, why] of [
      [noRetainedFact, "RETAINED_PROVIDER_FACTS_MISSING"],
      [unknownRetained, "RETAINED_PROVIDER_FACTS_MISSING"],
      [noDuplicateFact, "DUPLICATE_PROVIDER_FACTS_MISSING"],
    ] as const) {
      expect(callsFor(c.duplicate.providerSubId)).toEqual([]);
      expect((await reviews(c.duplicate.providerSubId))[0]).toMatchObject({
        reason: "DUPLICATE_BASE_SUBSCRIPTION_UNCONFIRMED",
        detail: expect.objectContaining({ why }),
      });
    }
  });

  it("ambiguous ownership: a retained subscription of another account is review, never a cancel", async () => {
    const other = await user("PRO");
    const { duplicate } = await pair({ retainedOwner: other });
    await retry();
    expect(callsFor(duplicate.providerSubId)).toEqual([]);
    expect(await row(duplicate.id)).toMatchObject({ status: "ACTIVE", supersessionCancelState: "REVIEW_REQUIRED" });
    expect((await reviews(duplicate.providerSubId))[0]).toMatchObject({
      reason: "DUPLICATE_BASE_SUBSCRIPTION_UNCONFIRMED",
      providerAction: "NONE",
      detail: expect.objectContaining({ why: "RETAINED_ACCOUNT_DIFFERS" }),
    });
  });

  it("a review row is re-read later and cancelled only once it becomes conclusive", async () => {
    const { duplicate, retained } = await pair({ retainedAtProvider: "UNKNOWN" });
    await retry();
    expect(callsFor(duplicate.providerSubId)).toEqual([]);
    // Not due again before the daily re-check.
    await retry(new Date(Date.now() + 60 * 60_000));
    expect(callsFor(duplicate.providerSubId)).toEqual([]);
    facts.set(retained!.providerSubId, { state: "SUCCEEDED" });
    await retry(new Date(Date.now() + 2 * DAY));
    expect(callsFor(duplicate.providerSubId)).toHaveLength(1);
    expect(await row(duplicate.id)).toMatchObject({ status: "CANCELED", supersessionCancelState: "CONFIRMED" });
  });

  it("the plan-lowering and add-on switches are untouched: off, nothing lowered, no add-on cancelled", async () => {
    delete process.env.BILLING_AUTO_PLAN_LOWERING;
    delete process.env.BILLING_AUTO_ADDON_CANCELLATION;
    const { userId, duplicate } = await pair();
    const addon = await prisma.workspaceStorageAddon.create({
      data: {
        ownerUserId: userId,
        addonKey: "PERSONAL_10_GB",
        extraStorageBytes: 10n * 1024n * 1024n * 1024n,
        status: "ACTIVE",
        billingCycle: "MONTHLY",
        paymentProvider: "STRIPE",
        externalSubscriptionId: `sub_${randomUUID().slice(0, 14)}`,
        amountCents: 299,
        currency: "EUR",
      } as never,
    });
    await retry();
    expect(callsFor(duplicate.providerSubId)).toHaveLength(1);
    expect(effects.automaticPlanLoweringEnabled()).toBe(false);
    expect(effects.automaticAddonCancellationEnabled()).toBe(false);
    expect(await plan(userId)).toBe("PRO");
    expect(await prisma.workspaceStorageAddon.findUniqueOrThrow({ where: { id: addon.id } })).toMatchObject({
      status: "ACTIVE",
      dependentCancellationState: "NONE",
    });
    expect(
      await prisma.billingReviewItem.count({
        where: { userId, reason: { in: ["AUTOMATIC_PLAN_LOWERING_HELD", "AUTOMATIC_ADDON_CANCELLATION_HELD"] } },
      }),
    ).toBe(0);
  });

  // --- The FIRST attempt (syncPlanForSubscription, under the per-payer lock) ---

  /** A retained subscription, then a second ACTIVE base fact for the same payer. */
  async function firstAttempt(opts: { retained?: Record<string, unknown>; retainedAtProvider?: ObservedState | null } = {}) {
    const userId = await user("PRO");
    const retained = await sub(userId, { provider: "STRIPE", ...opts.retained });
    retainedRefs.add(retained.providerSubId);
    if (opts.retainedAtProvider !== null) facts.set(retained.providerSubId, { state: opts.retainedAtProvider ?? "SUCCEEDED" });
    const ref = `I-${randomUUID().slice(0, 12)}`;
    facts.set(ref, { state: "SUCCEEDED" });
    const outcome = await handlers.syncPlanForSubscription({
      userId,
      plan: "TEAM",
      provider: "PAYPAL",
      providerSubId: ref,
      status: "ACTIVE",
      observedAtUtc: new Date(),
      cancelSupersededAtProvider: cancel as never,
      readSupersededProvider: readProvider as never,
    });
    const duplicate = await prisma.subscription.findUniqueOrThrow({
      where: { provider_providerSubId: { provider: "PAYPAL", providerSubId: ref } },
    });
    return { userId, retained, duplicate, outcome };
  }

  it("first attempt, conclusive duplicate: cancelled once; the duplicate grants nothing", async () => {
    const { userId, retained, duplicate, outcome } = await firstAttempt();
    expect(outcome).toMatchObject({ outcome: "SUPERSEDED", keptSubscriptionId: retained.id, canceledAtProvider: true });
    expect(callsFor(duplicate.providerSubId)).toEqual([{ provider: "PAYPAL", ref: duplicate.providerSubId }]);
    expect(await row(duplicate.id)).toMatchObject({
      status: "CANCELED",
      supersededBySubscriptionId: retained.id,
      supersessionCancelState: "CONFIRMED",
    });
    expect(await row(retained.id)).toMatchObject({ status: "ACTIVE", canceledAtUtc: null });
    expect(await plan(userId)).toBe("PRO");
    // Nothing is left for the retry step.
    await retry(new Date(Date.now() + 2 * DAY));
    expect(callsFor(duplicate.providerSubId)).toHaveLength(1);
  });

  it("first attempt, retained subscription PAST_DUE: review, no cancel, still grants nothing", async () => {
    const { userId, retained, duplicate, outcome } = await firstAttempt({ retained: { status: "PAST_DUE" } });
    expect(outcome).toMatchObject({ outcome: "SUPERSEDED", keptSubscriptionId: retained.id, canceledAtProvider: false });
    expect(callsFor(duplicate.providerSubId)).toEqual([]);
    expect(await row(duplicate.id)).toMatchObject({
      status: "ACTIVE",
      supersededBySubscriptionId: retained.id,
      supersessionCancelState: "REVIEW_REQUIRED",
    });
    expect((await reviews(duplicate.providerSubId))[0]).toMatchObject({
      reason: "DUPLICATE_BASE_SUBSCRIPTION_UNCONFIRMED",
      providerAction: "NONE",
      detail: expect.objectContaining({ why: "RETAINED_NOT_ACTIVE", firstAttempt: true }),
    });
    expect(await plan(userId)).toBe("PRO");
  });

  it("first attempt, provider read fails: review, no cancel", async () => {
    const { userId, duplicate, outcome } = await firstAttempt({ retainedAtProvider: null });
    expect(outcome).toMatchObject({ outcome: "SUPERSEDED", canceledAtProvider: false });
    expect(callsFor(duplicate.providerSubId)).toEqual([]);
    expect(await row(duplicate.id)).toMatchObject({ status: "ACTIVE", supersessionCancelState: "REVIEW_REQUIRED" });
    expect((await reviews(duplicate.providerSubId))[0]).toMatchObject({
      reason: "DUPLICATE_BASE_SUBSCRIPTION_UNCONFIRMED",
      detail: expect.objectContaining({ why: "RETAINED_PROVIDER_FACTS_MISSING" }),
    });
    expect(await plan(userId)).toBe("PRO");
  });

  it("first attempt vs the sweep: the sweep cannot claim inside the first attempt's window, and a failed first attempt never overwrites the sweep's confirmation", async () => {
    const userId = await user("PRO");
    const retained = await sub(userId, { provider: "STRIPE" });
    retainedRefs.add(retained.providerSubId);
    facts.set(retained.providerSubId, { state: "SUCCEEDED" });
    const ref = `I-${randomUUID().slice(0, 12)}`;
    facts.set(ref, { state: "SUCCEEDED" });
    let sweptLater = -1;
    // The first attempt's provider call: while it is in flight, the sweep runs.
    const racingCancel = async (provider: string, cancelRef: string) => {
      cancelCalls.push({ provider, ref: cancelRef });
      // (a) A sweep right now must not take the row: it is stamped >= now + 5 min.
      await retry();
      // (b) A sweep past that window takes it and confirms the cancellation.
      sweptLater = (await retry(new Date(Date.now() + 10 * 60_000))).confirmed;
      // …and the first attempt's own call then fails.
      return { canceled: false, observedAtUtc: null };
    };
    const outcome = await handlers.syncPlanForSubscription({
      userId,
      plan: "TEAM",
      provider: "PAYPAL",
      providerSubId: ref,
      status: "ACTIVE",
      observedAtUtc: new Date(),
      cancelSupersededAtProvider: racingCancel as never,
      readSupersededProvider: readProvider as never,
    });
    expect(outcome).toMatchObject({ outcome: "SUPERSEDED", canceledAtProvider: false });
    const duplicate = await prisma.subscription.findUniqueOrThrow({
      where: { provider_providerSubId: { provider: "PAYPAL", providerSubId: ref } },
    });
    expect(sweptLater).toBeGreaterThanOrEqual(1);
    expect(await row(duplicate.id)).toMatchObject({ status: "CANCELED", supersessionCancelState: "CONFIRMED" });
    expect((await reviews(ref)).find((r) => r.reason === "DUPLICATE_BASE_SUBSCRIPTION")).toMatchObject({
      providerAction: "CANCELED_AT_PROVIDER",
    });
    // The duplicate was asked twice at most (first attempt + the later sweep), never by the sweep inside the window.
    expect(callsFor(ref)).toHaveLength(2);
  });

  it("the automatic-effects preview lists every candidate with the outcome the sweep would take", async () => {
    const conclusive = await pair();
    const orphan = await pair({ retainedId: randomUUID() });
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/scripts/billing-automatic-effects-preview.ts"], {
      cwd: API_ROOT,
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL! },
      encoding: "utf8",
      timeout: 300_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.action === "RETRY_SUPERSEDED_DUPLICATE_CANCEL");
    expect(lines.find((l) => l.subscriptionId === conclusive.duplicate.id)).toMatchObject({
      outcome: "CANCEL_AT_PROVIDER",
      retainedSubscriptionId: conclusive.retained!.id,
      providerConfirmationRequired: true,
      exception: "DUPLICATE_CHARGE_PREVENTION",
      entitlementLowered: false,
      refunded: false,
    });
    expect(lines.find((l) => l.subscriptionId === orphan.duplicate.id)).toMatchObject({
      outcome: "REVIEW_NO_PROVIDER_CALL",
      reviewReason: "RETAINED_MISSING",
    });
    // The preview is read-only: nothing it listed was asked of a provider or changed.
    expect(callsFor(conclusive.duplicate.providerSubId)).toEqual([]);
    expect(await row(conclusive.duplicate.id)).toMatchObject({ status: "ACTIVE", supersessionCancelState: "RETRY_SCHEDULED" });
  }, 400_000);
});
