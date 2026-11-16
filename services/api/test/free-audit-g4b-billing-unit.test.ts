/**
 * FREE-USER AUDIT 0ea0 — GROUP API-G4B-BILLING-STORAGE (unit).
 *
 * The provider-facing halves of the group, with every provider client and the
 * checkout-attempt store replaced at the module boundary (no socket, no
 * database): the second credit purchase inside the reuse window (B6-F-02) and
 * the classification of a webhook this deployment cannot verify (B6-F-80).
 * The live behaviour is in free-audit-g4b-billing-storage.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  openCheckoutAttempt: vi.fn(),
  bindCheckoutAttempt: vi.fn(async () => undefined),
  recordCheckoutCreateFailure: vi.fn(async () => undefined),
  stripeGet: vi.fn(),
  settleStripe: vi.fn(async () => ({ product: "EVIDENCE_CREDIT", outcome: "GRANTED" })),
  createStripeCheckoutSession: vi.fn(async () => ({
    session: { id: "cs_new", url: "https://checkout.stripe.com/c/pay/cs_new", status: "open" },
    currency: "USD",
  })),
  getPayPalOrder: vi.fn(),
  settlePayPal: vi.fn(async () => ({ outcome: "GRANTED" })),
  createPayPalCheckout: vi.fn(async () => ({
    mode: "order",
    order: { id: "ORDER-NEW", status: "CREATED" },
    diagnostics: {},
  })),
  securityEvents: vi.fn(),
}));

vi.mock("../src/services/billing/checkout-attempts.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    openCheckoutAttempt: m.openCheckoutAttempt,
    bindCheckoutAttempt: m.bindCheckoutAttempt,
    recordCheckoutCreateFailure: m.recordCheckoutCreateFailure,
  };
});
vi.mock("../src/services/stripe.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, stripeGet: m.stripeGet };
});
vi.mock("../src/services/billing/stripe-settlement.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, settleStripeCheckoutSession: m.settleStripe };
});
vi.mock("../src/services/billing/stripe-customer-binding.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, resolveStripeCheckoutCustomer: async () => null };
});
vi.mock("../src/services/billing-checkout.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createStripeCheckoutSession: m.createStripeCheckoutSession,
    createPayPalCheckout: m.createPayPalCheckout,
  };
});
vi.mock("../src/services/paypal.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getPayPalOrder: m.getPayPalOrder };
});
vi.mock("../src/services/billing/paypal-settlement.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, settlePayPalEvidenceCreditOrder: m.settlePayPal };
});
vi.mock("../src/services/security/security-event.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, safeEmitSecurityEvent: m.securityEvents };
});

import { startStripeCreditCheckout } from "../src/services/billing/stripe-checkout-start.service.js";
import { startPayPalCreditCheckout } from "../src/services/billing/paypal-checkout-start.service.js";
import { auditWebhookSignatureVerification } from "../src/services/security/webhook-signature-audit.service.js";
import { paymentsUnavailable } from "../src/services/billing/payments-unavailable.js";

const reuse = (providerResourceId: string) => ({
  kind: "REUSE" as const,
  attempt: { id: "attempt-previous", providerResourceId, createdAt: new Date() },
});
const open = { kind: "OPEN" as const, attemptId: "attempt-new" };

const fakeRequest = () =>
  ({ id: "req-1", log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }) as never;

describe("free-audit 0ea0 — API-G4B-BILLING-STORAGE (unit)", () => {
  beforeEach(() => {
    for (const fn of Object.values(m)) fn.mockClear();
    m.openCheckoutAttempt.mockReset();
    m.stripeGet.mockReset();
    m.getPayPalOrder.mockReset();
  });

  describe("B6-F-02 — a second credit purchase inside the 2-minute window", () => {
    it("Stripe: a previous session Stripe already completed is settled and a NEW checkout opens", async () => {
      m.openCheckoutAttempt.mockResolvedValueOnce(reuse("cs_prev")).mockResolvedValueOnce(open);
      m.stripeGet.mockResolvedValue({ id: "cs_prev", status: "complete", payment_status: "paid", metadata: { userId: "u1" } });

      const started = await startStripeCreditCheckout({ userId: "u1", currency: "USD" });

      expect(started.kind).toBe("CREATED");
      expect(m.settleStripe).toHaveBeenCalledTimes(1);
      expect((m.settleStripe.mock.calls as unknown as Array<[unknown]>)[0]![0]).toMatchObject({ expectedUserId: "u1" });
      expect(m.createStripeCheckoutSession).toHaveBeenCalledTimes(1);
    });

    it("Stripe: a completed session still settling names the purchase being confirmed, never 'already starting'", async () => {
      m.openCheckoutAttempt.mockResolvedValue(reuse("cs_prev"));
      m.stripeGet.mockResolvedValue({ id: "cs_prev", status: "complete", payment_status: "unpaid", metadata: { userId: "u1" } });

      const started = await startStripeCreditCheckout({ userId: "u1", currency: "USD" });

      expect(started.kind).toBe("BLOCKED");
      const body = (started as { httpBody: { code: string; message: string; details: Record<string, unknown> } }).httpBody;
      expect(body.code).toBe("PREVIOUS_PURCHASE_CONFIRMING");
      expect(body.message).not.toMatch(/already starting/i);
      expect(body.details.attemptId).toBe("attempt-previous");
      expect(m.createStripeCheckoutSession).not.toHaveBeenCalled();
    });

    it("Stripe: a still-payable session is reused exactly as before (no settlement)", async () => {
      m.openCheckoutAttempt.mockResolvedValueOnce(reuse("cs_prev"));
      m.stripeGet.mockResolvedValue({ id: "cs_prev", status: "open", url: "https://checkout.stripe.com/c/pay/cs_prev" });

      const started = await startStripeCreditCheckout({ userId: "u1", currency: "USD" });

      expect(started.kind).toBe("REUSED");
      expect(m.settleStripe).not.toHaveBeenCalled();
    });

    it("PayPal: a COMPLETED previous order is settled without capture and a NEW checkout opens; an APPROVED one is named", async () => {
      m.openCheckoutAttempt.mockResolvedValueOnce(reuse("ORDER-PREV")).mockResolvedValueOnce(open);
      m.getPayPalOrder.mockResolvedValue({ id: "ORDER-PREV", status: "COMPLETED" });

      const started = await startPayPalCreditCheckout({ userId: "u1", currency: "USD" });

      expect(started.kind).toBe("CREATED");
      expect(m.settlePayPal).toHaveBeenCalledWith(expect.objectContaining({ orderId: "ORDER-PREV", capture: false, expectedUserId: "u1" }));

      m.openCheckoutAttempt.mockReset();
      m.openCheckoutAttempt.mockResolvedValue(reuse("ORDER-APPR"));
      m.getPayPalOrder.mockResolvedValue({ id: "ORDER-APPR", status: "APPROVED" });
      m.settlePayPal.mockClear();

      const approved = await startPayPalCreditCheckout({ userId: "u1", currency: "USD" });
      expect(approved.kind).toBe("BLOCKED");
      expect((approved as { httpBody: { code: string } }).httpBody.code).toBe("PREVIOUS_PURCHASE_CONFIRMING");
      // Nothing is captured from a start click.
      expect(m.settlePayPal).not.toHaveBeenCalled();
    });
  });

  describe("B6-F-80 — a webhook this deployment cannot verify is not a forged signature", () => {
    it("a missing STRIPE_WEBHOOK_SECRET / PAYPAL_WEBHOOK_ID is verifier_unavailable with no HIGH security event", async () => {
      for (const [provider, setting] of [
        ["stripe", "STRIPE_WEBHOOK_SECRET"],
        ["paypal", "PAYPAL_WEBHOOK_ID"],
      ] as const) {
        m.securityEvents.mockClear();
        const result = await auditWebhookSignatureVerification({
          provider,
          request: fakeRequest(),
          presentSignature: true,
          verify: () => {
            throw paymentsUnavailable(provider, setting);
          },
        });
        expect(result, provider).toMatchObject({ ok: false, reason: "verifier_unavailable" });
        expect(m.securityEvents, provider).not.toHaveBeenCalled();
      }
    });

    it("control: a genuinely invalid signature is still classified and audited", async () => {
      const result = await auditWebhookSignatureVerification({
        provider: "stripe",
        request: fakeRequest(),
        presentSignature: true,
        verify: () => {
          throw new Error("No matching v1 signature");
        },
      });
      expect(result).toMatchObject({ ok: false, reason: "invalid_signature" });
      expect(m.securityEvents).toHaveBeenCalledTimes(1);
    });
  });
});
