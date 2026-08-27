/**
 * BILLING RECONCILIATION (2026-08-27) — the Stripe observation adapter.
 *
 * Reads Stripe through the existing configured client (`stripeGet`) and
 * returns the shared internal observation. It writes nothing, decides nothing
 * commercial, and never returns a Stripe object — the caller receives a
 * normalized shape or `UNKNOWN`.
 *
 * BOUNDED BY CONSTRUCTION
 * ---------------------------------------------------------------------------
 * Every request names ONE object the repository already stored a binding for.
 * There is no listing of customers, no scan, no cursor over the account. The
 * invoice read is the single exception and is explicitly capped: it asks for
 * the most recent invoices OF ONE SUBSCRIPTION, which is the smallest query
 * that can repair missing renewal history.
 *
 * WHY EVERY FAILURE IS `UNKNOWN`
 * ---------------------------------------------------------------------------
 * A reconciliation that guesses is worse than one that gives up: the whole
 * point is to grant money-backed entitlements that a lost webhook did not.
 * A network error, a 500, a malformed body and an unmodelled status all
 * produce UNKNOWN, and UNKNOWN grants nothing, cancels nothing and moves
 * nothing. Success is only ever read from an explicit Stripe success value.
 */

import * as prismaPkg from "@prisma/client";

import { stripeGet } from "../../stripe.service.js";
import type {
  BillingReconciliationProvider,
  ObservedState,
  PaymentObservation,
  SubscriptionObservation,
} from "./types.js";

/** How many recent invoices one subscription observation may carry. */
const MAX_RECENT_INVOICES = 12;

const PROVIDER = prismaPkg.PaymentProvider.STRIPE;

