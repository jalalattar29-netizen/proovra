/**
 * BILLING ACTIVITY (2026-09-28) — what the customer is told after a re-check.
 *
 * Pure, so every sentence is tested against the result shapes the server
 * returns. The rule these functions exist for: say "pending" ONLY when the
 * provider itself reported the purchase as awaiting approval or processing. A
 * 401, a 404, a malformed reference, an attempt PayPal never confirmed, or an
 * outage is each said as exactly that — never "your provider is still
 * settling a payment".
 */

import type {
  CheckoutAttemptResult,
  ReconciliationResult,
} from "../../../../lib/api/billing-accounts";

export type BillingNotice = { message: string; tone: "success" | "info" | "error" };

const UNVERIFIED = new Set<CheckoutAttemptResult["outcome"]>([
  "NOT_PROVIDER_BOUND",
  "PROVIDER_REFERENCE_NOT_FOUND",
  "PROVIDER_REFERENCE_INVALID",
  "PROVIDER_AUTHORIZATION_FAILED",
  "PROVIDER_MALFORMED",
]);

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The account-wide "Re-check purchases and billing" result. */
export function describeReconciliation(result: ReconciliationResult): BillingNotice {
  const s = result.summary;
  if (!s) {
    return result.outcome === "PROVIDER_UNAVAILABLE"
      ? { message: "We could not reach your payment provider. Nothing was changed.", tone: "error" }
      : { message: "Billing was checked. Nothing was changed.", tone: "info" };
  }

  const attempts = (s.attempts ?? []).filter((a) => !a.locallyAbandoned);
  const awaiting = attempts.filter((a) => a.outcome === "STILL_PENDING").length;
  const unverified = attempts.filter((a) => UNVERIFIED.has(a.outcome)).length;
  const unreachable = s.unavailable;
  const changed =
    s.creditsRestored + s.paymentsRecorded + s.subscriptionsUpdated + (s.attemptsUpdated ?? 0);
  const otherAction = Math.max(0, s.actionRequired - unverified);

  const parts: string[] = [];
  parts.push(`Checked ${plural(s.checked, "item", "items")} with your payment provider. Nothing was charged.`);
  if (changed > 0) {
    parts.push(`${plural(changed, "record was", "records were")} updated from what the provider confirmed.`);
  }
  if (s.creditsRestored > 0) {
    parts.push(`${plural(s.creditsRestored, "evidence credit was", "evidence credits were")} added.`);
  }
  if (awaiting > 0) {
    parts.push(`${plural(awaiting, "purchase is", "purchases are")} still waiting for your approval at PayPal.`);
  }
  if (unverified > 0) {
    parts.push(
      `${plural(unverified, "purchase", "purchases")} could not be confirmed by the provider — see Billing activity for what that means and what you can do.`,
    );
  }
  if (unreachable > 0) {
    parts.push(`The provider could not be reached for ${plural(unreachable, "item", "items")}; those were left unchanged.`);
  }
  if (s.discrepancies > 0) {
    parts.push("Something the provider reported did not match our prices, so nothing was applied for it. Please contact support.");
  }
  if (otherAction > 0) {
    parts.push("Some storage cancellations are still outstanding; we keep retrying them.");
  }
  if (parts.length === 1) {
    parts.push("Everything on this account already matches your payment provider.");
  }

  const tone: BillingNotice["tone"] =
    unreachable > 0 && changed === 0 && awaiting === 0 && unverified === 0
      ? "error"
      : changed > 0 && awaiting + unverified + unreachable + s.discrepancies === 0
        ? "success"
        : "info";
  return { message: parts.join(" "), tone };
}

/** ONE attempt's "Check status" result. */
export function describeAttemptRecheck(result: CheckoutAttemptResult): BillingNotice {
  if (result.provider === "STRIPE") return describeStripeAttemptRecheck(result);
  switch (result.outcome) {
    case "UPDATED":
      return { message: "The provider confirmed a new status for this purchase. Billing is updated.", tone: "success" };
    case "STILL_PENDING":
      return {
        message: result.resumeUrl
          ? "PayPal still shows this waiting for your approval. You can continue at PayPal, or abandon it."
          : "PayPal still shows this as in progress. Nothing more is needed from you right now.",
        tone: "info",
      };
    case "NO_CHANGE":
    case "STALE_IGNORED":
      return { message: "The provider confirmed nothing has changed for this purchase.", tone: "info" };
    case "NOT_PROVIDER_BOUND":
      return {
        message: "PayPal never confirmed this checkout was created, so there is nothing to approve. Nothing can be charged without your approval. You can abandon it.",
        tone: "info",
      };
    case "PROVIDER_REFERENCE_NOT_FOUND":
      return {
        message: "PayPal has no record of this checkout any more. It was not approved through PROOVRA. You can abandon it.",
        tone: "info",
      };
    case "PROVIDER_UNAVAILABLE":
      return {
        message: "PayPal could not be reached, so this purchase's status is unknown. Nothing was changed — try again later.",
        tone: "error",
      };
    default:
      return {
        message: "PayPal could not confirm this checkout. Nothing was changed. If this continues, contact support.",
        tone: "error",
      };
  }
}

/** The same answers for a card (Stripe) checkout — never worded as PayPal. */
function describeStripeAttemptRecheck(result: CheckoutAttemptResult): BillingNotice {
  switch (result.outcome) {
    case "UPDATED":
      return { message: "Stripe confirmed a new status for this purchase. Billing is updated.", tone: "success" };
    case "STILL_PENDING":
      return {
        message: result.resumeUrl
          ? "The Stripe payment page is still open and unpaid. You can continue checkout, or abandon it."
          : "Stripe shows this payment as still settling. Nothing more is needed from you right now.",
        tone: "info",
      };
    case "NO_CHANGE":
    case "STALE_IGNORED":
      return { message: "Stripe confirmed nothing has changed for this purchase.", tone: "info" };
    case "NOT_PROVIDER_BOUND":
      return {
        message: "Stripe never confirmed this checkout was created, so there is nothing to pay. You can abandon it.",
        tone: "info",
      };
    case "PROVIDER_REFERENCE_NOT_FOUND":
      return { message: "Stripe has no record of this checkout any more. You can abandon it.", tone: "info" };
    case "PROVIDER_UNAVAILABLE":
      return {
        message: "Stripe could not be reached, so this purchase's status is unknown. Nothing was changed — try again later.",
        tone: "error",
      };
    default:
      return {
        message: "Stripe could not confirm this checkout. Nothing was changed. If this continues, contact support.",
        tone: "error",
      };
  }
}

const STRIPE_CHECKOUT_HOSTS = ["checkout.stripe.com"];

/**
 * A checkout resume link is followed only when it is the provider's own HTTPS
 * payment page: PayPal's approval page, or Stripe's hosted checkout.
 */
export function safeCheckoutResumeUrl(href: string | null | undefined): string | null {
  if (!href) return null;
  if (safePayPalResumeUrl(href)) return href;
  try {
    const url = new URL(href);
    return url.protocol === "https:" && STRIPE_CHECKOUT_HOSTS.includes(url.hostname.toLowerCase()) ? href : null;
  } catch {
    return null;
  }
}

const PAYPAL_HOSTS = ["paypal.com", "www.paypal.com", "sandbox.paypal.com", "www.sandbox.paypal.com"];

/** A resume link is followed only when it is PayPal's own HTTPS page. */
export function safePayPalResumeUrl(href: string | null | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === "https:" && PAYPAL_HOSTS.includes(url.hostname.toLowerCase()) ? href : null;
  } catch {
    return null;
  }
}
