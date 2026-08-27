/**
 * BILLING RECONCILIATION (2026-08-27) — the PayPal observation adapter.
 *
 * Same contract as the Stripe adapter: read through the existing configured
 * client (`paypalGet`), return the shared internal observation, write nothing,
 * decide nothing, expose no PayPal object.
 *
 * WHERE PAYPAL DIFFERS, AND WHY THAT IS VISIBLE HERE
 * ---------------------------------------------------------------------------
 * PayPal splits what Stripe unifies. A one-time evidence-credit purchase is an
 * ORDER whose money lives in a nested capture; a plan is a SUBSCRIPTION whose
 * renewal history lives in a separate transactions endpoint with a required
 * time window. Both differences are absorbed here so the reconciliation
 * service sees one shape.
 *
 * The transactions window is bounded to a fixed number of days rather than
 * "since the beginning": the endpoint requires a range, and a widening range
 * is how a repair job turns into a rate-limit incident.
 */

import * as prismaPkg from "@prisma/client";

import { paypalGet } from "../../paypal.service.js";
import type {
  BillingReconciliationProvider,
  ObservedState,
  PaymentObservation,
  SubscriptionObservation,
} from "./types.js";

const PROVIDER = prismaPkg.PaymentProvider.PAYPAL;

/** How far back one subscription observation may look for renewals. */
const TRANSACTION_WINDOW_DAYS = 45;
/** How many recent transactions one observation may carry. */
const MAX_RECENT_TRANSACTIONS = 12;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * PayPal timestamps are RFC 3339 with an explicit offset. `Date` normalizes
 * them to UTC; anything unparseable becomes null rather than an epoch.
 */
