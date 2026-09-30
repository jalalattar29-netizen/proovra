/**
 * ET-COM-03 — a refunded or charged-back Stripe credit purchase takes its
 * credits back. Live PostgreSQL 16, real HTTP, real webhook signatures; the
 * one Stripe API read (payment intent -> Checkout Session) is answered at the
 * stripe.service module boundary. Nothing external is contacted.
 *
 * On a40ca76f the Stripe webhook handled checkout sessions, subscriptions and
 * invoices only: no charge.refunded / charge.dispute.* handling, and no Stripe
 * caller of reverseEvidenceCreditPurchase — a refunded purchase kept its
 * credits (PayPal's refunds already reversed).
 */
import { createHmac, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const sessionsByIntent = vi.hoisted(() => new Map<string, string>());

vi.mock("../src/services/stripe.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    stripeGet: async (path: string) => {
      const m = path.match(/^\/checkout\/sessions\?payment_intent=([^&]+)/);
      if (m) {
        const id = sessionsByIntent.get(decodeURIComponent(m[1]!));
        return { data: id ? [{ id }] : [] };
      }
      throw new Error(`unexpected Stripe read in test: ${path}`);
    },
  };
});

describe("Stripe credit refunds and lost disputes (live PostgreSQL 16, real HTTP)", () => {
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
  }, 180_000);

  afterAll(async () => {
    if (secretBefore === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = secretBefore;
    await h?.cleanup();
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

  /** A settled Stripe credit purchase of `credits`, as settlement records it. */
  async function purchased(credits: number) {
    const userId = h.fixtures.personal.userId;
    const sessionId = `cs_test_${randomUUID().replace(/-/g, "")}`;
    const paymentIntent = `pi_${randomUUID().replace(/-/g, "")}`;
    sessionsByIntent.set(paymentIntent, sessionId);
    const { ensureEntitlement, recordPayment } = await import("../src/services/billing.service.js");
    const { grantEvidenceCredits } = await import("../src/services/billing/evidence-credits.service.js");
    await ensureEntitlement(userId);
    await recordPayment({
      userId,
      provider: "STRIPE",
      providerPaymentId: sessionId,
      amountCents: 500,
      currency: "USD",
      status: "SUCCEEDED",
      teamId: null,
      product: "EVIDENCE_CREDIT",
      providerResourceId: sessionId,
    } as never);
    await grantEvidenceCredits({ userId, credits, provider: "STRIPE", providerRef: sessionId });
    return { userId, sessionId, paymentIntent };
  }

  const wallet = async (userId: string) =>
    (await prisma.entitlement.findFirstOrThrow({ where: { userId, active: true }, orderBy: { createdAt: "desc" }, select: { credits: true } })).credits;
  const reversals = (sessionId: string) =>
    prisma.evidenceCreditLedgerEntry.count({ where: { entryType: "REVERSAL", provider: "STRIPE", providerRef: sessionId } });
  const refunded = (paymentIntent: string) => ({
    type: "charge.refunded",
    data: { object: { id: `ch_${randomUUID().slice(0, 8)}`, payment_intent: paymentIntent, amount: 500, amount_refunded: 500, refunded: true } },
  });

  it("a full refund writes ONE reversal, takes the credits back and marks the payment REFUNDED; a redelivery is a no-op", async () => {
    const p = await purchased(3);
    const before = await wallet(p.userId);

    const res = await deliver(refunded(p.paymentIntent));
    expect(res.statusCode, res.body).toBe(200);
    expect(await reversals(p.sessionId)).toBe(1);
    expect(await wallet(p.userId)).toBe(before - 3);
    const payment = await prisma.payment.findFirstOrThrow({ where: { provider: "STRIPE", providerPaymentId: p.sessionId }, select: { status: true } });
    expect(payment.status).toBe("REFUNDED");

    // The same refund delivered again (a new event id) changes nothing.
    expect((await deliver(refunded(p.paymentIntent))).statusCode).toBe(200);
    expect(await reversals(p.sessionId)).toBe(1);
    expect(await wallet(p.userId)).toBe(before - 3);
  });

  it("a LOST dispute reverses; a won dispute does not", async () => {
    const won = await purchased(3);
    const beforeWon = await wallet(won.userId);
    await deliver({ type: "charge.dispute.closed", data: { object: { id: "dp_w", status: "won", payment_intent: won.paymentIntent } } });
    expect(await reversals(won.sessionId)).toBe(0);
    expect(await wallet(won.userId)).toBe(beforeWon);

    const lost = await purchased(3);
    const beforeLost = await wallet(lost.userId);
    await deliver({ type: "charge.dispute.closed", data: { object: { id: "dp_l", status: "lost", payment_intent: lost.paymentIntent } } });
    expect(await reversals(lost.sessionId)).toBe(1);
    expect(await wallet(lost.userId)).toBe(beforeLost - 3);
  });

  it("a PARTIAL refund reverses nothing and goes to billing review", async () => {
    const p = await purchased(3);
    const before = await wallet(p.userId);
    await deliver({
      type: "charge.refunded",
      data: { object: { id: "ch_p", payment_intent: p.paymentIntent, amount: 500, amount_refunded: 200, refunded: false } },
    });
    expect(await reversals(p.sessionId)).toBe(0);
    expect(await wallet(p.userId)).toBe(before);
    expect(await prisma.billingReviewItem.count({ where: { provider: "STRIPE", providerResourceId: p.sessionId, reason: "PARTIAL_REFUND" } })).toBe(1);
  });
});
