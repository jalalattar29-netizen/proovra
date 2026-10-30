/**
 * BILLING REMEDIATION (2026-10-30) — provider fact to database, through the real
 * routes and handlers, on live PostgreSQL. Real HTTP injection, real webhook
 * signatures; the only substitutions are the Stripe and PayPal reads at their
 * module boundary, so nothing external is contacted and every constraint, lock
 * and transaction below is the real one.
 *
 * Proven here: finding IDs are named per case.
 */
import { createHmac, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const S = vi.hoisted(() => ({
  subscriptions: new Map<string, Record<string, unknown>>(),
  sessionsByIntent: new Map<string, string>(),
  invoicesByIntent: new Map<string, string>(),
  stripeCalls: [] as string[],
  paypalCalls: [] as string[],
  failSubscriptionRead: false,
}));

vi.mock("../src/services/stripe.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    stripeGet: async (path: string) => {
      S.stripeCalls.push(`GET ${path}`);
      const sub = path.match(/^\/subscriptions\/([^?]+)/);
      if (sub) {
        if (S.failSubscriptionRead) throw new Error("stripe unavailable");
        const found = S.subscriptions.get(decodeURIComponent(sub[1]!));
        if (!found) throw new Error(`unexpected subscription read: ${path}`);
        return found;
      }
      const session = path.match(/^\/checkout\/sessions\?payment_intent=([^&]+)/);
      if (session) {
        const id = S.sessionsByIntent.get(decodeURIComponent(session[1]!));
        return { data: id ? [{ id }] : [] };
      }
      const invoice = path.match(/payment\[payment_intent\]=([^&]+)/);
      if (invoice) {
        const id = S.invoicesByIntent.get(decodeURIComponent(invoice[1]!));
        return { data: id ? [{ invoice: id }] : [] };
      }
      throw new Error(`unexpected Stripe read in test: ${path}`);
    },
  };
});

vi.mock("../src/services/paypal.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getPayPalSubscription: async (id: string) => {
      S.paypalCalls.push(`GET ${id}`);
      throw new Error("no PayPal subscription is expected in this test");
    },
  };
});