function utcFromIso(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** PayPal money strings are decimal units ("5.00"), not minor units. */
function centsFromAmount(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function orderState(order: Record<string, unknown>): ObservedState {
  switch (order["status"]) {
    case "COMPLETED":
      return "SUCCEEDED";
    case "APPROVED":
    case "SAVED":
    case "CREATED":
    case "PAYER_ACTION_REQUIRED":
      return "PENDING";
    case "VOIDED":
      return "CANCELED";
    default:
      return "UNKNOWN";
  }
}

/** The capture inside an order is where settlement actually lives. */
function captureState(capture: Record<string, unknown>): ObservedState {
  switch (capture["status"]) {
    case "COMPLETED":
      return "SUCCEEDED";
    case "PENDING":
      return "PENDING";
    case "DECLINED":
    case "FAILED":
      return "FAILED";
    case "REFUNDED":
    case "PARTIALLY_REFUNDED":
      return "REFUNDED";
    default:
      return "UNKNOWN";
  }
}

function subscriptionState(sub: Record<string, unknown>): ObservedState {
  switch (sub["status"]) {
    case "ACTIVE":
      return "SUCCEEDED";
    case "APPROVAL_PENDING":
    case "APPROVED":
      return "PENDING";
    case "SUSPENDED":
      return "FAILED";
    case "CANCELLED":
    case "EXPIRED":
      return "CANCELED";
    default:
      return "UNKNOWN";
  }
}

function unknownPayment(
  providerRef: string,
  failure: PaymentObservation["failure"],
): PaymentObservation {
  return {
    kind: "PAYMENT",
    provider: PROVIDER,
    providerRef,
    state: "UNKNOWN",
    amountCents: null,
    currency: null,
    quantity: null,
    observedAtUtc: null,
    failure,
  };
}

export class PayPalBillingReconciliationProvider
  implements BillingReconciliationProvider
{
  readonly provider = PROVIDER;

  /**
   * Observe ONE stored ORDER binding.
   *
   * The stored reference for an evidence-credit purchase is the capture id
   * that the webhook would have used, so the order lookup is tried first and
   * the capture inside it supplies settlement. If the reference is a capture
   * id rather than an order id, the capture endpoint answers directly.
   */
  async observePayment(providerRef: string): Promise<PaymentObservation> {
    const capture = await this.tryCapture(providerRef);
    if (capture) return capture;

    let body: unknown;
    try {
      body = await paypalGet(
        `/v2/checkout/orders/${encodeURIComponent(providerRef)}`,
      );
    } catch {
      return unknownPayment(providerRef, "PROVIDER_UNAVAILABLE");
    }

    const order = asRecord(body);
    if (!order || order["id"] !== providerRef) {
      return unknownPayment(providerRef, order ? "PROVIDER_MALFORMED" : "NOT_FOUND");
    }

    const unit = Array.isArray(order["purchase_units"])
      ? asRecord(order["purchase_units"][0])
      : null;
    const amount = asRecord(unit?.["amount"]);

    return {
      kind: "PAYMENT",
      provider: PROVIDER,
      providerRef,
      state: orderState(order),
      amountCents: centsFromAmount(amount?.["value"]),
      currency:
        typeof amount?.["currency_code"] === "string"
          ? (amount["currency_code"] as string).toUpperCase()
          : null,
      // PayPal orders carry no line quantity for our single-unit products; the
      // service checks the canonical quantity itself.
      quantity: null,
      observedAtUtc: utcFromIso(order["update_time"] ?? order["create_time"]),
    };
  }

  /** A direct capture read. Returns null when the reference is not a capture. */
  private async tryCapture(
    providerRef: string,
  ): Promise<PaymentObservation | null> {
    let body: unknown;
    try {
      body = await paypalGet(
        `/v2/payments/captures/${encodeURIComponent(providerRef)}`,
      );
    } catch {
      // Not a capture id, or unreachable. The order path decides which.
      return null;
    }

    const capture = asRecord(body);
    if (!capture || capture["id"] !== providerRef) return null;
    const amount = asRecord(capture["amount"]);

    return {
      kind: "PAYMENT",
      provider: PROVIDER,
      providerRef,
      state: captureState(capture),
      amountCents: centsFromAmount(amount?.["value"]),
      currency:
        typeof amount?.["currency_code"] === "string"
          ? (amount["currency_code"] as string).toUpperCase()
          : null,
      quantity: null,
      observedAtUtc: utcFromIso(capture["update_time"] ?? capture["create_time"]),
    };
  }

  async observeSubscription(
    providerRef: string,
  ): Promise<SubscriptionObservation> {
    let body: unknown;
    try {
      body = await paypalGet(
        `/v1/billing/subscriptions/${encodeURIComponent(providerRef)}`,
      );
    } catch {
      return {
        kind: "SUBSCRIPTION",
        provider: PROVIDER,
        providerRef,
        state: "UNKNOWN",
        currentPeriodEndUtc: null,
        cancelAtPeriodEnd: false,
        observedAtUtc: null,
        recentPayments: [],
        failure: "PROVIDER_UNAVAILABLE",
      };
    }

    const sub = asRecord(body);
    if (!sub || sub["id"] !== providerRef) {
      return {
        kind: "SUBSCRIPTION",
        provider: PROVIDER,
        providerRef,
        state: "UNKNOWN",
        currentPeriodEndUtc: null,
        cancelAtPeriodEnd: false,
        observedAtUtc: null,
        recentPayments: [],
        failure: sub ? "PROVIDER_MALFORMED" : "NOT_FOUND",
      };
    }

    const billingInfo = asRecord(sub["billing_info"]);
    const nextBilling = utcFromIso(billingInfo?.["next_billing_time"]);

    return {
      kind: "SUBSCRIPTION",
      provider: PROVIDER,
      providerRef,
      state: subscriptionState(sub),
      currentPeriodEndUtc: nextBilling,
      // PayPal has no period-end cancellation. A cancelled PayPal subscription
      // is cancelled; saying otherwise is the defect the cancellation service
      // exists to prevent.
      cancelAtPeriodEnd: false,
      observedAtUtc: utcFromIso(sub["update_time"] ?? sub["create_time"]),
      recentPayments: await this.recentTransactions(providerRef),
    };
  }

  /** The bounded transaction window for ONE subscription. */
  private async recentTransactions(
    subscriptionRef: string,
  ): Promise<PaymentObservation[]> {
    const end = new Date();
    const start = new Date(
      end.getTime() - TRANSACTION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    let body: unknown;
    try {
      body = await paypalGet(
        `/v1/billing/subscriptions/${encodeURIComponent(subscriptionRef)}/transactions` +
          `?start_time=${start.toISOString()}&end_time=${end.toISOString()}`,
      );
    } catch {
      return [];
    }

    const transactions = asRecord(body)?.["transactions"];
    if (!Array.isArray(transactions)) return [];

    const out: PaymentObservation[] = [];
    for (const raw of transactions.slice(0, MAX_RECENT_TRANSACTIONS)) {
      const tx = asRecord(raw);
      const id = tx?.["id"];
      if (!tx || typeof id !== "string") continue;

      const gross = asRecord(tx["amount_with_breakdown"])?.["gross_amount"];
      const amount = asRecord(gross);

      out.push({
        kind: "PAYMENT",
        provider: PROVIDER,
        providerRef: id,
        state: captureState(tx),
        amountCents: centsFromAmount(amount?.["value"]),
        currency:
          typeof amount?.["currency_code"] === "string"
            ? (amount["currency_code"] as string).toUpperCase()
            : null,
        quantity: null,
        observedAtUtc: utcFromIso(tx["time"]),
      });
    }
    return out;
  }
}
