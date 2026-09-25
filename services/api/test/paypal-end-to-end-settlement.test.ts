/**
 * PAYPAL END TO END — behavioural regression tests.
 *
 * Every PayPal HTTP call is mocked; nothing here reaches PayPal or a database.
 * The settlement service, the webhook route and `syncPlanForSubscription` run
 * for real, over in-memory stand-ins for the wallet, the payment table and the
 * subscription table.
 *
 * WHAT THIS STOPS HAPPENING AGAIN
 *  - an approved evidence-credit order that nobody captures (no money, no credit)
 *  - a capture webhook that cannot find its purchase (no purchase_units/custom_id)
 *  - duplicate / out-of-order deliveries granting twice or moving state backwards
 *  - paid access before PayPal activates a subscription
 *  - a PayPal upgrade that never lands because custom_id still names the old plan
 *  - a storage add-on custom_id over PayPal's 127-character limit (400 INVALID_REQUEST)
 *  - a 422 from PayPal that reaches the log with no `details[]`
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const TEAM = "33333333-3333-4333-8333-333333333333";

const state = vi.hoisted(() => ({
  orders: new Map<string, Record<string, unknown>>(),
  subscriptions: new Map<string, Record<string, unknown>>(),
  ledger: new Set<string>(),
  payments: new Map<string, { status: string; amountCents: number; currency: string; userId: string }>(),
  subRows: new Map<string, { status: string; plan: string; userId: string; teamId: string | null; providerStateAtUtc: Date | null; pendingPlan: string | null; pendingPlanEffectiveAtUtc: Date | null }>(),
  webhookEvents: new Map<string, { processingStatus: string; payloadHash: string | null }>(),
  captureCalls: [] as string[],
  captureImpl: null as null | ((orderId: string) => Promise<Record<string, unknown>>),
  subscriptionReadFails: false,
}));

vi.mock("../src/db.js", () => {
  const prisma = {
    paypalWebhookEvent: {
      create: vi.fn(async ({ data }: { data: { paypalEventId: string; payloadHash: string } }) => {
        if (state.webhookEvents.has(data.paypalEventId)) {
          throw Object.assign(new Error("dup"), { code: "P2002" });
        }
        state.webhookEvents.set(data.paypalEventId, { processingStatus: "RECEIVED", payloadHash: data.payloadHash });
        return {};
      }),
      findUnique: vi.fn(async ({ where }: { where: { paypalEventId: string } }) =>
        state.webhookEvents.get(where.paypalEventId) ?? null,
      ),
      update: vi.fn(async ({ where, data }: { where: { paypalEventId: string }; data: { processingStatus: string } }) => {
        const row = state.webhookEvents.get(where.paypalEventId);
        if (row) row.processingStatus = data.processingStatus;
        return row;
      }),
    },
    subscription: {
      findUnique: vi.fn(async ({ where }: { where: { provider_providerSubId: { providerSubId: string } } }) =>
        state.subRows.get(where.provider_providerSubId.providerSubId) ?? null,
      ),
      findFirst: vi.fn(async () => null),
    },
    team: { findUnique: vi.fn(async () => null) },
  };
  return { prisma };
});

vi.mock("../src/services/security/webhook-signature-audit.service.js", () => ({
  auditWebhookSignatureVerification: async (input: { verify: () => Promise<unknown> }) => {
    try {
      await input.verify();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  },
}));

vi.mock("../src/services/billing/evidence-credits.service.js", () => ({
  grantEvidenceCredits: vi.fn(async (p: { providerRef: string; credits: number }) => {
    const granted = !state.ledger.has(p.providerRef);
    state.ledger.add(p.providerRef);
    return { granted, balanceAfter: state.ledger.size };
  }),
}));

vi.mock("../src/services/billing.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/billing.service.js")>();
  const { decideSubscriptionTransition, observedStateFromSubscriptionStatus } = await import(
    "../src/services/billing/subscription-status.js"
  );
  return {
    ...actual,
    ensureEntitlement: vi.fn(async () => ({ plan: "FREE", credits: 0 })),
    setPersonalPlan: vi.fn(async () => undefined),
    upsertWorkspaceStorageAddon: vi.fn(async () => ({})),
    recordPayment: vi.fn(async (p: { providerPaymentId: string; status: string; amountCents: number; currency: string; userId: string }) => {
      const existing = state.payments.get(p.providerPaymentId);
      // The real rule: a settled payment never moves backwards.
      if (existing?.status === "SUCCEEDED" && p.status === "PENDING") return existing;
      state.payments.set(p.providerPaymentId, { status: p.status, amountCents: p.amountCents, currency: p.currency, userId: p.userId });
      return state.payments.get(p.providerPaymentId);
    }),
    // A faithful miniature of upsertSubscription: same transition rule, same
    // subject binding, same return shape the lifecycle handler reads.
    upsertSubscription: vi.fn(async (p: { providerSubId: string; status: string; plan: string; userId: string; teamId?: string | null; observedAtUtc?: Date | null }) => {
      const existing = state.subRows.get(p.providerSubId);
      if (existing) {
        if (existing.userId !== p.userId) throw new Error("subject mismatch");
        const decision = decideSubscriptionTransition({
          current: existing.status as never,
          currentObservedAtUtc: existing.providerStateAtUtc,
          observed: observedStateFromSubscriptionStatus(p.status as never),
          observedAtUtc: p.observedAtUtc ?? null,
        });
        if (!decision.apply && decision.reason !== "ALREADY_THAT_STATUS") return existing;
      }
      const row = {
        status: p.status,
        plan: p.plan,
        userId: p.userId,
        teamId: p.teamId ?? null,
        providerStateAtUtc: p.observedAtUtc ?? existing?.providerStateAtUtc ?? null,
        pendingPlan: existing?.pendingPlan ?? null,
        pendingPlanEffectiveAtUtc: existing?.pendingPlanEffectiveAtUtc ?? null,
      };
      state.subRows.set(p.providerSubId, row);
      return row;
    }),
  };
});

vi.mock("../src/services/paypal.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/paypal.service.js")>();
  return {
    ...actual,
    verifyPayPalWebhook: vi.fn(async () => ({ verification_status: "SUCCESS" })),
    getPayPalOrder: vi.fn(async (orderId: string) => {
      const order = state.orders.get(orderId);
      if (!order) {
        throw new actual.PayPalHttpError({ message: "not found", status: 404, providerErrorName: "RESOURCE_NOT_FOUND", debugId: null });
      }
      return structuredClone(order);
    }),
    capturePayPalOrder: vi.fn(async (orderId: string) => {
      state.captureCalls.push(orderId);
      if (state.captureImpl) return state.captureImpl(orderId);
      return captureOrder(orderId, "COMPLETED");
    }),
    getPayPalSubscription: vi.fn(async (id: string) => {
      if (state.subscriptionReadFails) throw new Error("paypal down");
      const sub = state.subscriptions.get(id);
      if (!sub) throw new Error("not found");
      return structuredClone(sub);
    }),
  };
});

// Imports AFTER the mocks.
import * as prismaPkg from "@prisma/client";
import * as billingService from "../src/services/billing.service.js";
import { grantEvidenceCredits } from "../src/services/billing/evidence-credits.service.js";
import {
  applyPayPalSubscriptionState,
  settlePayPalEvidenceCreditOrder,
} from "../src/services/billing/paypal-settlement.service.js";
import {
  buildPayPalStorageAddonCustomId,
  parsePayPalCustomId,
  parsePayPalStorageAddonCustomId,
  PAYPAL_CUSTOM_ID_MAX_LENGTH,
} from "../src/services/paypal-checkout-policy.service.js";
import { webhooksRoutes } from "../src/routes/webhooks.routes.js";

// ---------------------------------------------------------------------------
// PayPal fixtures
// ---------------------------------------------------------------------------

function creditOrder(orderId: string, status: string, over: { userId?: string; value?: string; currency?: string } = {}) {
  const order = {
    id: orderId,
    status,
    intent: "CAPTURE",
    update_time: "2026-09-25T10:00:00Z",
    purchase_units: [
      {
        custom_id: `${over.userId ?? USER}::PAYG`,
        amount: { currency_code: over.currency ?? "USD", value: over.value ?? "5.00" },
      },
    ],
  };
  state.orders.set(orderId, order);
  return order;
}

function captureOrder(orderId: string, captureStatus: string) {
  const order = state.orders.get(orderId)!;
  const unit = (order.purchase_units as Array<Record<string, unknown>>)[0]!;
  order.status = captureStatus === "COMPLETED" || captureStatus === "PENDING" ? "COMPLETED" : "APPROVED";
  unit.payments = {
    captures: [
      {
        id: `CAP-${orderId}`,
        status: captureStatus,
        amount: unit.amount,
        update_time: "2026-09-25T10:01:00Z",
      },
    ],
  };
  return structuredClone(order);
}

function setSubscription(id: string, over: Record<string, unknown>) {
  state.subscriptions.set(id, {
    id,
    status: "APPROVAL_PENDING",
    plan_id: "P-PRO-USD",
    custom_id: `${USER}::PRO`,
    status_update_time: "2026-09-25T10:00:00Z",
    billing_info: { next_billing_time: "2026-10-25T10:00:00Z" },
    ...over,
  });
}

let app: FastifyInstance;
let eventSeq = 0;

async function deliver(eventType: string, resource: Record<string, unknown>, eventId = `WH-${++eventSeq}`) {
  return app.inject({
    method: "POST",
    url: "/webhooks/paypal",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ id: eventId, event_type: eventType, resource }),
  });
}

beforeAll(async () => {
  process.env.PAYPAL_PRO_PLAN_ID_USD = "P-PRO-USD";
  process.env.PAYPAL_TEAM_PLAN_ID_USD = "P-TEAM-USD";
  process.env.PAYPAL_PLAN_STORAGE_PERSONAL_10_GB_USD = "P-S10-USD";
  process.env.PAYPAL_PLAN_STORAGE_TEAM_100_GB_USD = "P-T100-USD";
  delete process.env.BILLING_PAYG_PRICE_CENTS_USD;

  app = Fastify();
  // The route installs its own raw-body (Buffer) JSON parser for signature checks.
  await app.register(webhooksRoutes, { prefix: "/webhooks" });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  state.orders.clear();
  state.subscriptions.clear();
  state.ledger.clear();
  state.payments.clear();
  state.subRows.clear();
  state.webhookEvents.clear();
  state.captureCalls.length = 0;
  state.captureImpl = null;
  state.subscriptionReadFails = false;
  vi.mocked(billingService.setPersonalPlan).mockClear();
  vi.mocked(billingService.upsertWorkspaceStorageAddon).mockClear();
  vi.mocked(grantEvidenceCredits).mockClear();
});

// ===========================================================================
// Phase 2 — Evidence Credits: create → approve → return → capture → grant
// ===========================================================================

describe("evidence credits — server-side capture on return", () => {
  it("captures an APPROVED order of the caller and grants the credit from the COMPLETED capture", async () => {
    creditOrder("ORDER-OK-1", "APPROVED");
    const result = await settlePayPalEvidenceCreditOrder({ orderId: "ORDER-OK-1", expectedUserId: USER, capture: true });

    expect(result).toMatchObject({ outcome: "GRANTED", captureId: "CAP-ORDER-OK-1", credits: 1 });
    expect(state.captureCalls).toEqual(["ORDER-OK-1"]);
    expect(grantEvidenceCredits).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, providerRef: "CAP-ORDER-OK-1", provider: prismaPkg.PaymentProvider.PAYPAL }),
    );
    expect(state.payments.get("CAP-ORDER-OK-1")).toMatchObject({ status: "SUCCEEDED", amountCents: 500, currency: "USD" });
  });

  it("a second return (refresh / second tab) does not capture or grant again", async () => {
    creditOrder("ORDER-OK-2", "APPROVED");
    await settlePayPalEvidenceCreditOrder({ orderId: "ORDER-OK-2", expectedUserId: USER, capture: true });
    const again = await settlePayPalEvidenceCreditOrder({ orderId: "ORDER-OK-2", expectedUserId: USER, capture: true });

    expect(again.outcome).toBe("ALREADY_GRANTED");
    expect(state.captureCalls).toEqual(["ORDER-OK-2"]);
    expect(state.ledger.size).toBe(1);
  });

  it("refuses an order that belongs to another account — nothing captured, nothing granted", async () => {
    creditOrder("ORDER-OTHER", "APPROVED", { userId: OTHER_USER });
    const result = await settlePayPalEvidenceCreditOrder({ orderId: "ORDER-OTHER", expectedUserId: USER, capture: true });

    expect(result).toMatchObject({ outcome: "REJECTED", reason: "NOT_OWNED" });
    expect(state.captureCalls).toEqual([]);
    expect(grantEvidenceCredits).not.toHaveBeenCalled();
  });

  it("an unapproved order (buyer returned without approving) grants nothing", async () => {
    creditOrder("ORDER-CREATED", "CREATED");
    const result = await settlePayPalEvidenceCreditOrder({ orderId: "ORDER-CREATED", expectedUserId: USER, capture: true });

    expect(result).toMatchObject({ outcome: "PENDING", reason: "AWAITING_APPROVAL" });
    expect(state.captureCalls).toEqual([]);
    expect(grantEvidenceCredits).not.toHaveBeenCalled();
  });

  it("a PAYER_ACTION_REQUIRED order grants nothing", async () => {
    creditOrder("ORDER-PAR", "PAYER_ACTION_REQUIRED");
    const result = await settlePayPalEvidenceCreditOrder({ orderId: "ORDER-PAR", expectedUserId: USER, capture: true });
    expect(result.outcome).toBe("PENDING");
    expect(grantEvidenceCredits).not.toHaveBeenCalled();
  });

  it("a voided (cancelled) order grants nothing", async () => {
    creditOrder("ORDER-VOID", "VOIDED");
    const result = await settlePayPalEvidenceCreditOrder({ orderId: "ORDER-VOID", expectedUserId: USER, capture: true });
    expect(result.outcome).toBe("CANCELED");
    expect(state.captureCalls).toEqual([]);
    expect(grantEvidenceCredits).not.toHaveBeenCalled();
  });

  it("never captures an order whose amount is not the server price", async () => {
    creditOrder("ORDER-CHEAP", "APPROVED", { value: "0.01" });
    const result = await settlePayPalEvidenceCreditOrder({ orderId: "ORDER-CHEAP", expectedUserId: USER, capture: true });
    expect(result).toMatchObject({ outcome: "REJECTED", reason: "AMOUNT_MISMATCH" });
    expect(state.captureCalls).toEqual([]);
    expect(grantEvidenceCredits).not.toHaveBeenCalled();
  });

  it("never captures an order in a currency the product is not sold in", async () => {
    creditOrder("ORDER-GBP", "APPROVED", { currency: "GBP" });
    const result = await settlePayPalEvidenceCreditOrder({ orderId: "ORDER-GBP", expectedUserId: USER, capture: true });
    expect(result).toMatchObject({ outcome: "REJECTED", reason: "AMOUNT_MISMATCH" });
    expect(state.captureCalls).toEqual([]);
  });

  it("a PENDING capture records a pending payment and grants nothing yet", async () => {
    creditOrder("ORDER-PEND", "APPROVED");
    state.captureImpl = async (id) => captureOrder(id, "PENDING");
    const result = await settlePayPalEvidenceCreditOrder({ orderId: "ORDER-PEND", expectedUserId: USER, capture: true });

    expect(result).toMatchObject({ outcome: "PENDING", reason: "CAPTURE_PENDING" });
    expect(state.payments.get("CAP-ORDER-PEND")?.status).toBe("PENDING");
    expect(grantEvidenceCredits).not.toHaveBeenCalled();
  });

  it("a declined capture (422 INSTRUMENT_DECLINED) grants nothing and reports the issue", async () => {
    creditOrder("ORDER-DECL", "APPROVED");
    const { PayPalHttpError } = await import("../src/services/paypal.service.js");
    state.captureImpl = async () => {
      throw new PayPalHttpError({
        message: "declined",
        status: 422,
        providerErrorName: "UNPROCESSABLE_ENTITY",
        debugId: "dbg",
        details: [{ issue: "INSTRUMENT_DECLINED", field: null, location: null, description: null }],
      });
    };
    const result = await settlePayPalEvidenceCreditOrder({ orderId: "ORDER-DECL", expectedUserId: USER, capture: true });
    expect(result).toMatchObject({ outcome: "FAILED", reason: "CAPTURE_REJECTED", providerIssue: "INSTRUMENT_DECLINED" });
    expect(grantEvidenceCredits).not.toHaveBeenCalled();
  });

  it("ORDER_ALREADY_CAPTURED (webhook won the race) reads the capture and grants once", async () => {
    creditOrder("ORDER-RACE", "APPROVED");
    const { PayPalHttpError } = await import("../src/services/paypal.service.js");
    state.captureImpl = async (id) => {
      captureOrder(id, "COMPLETED"); // the concurrent capture landed at PayPal
      throw new PayPalHttpError({
        message: "already",
        status: 422,
        providerErrorName: "UNPROCESSABLE_ENTITY",
        debugId: null,
        details: [{ issue: "ORDER_ALREADY_CAPTURED", field: null, location: null, description: null }],
      });
    };
    const result = await settlePayPalEvidenceCreditOrder({ orderId: "ORDER-RACE", expectedUserId: USER, capture: true });
    expect(result.outcome).toBe("GRANTED");
    expect(state.ledger.size).toBe(1);
  });
});

// ===========================================================================
// Phase 3 — webhooks
// ===========================================================================

describe("PayPal webhooks — captures", () => {
  it("PAYMENT.CAPTURE.COMPLETED without purchase_units or custom_id recovers the purchase from the related order", async () => {
    creditOrder("ORDER-WH-1", "APPROVED");
    captureOrder("ORDER-WH-1", "COMPLETED");
    const res = await deliver("PAYMENT.CAPTURE.COMPLETED", {
      id: "CAP-ORDER-WH-1",
      status: "COMPLETED",
      amount: { currency_code: "USD", value: "5.00" },
      supplementary_data: { related_ids: { order_id: "ORDER-WH-1" } },
    });

    expect(res.statusCode).toBe(200);
    expect(grantEvidenceCredits).toHaveBeenCalledWith(expect.objectContaining({ userId: USER, providerRef: "CAP-ORDER-WH-1" }));
    expect(state.ledger.size).toBe(1);
  });

  it("a duplicate delivery of the same event grants exactly once", async () => {
    creditOrder("ORDER-WH-2", "APPROVED");
    captureOrder("ORDER-WH-2", "COMPLETED");
    const resource = {
      id: "CAP-ORDER-WH-2",
      status: "COMPLETED",
      supplementary_data: { related_ids: { order_id: "ORDER-WH-2" } },
    };
    const first = await deliver("PAYMENT.CAPTURE.COMPLETED", resource, "WH-DUP");
    const second = await deliver("PAYMENT.CAPTURE.COMPLETED", resource, "WH-DUP");

    expect(first.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ deduplicated: true });
    expect(grantEvidenceCredits).toHaveBeenCalledTimes(1);
    expect(state.ledger.size).toBe(1);
  });

  it("CHECKOUT.ORDER.APPROVED captures server-side (buyer closed the tab) and the later capture event does not grant again", async () => {
    creditOrder("ORDER-WH-3", "APPROVED");
    await deliver("CHECKOUT.ORDER.APPROVED", { id: "ORDER-WH-3", status: "APPROVED" });
    expect(state.captureCalls).toEqual(["ORDER-WH-3"]);
    expect(state.ledger.size).toBe(1);

    await deliver("PAYMENT.CAPTURE.COMPLETED", {
      id: "CAP-ORDER-WH-3",
      status: "COMPLETED",
      supplementary_data: { related_ids: { order_id: "ORDER-WH-3" } },
    });
    // And the buyer's own return after both webhooks:
    const ret = await settlePayPalEvidenceCreditOrder({ orderId: "ORDER-WH-3", expectedUserId: USER, capture: true });

    expect(ret.outcome).toBe("ALREADY_GRANTED");
    expect(state.captureCalls).toEqual(["ORDER-WH-3"]);
    expect(state.ledger.size).toBe(1);
  });

  it("out of order: a PAYMENT.CAPTURE.PENDING delivered after COMPLETED does not move the payment backwards", async () => {
    creditOrder("ORDER-WH-4", "APPROVED");
    captureOrder("ORDER-WH-4", "COMPLETED");
    const resource = { id: "CAP-ORDER-WH-4", supplementary_data: { related_ids: { order_id: "ORDER-WH-4" } } };
    await deliver("PAYMENT.CAPTURE.COMPLETED", { ...resource, status: "COMPLETED" });
    await deliver("PAYMENT.CAPTURE.PENDING", { ...resource, status: "PENDING" });

    expect(state.payments.get("CAP-ORDER-WH-4")?.status).toBe("SUCCEEDED");
    expect(state.ledger.size).toBe(1);
  });

  it("a capture whose order is not an evidence-credit purchase grants nothing", async () => {
    state.orders.set("ORDER-PLAN", {
      id: "ORDER-PLAN",
      status: "COMPLETED",
      purchase_units: [{ custom_id: `${USER}::PRO`, amount: { currency_code: "USD", value: "19.00" } }],
    });
    const res = await deliver("PAYMENT.CAPTURE.COMPLETED", {
      id: "CAP-PLAN",
      status: "COMPLETED",
      supplementary_data: { related_ids: { order_id: "ORDER-PLAN" } },
    });
    expect(res.statusCode).toBe(200);
    expect(grantEvidenceCredits).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Phase 4 — subscriptions
// ===========================================================================

describe("PayPal subscriptions — no entitlement before activation", () => {
  it.each(["CREATED", "APPROVAL_PENDING", "APPROVED"])("%s grants no paid plan", async (status) => {
    setSubscription("I-PRE", { status });
    const res = await deliver("BILLING.SUBSCRIPTION.CREATED", { id: "I-PRE", status });
    expect(res.statusCode).toBe(200);
    expect(billingService.setPersonalPlan).not.toHaveBeenCalled();
    expect(state.subRows.get("I-PRE")?.status).toBe("TRIALING");
  });

  it("the plan is granted only once PayPal reports ACTIVE", async () => {
    setSubscription("I-ACT", { status: "APPROVAL_PENDING" });
    await deliver("BILLING.SUBSCRIPTION.CREATED", { id: "I-ACT" });
    expect(billingService.setPersonalPlan).not.toHaveBeenCalled();

    setSubscription("I-ACT", { status: "ACTIVE", status_update_time: "2026-09-25T10:05:00Z" });
    await deliver("BILLING.SUBSCRIPTION.ACTIVATED", { id: "I-ACT", status: "ACTIVE" });
    expect(billingService.setPersonalPlan).toHaveBeenCalledWith(USER, "PRO");
  });

  it("out of order: a late CREATED event (live read unavailable) cannot revoke an ACTIVE plan", async () => {
    setSubscription("I-OOO", { status: "ACTIVE", status_update_time: "2026-09-25T10:05:00Z" });
    await deliver("BILLING.SUBSCRIPTION.ACTIVATED", { id: "I-OOO" });
    expect(state.subRows.get("I-OOO")?.status).toBe("ACTIVE");

    state.subscriptionReadFails = true;
    await deliver("BILLING.SUBSCRIPTION.CREATED", {
      id: "I-OOO",
      status: "APPROVAL_PENDING",
      plan_id: "P-PRO-USD",
      custom_id: `${USER}::PRO`,
      create_time: "2026-09-25T09:59:00Z",
    });

    expect(state.subRows.get("I-OOO")?.status).toBe("ACTIVE");
    expect(billingService.setPersonalPlan).not.toHaveBeenCalledWith(USER, "FREE");
  });

  it("upgrade: after a revise, the billed plan_id (TEAM) wins over the stale custom_id (PRO)", async () => {
    setSubscription("I-UP", { status: "ACTIVE" });
    await deliver("BILLING.SUBSCRIPTION.ACTIVATED", { id: "I-UP" });
    expect(billingService.setPersonalPlan).toHaveBeenLastCalledWith(USER, "PRO");

    setSubscription("I-UP", { status: "ACTIVE", plan_id: "P-TEAM-USD", status_update_time: "2026-09-26T10:00:00Z" });
    await deliver("BILLING.SUBSCRIPTION.UPDATED", { id: "I-UP" });
    expect(billingService.setPersonalPlan).toHaveBeenLastCalledWith(USER, "TEAM");
    expect(state.subRows.get("I-UP")?.plan).toBe("TEAM");
  });

  it("a scheduled (period-end) downgrade is not applied before its effective date", async () => {
    setSubscription("I-DOWN", { status: "ACTIVE", plan_id: "P-TEAM-USD", custom_id: `${USER}::TEAM` });
    await deliver("BILLING.SUBSCRIPTION.ACTIVATED", { id: "I-DOWN" });
    const row = state.subRows.get("I-DOWN")!;
    row.pendingPlan = "PRO";
    row.pendingPlanEffectiveAtUtc = new Date(Date.now() + 7 * 86400_000);

    setSubscription("I-DOWN", { status: "ACTIVE", plan_id: "P-PRO-USD", custom_id: `${USER}::TEAM`, status_update_time: "2026-09-26T10:00:00Z" });
    await deliver("BILLING.SUBSCRIPTION.UPDATED", { id: "I-DOWN" });
    expect(billingService.setPersonalPlan).toHaveBeenLastCalledWith(USER, "TEAM");
  });

  it("cancellation returns the account to FREE", async () => {
    setSubscription("I-CAN", { status: "ACTIVE" });
    await deliver("BILLING.SUBSCRIPTION.ACTIVATED", { id: "I-CAN" });
    setSubscription("I-CAN", { status: "CANCELLED", status_update_time: "2026-09-27T10:00:00Z" });
    await deliver("BILLING.SUBSCRIPTION.CANCELLED", { id: "I-CAN" });
    expect(billingService.setPersonalPlan).toHaveBeenLastCalledWith(USER, "FREE");
  });

  it("the return confirmation is bound to the signed-in account", async () => {
    setSubscription("I-MINE", { status: "ACTIVE", custom_id: `${OTHER_USER}::PRO` });
    const result = await applyPayPalSubscriptionState({ subscriptionId: "I-MINE", expectedUserId: USER, source: "test" });
    expect(result).toMatchObject({ outcome: "REJECTED", reason: "NOT_OWNED" });
    expect(billingService.setPersonalPlan).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Phase 5 — storage add-ons
// ===========================================================================

describe("PayPal storage add-ons — sa1 custom_id and activation", () => {
  it("the sa1 custom_id fits PayPal's 127-character limit with two UUIDs and round-trips", () => {
    const id = buildPayPalStorageAddonCustomId({ userId: USER, teamId: TEAM, addonKey: "PERSONAL_200_GB" as never });
    expect(id).toBe(`sa1|${USER}|${TEAM}|p200`);
    expect(id.length).toBeLessThanOrEqual(PAYPAL_CUSTOM_ID_MAX_LENGTH);
    expect(parsePayPalStorageAddonCustomId(id)).toEqual({ userId: USER, teamId: TEAM, storageAddonKey: "PERSONAL_200_GB" });

    const personal = buildPayPalStorageAddonCustomId({ userId: USER, addonKey: "PERSONAL_10_GB" as never });
    expect(personal).toBe(`sa1|${USER}|-|p10`);
    expect(parsePayPalStorageAddonCustomId(personal)?.teamId).toBeNull();
  });

  it("ROOT CAUSE: the JSON custom_id it replaced exceeded 127 characters (PayPal 400 INVALID_REQUEST)", () => {
    const legacy = JSON.stringify({
      userId: USER,
      teamId: null,
      storageAddonKey: "PERSONAL_200_GB",
      billingCycle: "MONTHLY",
      workspacePlan: "FREE",
    });
    expect(legacy.length).toBeGreaterThan(PAYPAL_CUSTOM_ID_MAX_LENGTH);
  });

  it("accepts both sa1 spellings in circulation: main's short codes and the full key", () => {
    expect(parsePayPalStorageAddonCustomId(`sa1|${USER}|-|t1t`)?.storageAddonKey).toBe("TEAM_1_TB");
    expect(parsePayPalStorageAddonCustomId(`sa1|${USER}|-|TEAM_1_TB`)?.storageAddonKey).toBe("TEAM_1_TB");
    expect(parsePayPalStorageAddonCustomId(`sa1|not-a-uuid|-|p10`)).toBeNull();
    expect(parsePayPalStorageAddonCustomId(`sa1|${USER}|not-a-uuid|p10`)).toBeNull();
  });

  it("the webhook activates an add-on created with main's short-code custom_id", async () => {
    setSubscription("I-SA-SHORT", { status: "ACTIVE", plan_id: "P-S10-USD", custom_id: `sa1|${USER}|-|p10` });
    await deliver("BILLING.SUBSCRIPTION.ACTIVATED", { id: "I-SA-SHORT" });
    expect(billingService.upsertWorkspaceStorageAddon).toHaveBeenLastCalledWith(
      expect.objectContaining({ ownerUserId: USER, addonKey: "PERSONAL_10_GB", status: "ACTIVE" }),
    );
  });

  it("the ONE parser accepts every format in circulation: sa1 short code, sa1 full key and legacy JSON", () => {
    const expected = { userId: USER, teamId: TEAM, storageAddonKey: "TEAM_100_GB" };
    expect(parsePayPalStorageAddonCustomId(`sa1|${USER}|${TEAM}|t100`)).toEqual(expected);
    expect(parsePayPalStorageAddonCustomId(`sa1|${USER}|${TEAM}|TEAM_100_GB`)).toEqual(expected);
    expect(
      parsePayPalStorageAddonCustomId(
        JSON.stringify({ userId: USER, teamId: TEAM, storageAddonKey: "TEAM_100_GB", billingCycle: "MONTHLY", workspacePlan: "TEAM" }),
      ),
    ).toEqual(expected);
    // Legacy JSON with no team, and with an explicit null team.
    expect(parsePayPalStorageAddonCustomId(JSON.stringify({ userId: USER, storageAddonKey: "PERSONAL_10_GB" }))).toEqual({
      userId: USER,
      teamId: null,
      storageAddonKey: "PERSONAL_10_GB",
    });
    expect(parsePayPalStorageAddonCustomId(JSON.stringify({ userId: USER, teamId: null, storageAddonKey: "PERSONAL_50_GB" }))?.teamId).toBeNull();
  });

  it("legacy JSON is validated exactly like sa1", () => {
    expect(parsePayPalStorageAddonCustomId(JSON.stringify({ userId: "not-a-uuid", storageAddonKey: "PERSONAL_10_GB" }))).toBeNull();
    expect(parsePayPalStorageAddonCustomId(JSON.stringify({ userId: USER, teamId: "not-a-uuid", storageAddonKey: "PERSONAL_10_GB" }))).toBeNull();
    expect(parsePayPalStorageAddonCustomId(JSON.stringify({ userId: USER, storageAddonKey: "PERSONAL_9000_GB" }))).toBeNull();
    expect(parsePayPalStorageAddonCustomId(JSON.stringify({ userId: USER, plan: "PRO" }))).toBeNull();
    expect(parsePayPalStorageAddonCustomId("{not json")).toBeNull();
    expect(parsePayPalStorageAddonCustomId("[1,2]")).toBeNull();
  });

  it("the webhook applies a legacy-JSON storage subscription as a storage add-on, never as a plan", async () => {
    setSubscription("I-SA-LEGACY", {
      status: "ACTIVE",
      plan_id: "P-S10-USD",
      custom_id: JSON.stringify({ userId: USER, teamId: null, storageAddonKey: "PERSONAL_10_GB", billingCycle: "MONTHLY", workspacePlan: "FREE" }),
    });
    await deliver("BILLING.SUBSCRIPTION.ACTIVATED", { id: "I-SA-LEGACY" });
    expect(billingService.upsertWorkspaceStorageAddon).toHaveBeenLastCalledWith(
      expect.objectContaining({ ownerUserId: USER, addonKey: "PERSONAL_10_GB", status: "ACTIVE" }),
    );
    expect(billingService.setPersonalPlan).not.toHaveBeenCalled();
  });

  it("rejects malformed or unknown sa1 values, and is never read as a plan", () => {
    expect(parsePayPalStorageAddonCustomId(`sa1|${USER}|-|NOT_A_KEY`)).toBeNull();
    expect(parsePayPalStorageAddonCustomId(`sa1|${USER}|PERSONAL_10_GB`)).toBeNull();
    expect(parsePayPalStorageAddonCustomId(`${USER}::PRO`)).toBeNull();
    expect(parsePayPalCustomId(`sa1|${USER}|-|PERSONAL_10_GB`)).toEqual({ userId: null, plan: null, teamId: null });
  });

  it("APPROVAL_PENDING records a PENDING add-on (no capacity), ACTIVE activates it", async () => {
    const custom_id = `sa1|${USER}|-|PERSONAL_10_GB`;
    setSubscription("I-SA", { status: "APPROVAL_PENDING", plan_id: "P-S10-USD", custom_id });
    await deliver("BILLING.SUBSCRIPTION.CREATED", { id: "I-SA" });
    expect(billingService.upsertWorkspaceStorageAddon).toHaveBeenLastCalledWith(
      expect.objectContaining({ ownerUserId: USER, addonKey: "PERSONAL_10_GB", status: "PENDING", externalSubscriptionId: "I-SA" }),
    );

    setSubscription("I-SA", { status: "ACTIVE", plan_id: "P-S10-USD", custom_id });
    await deliver("BILLING.SUBSCRIPTION.ACTIVATED", { id: "I-SA" });
    expect(billingService.upsertWorkspaceStorageAddon).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "ACTIVE", billingCycle: "MONTHLY", paymentProvider: "PAYPAL" }),
    );
    // A storage add-on is never a base plan change.
    expect(billingService.setPersonalPlan).not.toHaveBeenCalled();
  });

  it("does not activate an add-on billed on another add-on's plan (price mismatch)", async () => {
    setSubscription("I-SA-BAD", { status: "ACTIVE", plan_id: "P-T100-USD", custom_id: `sa1|${USER}|-|PERSONAL_10_GB` });
    const result = await applyPayPalSubscriptionState({ subscriptionId: "I-SA-BAD", source: "test" });
    expect(result).toMatchObject({ outcome: "REJECTED", reason: "PLAN_ID_MISMATCH" });
    expect(billingService.upsertWorkspaceStorageAddon).not.toHaveBeenCalled();
  });

  it("does not activate a team add-on for a workspace the payer does not own", async () => {
    setSubscription("I-SA-TEAM", { status: "ACTIVE", plan_id: "P-T100-USD", custom_id: `sa1|${USER}|${TEAM}|TEAM_100_GB` });
    const result = await applyPayPalSubscriptionState({ subscriptionId: "I-SA-TEAM", source: "test" });
    expect(result).toMatchObject({ outcome: "REJECTED", reason: "STORAGE_ADDON_NOT_ALLOWED" });
    expect(billingService.upsertWorkspaceStorageAddon).not.toHaveBeenCalled();
  });

  it("cancellation marks the add-on CANCELED", async () => {
    setSubscription("I-SA-C", { status: "CANCELLED", plan_id: "P-S10-USD", custom_id: `sa1|${USER}|-|PERSONAL_10_GB` });
    await deliver("BILLING.SUBSCRIPTION.CANCELLED", { id: "I-SA-C" });
    expect(billingService.upsertWorkspaceStorageAddon).toHaveBeenLastCalledWith(expect.objectContaining({ status: "CANCELED" }));
  });
});