describe("billing remediation convergence (live PostgreSQL, real HTTP)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let webhookSecret: string;
  const secretBefore = process.env.STRIPE_WEBHOOK_SECRET;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    webhookSecret = `whsec_local_${randomUUID().replace(/-/g, "")}`;
    process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
    process.env.STRIPE_PRO_PRICE_ID_EUR = "price_pro_eur";
    process.env.STRIPE_TEAM_PRICE_ID_EUR = "price_team_eur";
  }, 180_000);

  afterAll(async () => {
    if (secretBefore === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = secretBefore;
    delete process.env.STRIPE_PRO_PRICE_ID_EUR;
    delete process.env.STRIPE_TEAM_PRICE_ID_EUR;
    await h?.cleanup();
  });

  beforeEach(() => {
    S.stripeCalls.length = 0;
    S.paypalCalls.length = 0;
    S.failSubscriptionRead = false;
  });

  const deliver = (event: Record<string, unknown>) => {
    const raw = JSON.stringify({ id: `evt_${randomUUID().replace(/-/g, "")}`, ...event });
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", webhookSecret).update(`${t}.${raw}`).digest("hex");
    return h.app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${v1}` },
      payload: raw,
    });
  };

  async function freshUser() {
    const { ensureEntitlement, setPersonalPlan } = await import("../src/services/billing.service.js");
    const id = randomUUID();
    const email = `billing-rem-${id}@example.test`;
    await prisma.user.create({ data: { id, email, provider: "EMAIL", providerUserId: email } });
    await ensureEntitlement(id);
    await setPersonalPlan(id, "FREE");
    return id;
  }
  const entitlementPlan = async (userId: string) =>
    (await prisma.entitlement.findFirstOrThrow({
      where: { userId, active: true },
      orderBy: { createdAt: "desc" },
      select: { plan: true },
    })).plan;
  const subRow = (providerSubId: string) =>
    prisma.subscription.findUniqueOrThrow({
      where: { provider_providerSubId: { provider: "STRIPE", providerSubId } },
    });

  const stripeSub = (input: {
    id: string;
    userId: string;
    status: string;
    price?: string;
    plan?: string;
    periodEnd?: number;
    extra?: Record<string, unknown>;
  }) => ({
    id: input.id,
    status: input.status,
    currency: "eur",
    metadata: { userId: input.userId, ...(input.plan ? { plan: input.plan } : {}) },
    items: {
      data: [
        {
          id: "si_1",
          current_period_end: input.periodEnd ?? Math.floor(Date.now() / 1000) + 30 * 86400,
          price: { id: input.price ?? "price_pro_eur", unit_amount: 799 },
        },
      ],
    },
    ...input.extra,
  });
  const subEvent = (type: string, created: number, object: Record<string, unknown>) => ({
    type,
    created,
    data: { object },
  });

  // --- AUD-02 ---------------------------------------------------------------

  it("AUD-02: incomplete then active in the same second ends ACTIVE, with the plan granted", async () => {
    const userId = await freshUser();
    const id = `sub_${randomUUID().slice(0, 12)}`;
    const t = Math.floor(Date.now() / 1000) - 10;
    expect((await deliver(subEvent("customer.subscription.created", t, stripeSub({ id, userId, status: "incomplete", plan: "PRO" })))).statusCode).toBe(200);
    expect((await subRow(id)).status).toBe("TRIALING");
    expect(await entitlementPlan(userId)).toBe("FREE");

    expect((await deliver(subEvent("customer.subscription.updated", t, stripeSub({ id, userId, status: "active", plan: "PRO" })))).statusCode).toBe(200);
    expect((await subRow(id)).status).toBe("ACTIVE");
    expect(await entitlementPlan(userId)).toBe("PRO");
  });

  it("AUD-02: active delivered first keeps ACTIVE when a same-second incomplete follows, after asking Stripe", async () => {
    const userId = await freshUser();
    const id = `sub_${randomUUID().slice(0, 12)}`;
    const t = Math.floor(Date.now() / 1000) - 10;
    S.subscriptions.set(id, stripeSub({ id, userId, status: "active", plan: "PRO" }));
    await deliver(subEvent("customer.subscription.updated", t, stripeSub({ id, userId, status: "active", plan: "PRO" })));
    S.stripeCalls.length = 0;
    const res = await deliver(subEvent("customer.subscription.created", t, stripeSub({ id, userId, status: "incomplete", plan: "PRO" })));
    expect(res.statusCode).toBe(200);
    expect(S.stripeCalls).toContain(`GET /subscriptions/${id}`);
    expect((await subRow(id)).status).toBe("ACTIVE");
    expect(await entitlementPlan(userId)).toBe("PRO");
  });

  it("AUD-02: a stale canceled event cannot end a live plan, and a true cancellation still lands", async () => {
    const userId = await freshUser();
    const id = `sub_${randomUUID().slice(0, 12)}`;
    const t = Math.floor(Date.now() / 1000) - 100;
    S.subscriptions.set(id, stripeSub({ id, userId, status: "active", plan: "PRO" }));
    await deliver(subEvent("customer.subscription.updated", t, stripeSub({ id, userId, status: "active", plan: "PRO" })));
    await deliver(subEvent("customer.subscription.deleted", t - 50, stripeSub({ id, userId, status: "canceled", plan: "PRO" })));
    expect((await subRow(id)).status).toBe("ACTIVE");

    S.subscriptions.set(id, stripeSub({ id, userId, status: "canceled", plan: "PRO" }));
    await deliver(subEvent("customer.subscription.deleted", t - 50, stripeSub({ id, userId, status: "canceled", plan: "PRO" })));
    expect((await subRow(id)).status).toBe("CANCELED");
    expect(await entitlementPlan(userId)).toBe("FREE");
  });

  it("AUD-02: an ambiguous event whose live read fails is retried, never guessed", async () => {
    const userId = await freshUser();
    const id = `sub_${randomUUID().slice(0, 12)}`;
    const t = Math.floor(Date.now() / 1000) - 10;
    await deliver(subEvent("customer.subscription.updated", t, stripeSub({ id, userId, status: "active", plan: "PRO" })));
    S.failSubscriptionRead = true;
    const res = await deliver(subEvent("customer.subscription.deleted", t, stripeSub({ id, userId, status: "canceled", plan: "PRO" })));
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect((await subRow(id)).status).toBe("ACTIVE");
    const failed = await prisma.stripeWebhookEvent.findFirst({
      where: { processingStatus: "FAILED", eventType: "customer.subscription.deleted" },
      orderBy: { receivedAt: "desc" },
    });
    expect(failed?.errorReason).toBeTruthy();
  });

  it("AUD-02: a paid session applies the plan from the live subscription even with no subscription event", async () => {
    const userId = await freshUser();
    const id = `sub_${randomUUID().slice(0, 12)}`;
    S.subscriptions.set(id, stripeSub({ id, userId, status: "active", plan: "TEAM", price: "price_team_eur" }));
    const res = await deliver({
      type: "checkout.session.completed",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `cs_${randomUUID().slice(0, 12)}`,
          mode: "subscription",
          status: "complete",
          payment_status: "paid",
          subscription: id,
          amount_total: 1999,
          currency: "eur",
          metadata: { userId, plan: "TEAM" },
        },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await subRow(id)).status).toBe("ACTIVE");
    expect(await entitlementPlan(userId)).toBe("TEAM");
  });

  // --- AUD-01, AUD-14a, AUD-09 ------------------------------------------------

  it("AUD-01: a landed schedule moves plan and entitlement by the billed price, whatever metadata says", async () => {
    const userId = await freshUser();
    const id = `sub_${randomUUID().slice(0, 12)}`;
    const t = Math.floor(Date.now() / 1000) - 100;
    await deliver(subEvent("customer.subscription.updated", t, stripeSub({ id, userId, status: "active", plan: "TEAM", price: "price_team_eur", extra: { schedule: "sub_sched_1" } })));
    await prisma.subscription.updateMany({
      where: { providerSubId: id },
      data: { pendingPlan: "PRO", pendingPlanEffectiveAtUtc: new Date(), providerScheduleId: "sub_sched_1" },
    });
    expect(await entitlementPlan(userId)).toBe("TEAM");

    await deliver(subEvent("customer.subscription.updated", t + 50, stripeSub({ id, userId, status: "active", plan: "TEAM", price: "price_pro_eur", extra: { schedule: null } })));
    const row = await subRow(id);
    expect(row.plan).toBe("PRO");
    expect(row.pendingPlan).toBeNull();
    expect(row.providerScheduleId).toBeNull();
    expect(await entitlementPlan(userId)).toBe("PRO");
  });

  it("AUD-14a: a payload with no period field keeps the recorded date", async () => {
    const userId = await freshUser();
    const id = `sub_${randomUUID().slice(0, 12)}`;
    const t = Math.floor(Date.now() / 1000) - 100;
    await deliver(subEvent("customer.subscription.updated", t, stripeSub({ id, userId, status: "active", plan: "PRO" })));
    const known = (await subRow(id)).currentPeriodEnd;
    expect(known).not.toBeNull();
    const bare = stripeSub({ id, userId, status: "active", plan: "PRO" });
    delete (bare.items.data[0] as Record<string, unknown>).current_period_end;
    await deliver(subEvent("customer.subscription.updated", t + 10, bare));
    expect((await subRow(id)).currentPeriodEnd?.getTime()).toBe(known?.getTime());
  });

  it("AUD-09: cancel_at_period_end set at Stripe is projected, and clearing it clears the projection", async () => {
    const userId = await freshUser();
    const id = `sub_${randomUUID().slice(0, 12)}`;
    const t = Math.floor(Date.now() / 1000) - 100;
    await deliver(subEvent("customer.subscription.updated", t, stripeSub({ id, userId, status: "active", plan: "PRO" })));
    await deliver(subEvent("customer.subscription.updated", t + 10, stripeSub({ id, userId, status: "active", plan: "PRO", extra: { cancel_at_period_end: true } })));
    expect((await subRow(id)).cancelAtPeriodEnd).toBe(true);
    await deliver(subEvent("customer.subscription.updated", t + 20, stripeSub({ id, userId, status: "active", plan: "PRO", extra: { cancel_at_period_end: false } })));
    const row = await subRow(id);
    expect(row.cancelAtPeriodEnd).toBe(false);
    expect(row.canceledAtUtc).toBeNull();
  });

  // --- AUD-12 ----------------------------------------------------------------

  it("AUD-12: two concurrent activations leave one plan; the duplicate never takes over and its cancel is retried", async () => {
    const { syncPlanForSubscription, retrySupersededCancellations } = await import(
      "../src/services/billing/subscription-lifecycle.handlers.js"
    );
    const userId = await freshUser();
    const a = `sub_${randomUUID().slice(0, 12)}`;
    const b = `sub_${randomUUID().slice(0, 12)}`;
    const failing = async () => ({ canceled: false, observedAtUtc: null });
    const outcomes = await Promise.all([
      syncPlanForSubscription({ userId, plan: "PRO", provider: "STRIPE", providerSubId: a, status: "ACTIVE", cancelSupersededAtProvider: failing }),
      syncPlanForSubscription({ userId, plan: "TEAM", provider: "STRIPE", providerSubId: b, status: "ACTIVE", cancelSupersededAtProvider: failing }),
    ]);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(["APPLIED", "SUPERSEDED"]);
    const loser = outcomes[0]!.outcome === "SUPERSEDED" ? a : b;
    const winner = loser === a ? b : a;
    const winnerPlan = (await subRow(winner)).plan;
    expect(await entitlementPlan(userId)).toBe(winnerPlan);
    expect((await subRow(loser)).supersessionCancelState).toBe("RETRY_SCHEDULED");

    // A later ACTIVE fact for the duplicate must not take the plan.
    await syncPlanForSubscription({ userId, plan: (await subRow(loser)).plan, provider: "STRIPE", providerSubId: loser, status: "ACTIVE", cancelSupersededAtProvider: failing });
    expect(await entitlementPlan(userId)).toBe(winnerPlan);

    const retried = await retrySupersededCancellations({
      now: new Date(Date.now() + 60 * 60 * 1000),
      cancel: async () => ({ canceled: true, observedAtUtc: new Date() }),
    });
    expect(retried.confirmed).toBeGreaterThanOrEqual(1);
    const closed = await subRow(loser);
    expect(closed.supersessionCancelState).toBe("CONFIRMED");
    expect(closed.status).toBe("CANCELED");
    expect(await entitlementPlan(userId)).toBe(winnerPlan);
  });

  // --- AUD-06, AUD-07, AUD-05 -------------------------------------------------

  const invoiceEvent = (type: string, input: { id: string; userId: string; status: string; subId: string; extra?: Record<string, unknown> }) => ({
    type,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: input.id,
        status: input.status,
        amount_paid: input.status === "paid" ? 3499 : 0,
        amount_due: 3499,
        currency: "eur",
        parent: {
          subscription_details: {
            subscription: input.subId,
            metadata: { userId: input.userId, storageAddonKey: "PERSONAL_10_GB", billingCycle: "MONTHLY" },
          },
        },
        ...input.extra,
      },
    },
  });

  it("AUD-06 + AUD-07: a failed invoice later paid reads SUCCEEDED, and one storage charge is one payment", async () => {
    const userId = await freshUser();
    const subId = `sub_${randomUUID().slice(0, 12)}`;
    const invoice = `in_${randomUUID().slice(0, 12)}`;
    await deliver({
      type: "checkout.session.completed",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `cs_${randomUUID().slice(0, 12)}`,
          mode: "subscription",
          status: "complete",
          payment_status: "paid",
          subscription: subId,
          amount_total: 3499,
          currency: "eur",
          metadata: { userId, storageAddonKey: "PERSONAL_10_GB", billingCycle: "MONTHLY" },
        },
      },
    });
    await deliver(invoiceEvent("invoice.payment_failed", { id: invoice, userId, status: "open", subId }));
    expect((await prisma.payment.findFirstOrThrow({ where: { userId } })).status).toBe("FAILED");
    await deliver(invoiceEvent("invoice.paid", { id: invoice, userId, status: "paid", subId }));
    const rows = await prisma.payment.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "SUCCEEDED", product: "STORAGE_ADDON", providerPaymentId: invoice });
  });

  async function paidInvoice(product: "PLAN" | "STORAGE_ADDON") {
    const { recordPayment } = await import("../src/services/billing.service.js");
    const userId = await freshUser();
    const invoice = `in_${randomUUID().slice(0, 12)}`;
    const intent = `pi_${randomUUID().slice(0, 12)}`;
    S.invoicesByIntent.set(intent, invoice);
    await recordPayment({
      userId,
      provider: "STRIPE",
      providerPaymentId: invoice,
      amountCents: 3499,
      currency: "EUR",
      status: "SUCCEEDED",
      teamId: null,
      product,
      providerResourceId: `sub_none_${randomUUID().slice(0, 6)}`.replace("sub_", "x_"),
    });
    return { userId, invoice, intent };
  }
  const refundEvent = (intent: string, charge: string, cumulative: number) => ({
    type: "charge.refunded",
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: charge, payment_intent: intent, amount: 3499, amount_refunded: cumulative, currency: "eur" } },
  });
  const payment = (invoice: string) =>
    prisma.payment.findUniqueOrThrow({
      where: { provider_providerPaymentId: { provider: "STRIPE", providerPaymentId: invoice } },
    });

  it("AUD-05: partial refunds of an invoice add up, redelivery is a no-op, and the whole amount reads REFUNDED", async () => {
    const p = await paidInvoice("STORAGE_ADDON");
    const charge = `ch_${randomUUID().slice(0, 10)}`;
    await deliver(refundEvent(p.intent, charge, 1000));
    await deliver(refundEvent(p.intent, charge, 1000));
    let row = await payment(p.invoice);
    expect(row).toMatchObject({ status: "SUCCEEDED", refundedAmountCents: 1000, amountCents: 3499 });
    expect(await prisma.paymentAdjustment.count({ where: { paymentId: row.id } })).toBe(1);
    expect(
      await prisma.billingReviewItem.count({ where: { providerResourceId: p.invoice, reason: "PARTIAL_REFUND" } }),
    ).toBe(1);

    await deliver(refundEvent(p.intent, charge, 3499));
    row = await payment(p.invoice);
    expect(row).toMatchObject({ status: "REFUNDED", refundedAmountCents: 3499, amountCents: 3499 });
    expect(await prisma.paymentAdjustment.count({ where: { paymentId: row.id } })).toBe(2);
    expect(
      await prisma.billingReviewItem.count({ where: { providerResourceId: p.invoice, reason: "SUBSCRIPTION_PAYMENT_REVERSED" } }),
    ).toBe(1);
  });

  it("AUD-29: concurrent deliveries of one refund total cannot add twice", async () => {
    const p = await paidInvoice("PLAN");
    const charge = `ch_${randomUUID().slice(0, 10)}`;
    const results = await Promise.all([1, 2, 3].map(() => deliver(refundEvent(p.intent, charge, 500))));
    expect(results.every((r) => r.statusCode < 500), results.map((r) => r.statusCode).join()).toBe(true);
    const row = await payment(p.invoice);
    expect(row.refundedAmountCents).toBe(500);
    expect(await prisma.paymentAdjustment.count({ where: { paymentId: row.id } })).toBe(1);
  });

  it("AUD-05: a lost dispute records a reversal; an open one changes no money", async () => {
    const p = await paidInvoice("PLAN");
    const dispute = `dp_${randomUUID().slice(0, 10)}`;
    const event = (type: string, status: string) => ({
      type,
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: dispute, status, amount: 3499, currency: "eur", payment_intent: p.intent } },
    });
    await deliver(event("charge.dispute.created", "needs_response"));
    expect(await payment(p.invoice)).toMatchObject({ status: "SUCCEEDED", disputeStatus: "OPEN", refundedAmountCents: 0 });
    await deliver(event("charge.dispute.closed", "lost"));
    expect(await payment(p.invoice)).toMatchObject({ status: "REFUNDED", disputeStatus: "LOST", refundedAmountCents: 3499 });
  });

  it("AUD-29: an unattributable refund is not read as an ordinary processed event", async () => {
    const res = await deliver(refundEvent(`pi_${randomUUID().slice(0, 12)}`, `ch_${randomUUID().slice(0, 10)}`, 100));
    expect(res.statusCode).toBe(200);
    const row = await prisma.stripeWebhookEvent.findFirst({
      where: { eventType: "charge.refunded", errorReason: "UNATTRIBUTED" },
    });
    expect(row?.processingStatus).toBe("PROCESSED");
  });

  // --- credits ----------------------------------------------------------------

  it("AUD-29: a reversal racing a consumption never leaves the wallet negative, and a shortfall review commits with it", async () => {
    const { grantEvidenceCredits, reverseEvidenceCreditPurchase, consumeEvidenceCreditForCompletion } = await import(
      "../src/services/billing/evidence-credits.service.js"
    );
    for (let i = 0; i < 6; i++) {
      const userId = await freshUser();
      const ref = `cs_${randomUUID().slice(0, 12)}`;
      await grantEvidenceCredits({ userId, credits: 1, provider: "STRIPE", providerRef: ref });
      const evidence = await prisma.evidence.findFirstOrThrow({ select: { id: true } }).catch(() => null);
      await Promise.allSettled([
        reverseEvidenceCreditPurchase({ userId, provider: "STRIPE", providerRef: ref, shortfallReviewDetail: { kind: "REFUNDED" } }),
        prisma.$transaction((tx) =>
          consumeEvidenceCreditForCompletion({ userId, evidenceId: evidence?.id ?? randomUUID() }, tx),
        ),
      ]);
      const wallet = await prisma.entitlement.findFirstOrThrow({ where: { userId, active: true } });
      expect(wallet.credits).toBeGreaterThanOrEqual(0);
      const reversal = await prisma.evidenceCreditLedgerEntry.findFirstOrThrow({
        where: { entryType: "REVERSAL", providerRef: ref },
      });
      const reviews = await prisma.billingReviewItem.count({
        where: { providerResourceId: ref, reason: "CREDIT_REFUND_AFTER_CONSUMPTION" },
      });
      expect(reviews).toBe(reversal.creditsDelta === 0 ? 1 : 0);
      await prisma.evidenceCreditLedgerEntry.deleteMany({ where: { userId, entryType: "CONSUMPTION" } });
    }
  });

  // --- AUD-03, AUD-14 ---------------------------------------------------------

  const observation = (over: Record<string, unknown>) => ({
    kind: "SUBSCRIPTION",
    provider: "STRIPE",
    state: "SUCCEEDED",
    currentPeriodEndUtc: null,
    cancelAtPeriodEnd: false,
    observedAtUtc: new Date(),
    recentPayments: [],
    ...over,
  });
  const account = (id: string) =>
    ({ type: "PERSONAL", id, displayName: "", capabilities: [], billingOwnerMissing: false }) as never;

  it("AUD-03: an ACTIVE row with a stale entitlement is repaired when provider and row agree", async () => {
    const { reconcileBillingAccount } = await import("../src/services/billing/reconciliation/reconciliation.service.js");
    const userId = await freshUser();
    const id = `sub_${randomUUID().slice(0, 12)}`;
    const periodEnd = new Date(Date.now() + 86400000 * 20);
    await prisma.subscription.create({
      data: { userId, provider: "STRIPE", providerSubId: id, status: "ACTIVE", plan: "PRO", currentPeriodEnd: periodEnd, activatedAtUtc: new Date() },
    });
    expect(await entitlementPlan(userId)).toBe("FREE");
    const summary = await reconcileBillingAccount({
      account: account(userId),
      providers: {
        STRIPE: {
          provider: "STRIPE",
          observePayment: async () => { throw new Error("not used"); },
          observeSubscription: async (ref: string) => observation({ providerRef: ref, currentPeriodEndUtc: periodEnd }),
        },
      } as never,
    });
    expect(await entitlementPlan(userId)).toBe("PRO");
    expect(summary.subscriptionsUpdated).toBeGreaterThanOrEqual(1);
  });

  it("AUD-14: a 404 revokes nothing, backs off, escalates once, and a later read resolves it", async () => {
    const { reconcileBillingAccount } = await import("../src/services/billing/reconciliation/reconciliation.service.js");
    const { setPersonalPlan } = await import("../src/services/billing.service.js");
    const userId = await freshUser();
    await setPersonalPlan(userId, "PRO");
    const id = `sub_${randomUUID().slice(0, 12)}`;
    await prisma.subscription.create({
      data: { userId, provider: "STRIPE", providerSubId: id, status: "ACTIVE", plan: "PRO", activatedAtUtc: new Date() },
    });
    let reads = 0;
    let found = false;
    const providers = {
      STRIPE: {
        provider: "STRIPE",
        observePayment: async () => { throw new Error("not used"); },
        observeSubscription: async (ref: string) => {
          reads += 1;
          return found
            ? observation({ providerRef: ref })
            : observation({ providerRef: ref, state: "UNKNOWN", failure: "NOT_FOUND", observedAtUtc: null });
        },
      },
    } as never;

    await reconcileBillingAccount({ account: account(userId), providers });
    await reconcileBillingAccount({ account: account(userId), providers });
    expect(reads).toBe(1);
    const check = await prisma.billingProviderBindingCheck.findFirstOrThrow({ where: { providerResourceId: id } });
    expect(check).toMatchObject({ state: "UNRESOLVED", consecutiveMisses: 1 });
    expect(check.nextCheckAtUtc.getTime()).toBeGreaterThan(Date.now());

    for (let i = 0; i < 2; i++) {
      await prisma.billingProviderBindingCheck.update({ where: { id: check.id }, data: { nextCheckAtUtc: new Date(0) } });
      await reconcileBillingAccount({ account: account(userId), providers });
    }
    expect(await prisma.billingReviewItem.count({ where: { providerResourceId: id, reason: "PROVIDER_REFERENCE_UNRESOLVED" } })).toBe(1);
    expect((await subRow(id)).status).toBe("ACTIVE");
    expect(await entitlementPlan(userId)).toBe("PRO");

    found = true;
    await prisma.billingProviderBindingCheck.update({ where: { id: check.id }, data: { nextCheckAtUtc: new Date(0) } });
    await reconcileBillingAccount({ account: account(userId), providers });
    expect((await prisma.billingProviderBindingCheck.findUniqueOrThrow({ where: { id: check.id } })).state).toBe("RESOLVED");
  });

  // --- AUD-11, AUD-20, section 10 ---------------------------------------------

  it("AUD-11: abandoning an approved PayPal credit order captures nothing", async () => {
    const { abandonCheckoutAttempt } = await import("../src/services/billing/checkout-attempt-recovery.service.js");
    const userId = await freshUser();
    const orderId = `ORD${randomUUID().slice(0, 12).replace(/-/g, "")}`;
    const attempt = await prisma.billingCheckoutAttempt.create({
      data: {
        userId,
        product: "EVIDENCE_CREDIT",
        provider: "PAYPAL",
        amountCents: 500,
        currency: "EUR",
        checkoutState: "AWAITING_CUSTOMER_APPROVAL",
        providerResourceId: orderId,
      },
    });
    const captures: boolean[] = [];
    const result = await abandonCheckoutAttempt({
      account: account(userId),
      attemptId: attempt.id,
      deps: {
        providers: {
          PAYPAL: {
            provider: "PAYPAL",
            observePayment: async (ref: string) => ({
              kind: "PAYMENT",
              provider: "PAYPAL",
              providerRef: ref,
              state: "PENDING",
              providerStatus: "APPROVED",
              amountCents: 500,
              currency: "EUR",
              quantity: null,
              observedAtUtc: new Date(),
            }),
            observeSubscription: async () => { throw new Error("not used"); },
          },
        } as never,
        settleOrder: (async (input: { capture: boolean; orderId: string }) => {
          captures.push(input.capture);
          return { outcome: "PENDING", orderId: input.orderId, reason: "AWAITING_CAPTURE", captureId: null };
        }) as never,
      },
    });
    expect(captures).toEqual([false]);
    expect(result.outcome).toBe("ABANDON_NOT_ALLOWED");
  });

  it("AUD-20 + expiry: a local abandon does not stop a later provider-proven activation, and the sweep still offers it", async () => {
    const { applyStorageSubscriptionObservation } = await import("../src/services/billing/storage-activation.service.js");
    const { selectReconciliationCandidates } = await import("../src/jobs/billing-reconciliation.job.js");
    const userId = await freshUser();
    const ref = `I-${randomUUID().slice(0, 12).toUpperCase()}`;
    process.env.PAYPAL_PLAN_STORAGE_PERSONAL_10_GB_EUR = "P-REM";
    const row = await prisma.workspaceStorageAddon.create({
      data: {
        ownerUserId: userId,
        addonKey: "PERSONAL_10_GB",
        extraStorageBytes: 1n,
        billingCycle: "MONTHLY",
        status: "ABANDONED",
        paymentProvider: "PAYPAL",
        externalSubscriptionId: ref,
        currency: "EUR",
        amountCents: 299,
        metadata: { checkoutState: "LOCALLY_EXPIRED", providerPlanId: "P-REM" },
      },
    });
    const candidates = await selectReconciliationCandidates(500);
    expect(candidates.map((c) => c.id)).toContain(userId);

    const applied = await applyStorageSubscriptionObservation({
      provider: "PAYPAL",
      subscriptionId: ref,
      status: "ACTIVE",
      planId: "P-REM",
      claimed: { userId, teamId: null, addonKey: "PERSONAL_10_GB" },
      currentPeriodEnd: null,
      observedAtUtc: new Date(),
      source: "test",
    });
    expect(applied.outcome).toBe("GRANTED");
    expect((await prisma.workspaceStorageAddon.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("ACTIVE");
    delete process.env.PAYPAL_PLAN_STORAGE_PERSONAL_10_GB_EUR;
  });

  it("AUD-23: confirm refuses a reference this account never stored, before PayPal is asked", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/billing/checkout/paypal/subscriptions/I-NUGDB33DP12H/confirm",
      headers: { authorization: `Bearer ${h.fixtures.personal.token}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(404);
    expect(JSON.parse(res.body).code).toBe("PAYPAL_SUBSCRIPTION_NOT_FOUND");
    expect(S.paypalCalls).toEqual([]);
  });

  it("section 10: a held SKU answers with what was found; an intentional addition is a different request", async () => {
    const { findStorageDuplicate } = await import("../src/services/billing/storage-purchase-guard.service.js");
    const userId = await freshUser();
    await prisma.workspaceStorageAddon.create({
      data: {
        ownerUserId: userId,
        addonKey: "PERSONAL_10_GB",
        extraStorageBytes: 1n,
        billingCycle: "MONTHLY",
        status: "ACTIVE",
        paymentProvider: "STRIPE",
        externalSubscriptionId: `sub_${randomUUID().slice(0, 12)}`,
      },
    });
    const held = await findStorageDuplicate({ userId, addonKey: "PERSONAL_10_GB", provider: "PAYPAL" });
    expect(held?.code).toBe("STORAGE_ADDON_ALREADY_HELD");
    expect(held?.details).toMatchObject({ activeCount: 1, retry: "CONFIRM_ADDITIONAL" });
    expect(await findStorageDuplicate({ userId, addonKey: "PERSONAL_50_GB", provider: "PAYPAL" })).toBeNull();

    await prisma.workspaceStorageAddon.create({
      data: {
        ownerUserId: userId,
        addonKey: "PERSONAL_50_GB",
        extraStorageBytes: 1n,
        billingCycle: "MONTHLY",
        status: "PENDING",
        paymentProvider: "PAYPAL",
        externalSubscriptionId: `I-${randomUUID().slice(0, 12).toUpperCase()}`,
      },
    });
    const pending = await findStorageDuplicate({ userId, addonKey: "PERSONAL_50_GB", provider: "STRIPE" });
    expect(pending?.code).toBe("STORAGE_PURCHASE_PENDING");
    expect(pending?.details).toMatchObject({ pendingProvider: "PAYPAL", retry: "RECONCILE_STORAGE_ATTEMPT" });
  });

  // --- AUD-04, AUD-09 ---------------------------------------------------------

  it("AUD-04: cancelling a legacy workspace-scoped base obliges the payer's personal TEAM add-on", async () => {
    const { recordDependentCancellationIntent } = await import("../src/services/billing/storage-addon-dependency.service.js");
    const userId = await freshUser();
    const team = await prisma.team.findFirstOrThrow({ select: { id: true } });
    const base = await prisma.subscription.create({
      data: {
        userId,
        teamId: team.id,
        provider: "STRIPE",
        providerSubId: `sub_${randomUUID().slice(0, 12)}`,
        status: "ACTIVE",
        plan: "TEAM",
        activatedAtUtc: new Date(),
      },
    });
    const addon = await prisma.workspaceStorageAddon.create({
      data: {
        ownerUserId: userId,
        addonKey: "TEAM_100_GB",
        extraStorageBytes: 1n,
        billingCycle: "MONTHLY",
        status: "ACTIVE",
        paymentProvider: "STRIPE",
        externalSubscriptionId: `sub_${randomUUID().slice(0, 12)}`,
        dependsOnSubscriptionId: base.id,
      },
    });
    await prisma.$transaction((tx) =>
      recordDependentCancellationIntent({ ownerUserId: userId, teamId: team.id, triggeredBySubscriptionId: base.id }, tx),
    );
    expect((await prisma.workspaceStorageAddon.findUniqueOrThrow({ where: { id: addon.id } })).dependentCancellationState).toBe("PENDING");
  });

  it("AUD-09: a provider-cancelled add-on keeps its paid month, then closes", async () => {
    const { applyStorageSubscriptionObservation } = await import("../src/services/billing/storage-activation.service.js");
    const { finalizeEndedStorageAddons } = await import("../src/services/billing/paid-period.service.js");
    const userId = await freshUser();
    const ref = `I-${randomUUID().slice(0, 12).toUpperCase()}`;
    const paidThrough = new Date(Date.now() + 10 * 86400000);
    const row = await prisma.workspaceStorageAddon.create({
      data: {
        ownerUserId: userId,
        addonKey: "PERSONAL_10_GB",
        extraStorageBytes: 1n,
        billingCycle: "MONTHLY",
        status: "ACTIVE",
        paymentProvider: "PAYPAL",
        externalSubscriptionId: ref,
        activatedAtUtc: new Date(),
        currentPeriodEnd: paidThrough,
      },
    });
    await applyStorageSubscriptionObservation({
      provider: "PAYPAL",
      subscriptionId: ref,
      status: "CANCELED",
      planId: null,
      claimed: null,
      currentPeriodEnd: null,
      observedAtUtc: new Date(),
      source: "test",
    });
    let current = await prisma.workspaceStorageAddon.findUniqueOrThrow({ where: { id: row.id } });
    expect(current.status).toBe("ACTIVE");
    expect(current.expiresAtUtc?.getTime()).toBe(paidThrough.getTime());

    expect(await finalizeEndedStorageAddons(new Date(paidThrough.getTime() - 1000))).toBe(0);
    await finalizeEndedStorageAddons(new Date(paidThrough.getTime() + 1000));
    current = await prisma.workspaceStorageAddon.findUniqueOrThrow({ where: { id: row.id } });
    expect(current.status).toBe("CANCELED");
  });
});
