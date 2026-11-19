/**
 * PRO-BL1-02 (WS-BILL, 2026-11-18) — self-service payment management for the
 * payer of a PERSONAL subscription: fix a failed payment, change the card, and
 * read or download invoices and receipts.
 *
 * Nothing new is built: the provider's own hosted surface does it, through the
 * customer the live subscription is already billed to.
 *   STRIPE  a short-lived Customer Portal session for the subscription's own
 *           customer (payment methods, invoices, receipts, paying an open
 *           invoice). Its features are the portal configuration set in the
 *           Stripe dashboard (operator handoff).
 *   PAYPAL  the buyer's PayPal automatic-payments page, where PayPal lets them
 *           change the funding source; PayPal keeps the receipts.
 *
 * The caller has already authorised BILLING_MANAGE on the PERSONAL account.
 * Each request creates an independent short-lived session; nothing is stored.
 */

import * as prismaPkg from "@prisma/client";

import { DomainError } from "../../errors.js";
import { stripeGet, stripeRequest } from "../stripe.service.js";
import { findLivePersonalSubscription } from "./plan-transition.service.js";

export type PaymentManagementLink = { provider: "STRIPE" | "PAYPAL"; url: string };

function unavailable(detail: string): DomainError {
  return new DomainError(`Payment management unavailable: ${detail}`, {
    httpStatus: 503,
    publicCode: "PAYMENT_MANAGEMENT_UNAVAILABLE",
    publicMessage:
      "We could not open your payment provider's billing page just now. Nothing has changed. Please try again shortly, or contact support.",
    reportability: "OPERATIONAL_WARNING",
    severity: "warning",
  });
}

/** Only a Stripe-hosted https page is ever handed to the browser. */
function isStripeHostedUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "billing.stripe.com" || u.hostname.endsWith(".stripe.com"));
  } catch {
    return false;
  }
}

export function payPalAutopayUrl(env: NodeJS.ProcessEnv = process.env): string {
  const sandbox = String(env.PAYPAL_API_BASE ?? "").includes("sandbox") || env.PAYPAL_ENV === "sandbox";
  return sandbox ? "https://www.sandbox.paypal.com/myaccount/autopay/" : "https://www.paypal.com/myaccount/autopay/";
}

export async function createPaymentManagementLink(input: {
  userId: string;
  /** Where the provider sends the customer back (the Billing page). */
  returnUrl: string;
}): Promise<PaymentManagementLink> {
  const subscription = await findLivePersonalSubscription(input.userId);
  if (!subscription) {
    throw new DomainError("No live subscription", {
      httpStatus: 404,
      publicCode: "SUBSCRIPTION_NOT_FOUND",
      publicMessage: "There is no subscription whose payments can be managed here.",
      reportability: "EXPECTED_DENIAL",
      severity: "info",
    });
  }
  if (subscription.provider === prismaPkg.PaymentProvider.PAYPAL) {
    return { provider: "PAYPAL", url: payPalAutopayUrl() };
  }
  if (subscription.provider !== prismaPkg.PaymentProvider.STRIPE) throw unavailable("unsupported provider");

  let customer: string | null = null;
  try {
    const live = (await stripeGet(`/subscriptions/${encodeURIComponent(subscription.providerSubId)}`)) as {
      customer?: string | { id?: string } | null;
    };
    customer = typeof live.customer === "string" ? live.customer : live.customer?.id ?? null;
  } catch {
    throw unavailable("subscription read failed");
  }
  if (!customer) throw unavailable("subscription has no customer");

  let session: { url?: unknown };
  try {
    session = (await stripeRequest(
      "/billing_portal/sessions",
      new URLSearchParams({ customer, return_url: input.returnUrl }),
    )) as { url?: unknown };
  } catch {
    // Most often: no portal configuration in the Stripe dashboard yet.
    throw unavailable("portal session refused");
  }
  if (!isStripeHostedUrl(session.url)) throw unavailable("unexpected portal url");
  return { provider: "STRIPE", url: session.url };
}