function utcFromUnix(value: unknown): Date | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  // Stripe timestamps are seconds since the epoch, always UTC.
  const d = new Date(value * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * A Checkout Session's settlement state.
 *
 * `payment_status` is the field that says whether MONEY MOVED. `status`
 * (open/complete/expired) says whether the customer finished the flow, which
 * is a different question — a session can be `complete` with
 * `payment_status: "unpaid"` on a delayed method.
 */
function sessionState(session: Record<string, unknown>): ObservedState {
  const paymentStatus = session["payment_status"];
  const status = session["status"];

  if (paymentStatus === "paid" || paymentStatus === "no_payment_required") {
    return "SUCCEEDED";
  }
  if (status === "expired") return "CANCELED";
  if (paymentStatus === "unpaid") {
    return status === "open" ? "PENDING" : "FAILED";
  }
  return "UNKNOWN";
}

function subscriptionState(sub: Record<string, unknown>): ObservedState {
  switch (sub["status"]) {
    case "active":
    case "trialing":
      return "SUCCEEDED";
    case "past_due":
    case "unpaid":
    case "incomplete":
      return "FAILED";
    case "incomplete_expired":
    case "canceled":
      return "CANCELED";
    default:
      return "UNKNOWN";
  }
}

function invoiceState(invoice: Record<string, unknown>): ObservedState {
  switch (invoice["status"]) {
    case "paid":
      return "SUCCEEDED";
    case "open":
    case "draft":
      return "PENDING";
    case "uncollectible":
      return "FAILED";
    case "void":
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

/**
 * Total quantity across a session's line items.
 *
 * Present so the service can CHECK it against the canonical quantity. A
 * provider-reported quantity is never accepted as the amount to grant.
 */
function sessionQuantity(session: Record<string, unknown>): number | null {
  const lineItems = asRecord(session["line_items"]);
  const data = lineItems?.["data"];
  if (!Array.isArray(data)) return null;
  let total = 0;
  for (const raw of data) {
    const item = asRecord(raw);
    const q = item?.["quantity"];
    if (typeof q === "number" && Number.isFinite(q)) total += q;
  }
  return total > 0 ? total : null;
}

export class StripeBillingReconciliationProvider
  implements BillingReconciliationProvider
{
  readonly provider = PROVIDER;

  /**
   * Observe ONE stored Checkout Session binding.
   *
   * `expand[]=line_items` is requested because the quantity check needs it and
   * a second round trip to fetch line items would double the failure surface
   * for no benefit.
   */
  async observePayment(providerRef: string): Promise<PaymentObservation> {
    let body: unknown;
    try {
      body = await stripeGet(
        `/checkout/sessions/${encodeURIComponent(providerRef)}?expand[]=line_items`,
      );
    } catch {
      return unknownPayment(providerRef, "PROVIDER_UNAVAILABLE");
    }

    const session = asRecord(body);
    if (!session) return unknownPayment(providerRef, "PROVIDER_MALFORMED");
    if (session["id"] !== providerRef) {
      // The provider answered about something else. Refuse rather than accept
      // a transaction we did not ask about.
      return unknownPayment(providerRef, "PROVIDER_MALFORMED");
    }

    const amount = session["amount_total"];
    const currency = session["currency"];

    return {
      kind: "PAYMENT",
      provider: PROVIDER,
      providerRef,
      state: sessionState(session),
      amountCents: typeof amount === "number" ? amount : null,
      currency: typeof currency === "string" ? currency.toUpperCase() : null,
      quantity: sessionQuantity(session),
      observedAtUtc: utcFromUnix(session["created"]),
    };
  }

  async observeSubscription(
    providerRef: string,
  ): Promise<SubscriptionObservation> {
    let body: unknown;
    try {
      body = await stripeGet(`/subscriptions/${encodeURIComponent(providerRef)}`);
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

    return {
      kind: "SUBSCRIPTION",
      provider: PROVIDER,
      providerRef,
      state: subscriptionState(sub),
      currentPeriodEndUtc: utcFromUnix(sub["current_period_end"]),
      cancelAtPeriodEnd: sub["cancel_at_period_end"] === true,
      // `status_transitions.updated_at` would be ideal but Stripe does not
      // publish it on subscriptions; `created` is the only monotonic provider
      // stamp available here, so a subscription observation carries the
      // period end as its ordering signal instead (see the service).
      observedAtUtc: utcFromUnix(sub["current_period_end"]) ?? utcFromUnix(sub["created"]),
      recentPayments: await this.recentInvoices(providerRef),
    };
  }

  /**
   * The bounded invoice window for ONE subscription.
   *
   * A failure here is not fatal to the subscription observation: knowing the
   * subscription is active is still worth having, and missing history simply
   * stays missing until the next run. It returns an empty list rather than
   * throwing, and never a partial guess.
   */
  private async recentInvoices(
    subscriptionRef: string,
  ): Promise<PaymentObservation[]> {
    let body: unknown;
    try {
      body = await stripeGet(
        `/invoices?subscription=${encodeURIComponent(subscriptionRef)}&limit=${MAX_RECENT_INVOICES}`,
      );
    } catch {
      return [];
    }

    const data = asRecord(body)?.["data"];
    if (!Array.isArray(data)) return [];

    const out: PaymentObservation[] = [];
    for (const raw of data.slice(0, MAX_RECENT_INVOICES)) {
      const invoice = asRecord(raw);
      const id = invoice?.["id"];
      if (!invoice || typeof id !== "string") continue;

      const amount = invoice["amount_paid"] ?? invoice["amount_due"];
      const currency = invoice["currency"];
      out.push({
        kind: "PAYMENT",
        provider: PROVIDER,
        providerRef: id,
        state: invoiceState(invoice),
        amountCents: typeof amount === "number" ? amount : null,
        currency: typeof currency === "string" ? currency.toUpperCase() : null,
        quantity: null,
        // `status_transitions.paid_at` is when the money actually moved, which
        // is the ordering fact. `created` is the fallback for an invoice that
        // never reached paid.
        observedAtUtc:
          utcFromUnix(asRecord(invoice["status_transitions"])?.["paid_at"]) ??
          utcFromUnix(invoice["created"]),
      });
    }
    return out;
  }
}
