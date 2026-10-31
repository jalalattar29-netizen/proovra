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

import { SYNTHETIC_ERROR_MESSAGE } from "@proovra/shared/user-facing-errors";

import type {
  ActiveStorageAddon,
  BillingAccountProjection,
  CheckoutAttemptAbandonResult,
  CheckoutAttemptResult,
  PlanOffer,
  ReconciliationResult,
  ResumeResult,
  StorageAddonOffer,
} from "../../../../lib/api/billing-accounts";
import {
  hasExplanationFor,
  toSafeUserError,
} from "../../../../lib/feedback/toSafeUserError";
import { formatMoney } from "./format";

export type BillingNotice = { message: string; tone: "success" | "info" | "error" };

/** A refusal or failure: its heading, its sentence and the support reference. */
export type BillingErrorNotice = BillingNotice & {
  title: string;
  supportReference?: string;
};

/**
 * BILLING REMEDIATION (2026-10-30, AUD-17) — the sentence for each billing code.
 *
 * Every one of these is a state of the account, not a mistake in what the
 * customer typed, and they all reached the status bucket's "Please review your
 * input". The codes live here rather than in the shared table because two of
 * them need Billing's own words: the shared SUBSCRIPTION_ALREADY_ACTIVE says
 * "already on this plan" to a PRO customer buying TEAM, and the shared
 * PAYPAL_STORAGE_APPROVAL_PENDING says "waiting for your approval" about a
 * purchase that may already be approved.
 *
 * The two OUTCOME_UNKNOWN codes must never read "nothing changed": a timeout can
 * follow a change the provider accepted.
 */
const REFUSAL_COPY: Record<string, Omit<BillingErrorNotice, "supportReference">> = {
  PAYPAL_APPROVAL_PENDING: {
    title: "A PayPal checkout is already open",
    message: "A PayPal checkout for this plan is already open. Finish it at PayPal, or re-check it here before starting another.",
    tone: "info",
  },
  PAYPAL_DIFFERENT_PLAN_PENDING: {
    title: "A PayPal checkout is already open",
    message: "A PayPal checkout for a different plan is already open. Re-check it here before choosing another plan.",
    tone: "info",
  },
  PLAN_CHECKOUT_ALREADY_OPEN: {
    title: "A plan checkout is already open",
    message: "A checkout for a plan is already open. Finish it, or resolve it under Billing activity before starting another.",
    tone: "info",
  },
  CHECKOUT_IN_PROGRESS: {
    title: "This checkout is already starting",
    message: "This checkout is already starting. Wait a moment, then look at Billing activity before trying again.",
    tone: "info",
  },
  PLAN_ALREADY_ACTIVE: {
    title: "Your plan is already active",
    message: "We found your active subscription and updated this account. Nothing was started, and you have not been charged for a new plan.",
    tone: "info",
  },
  SUBSCRIPTION_ALREADY_ACTIVE: {
    title: "You already have a subscription",
    message: "You already have a subscription on this account. Use Manage plan to change it instead of buying a second one.",
    tone: "info",
  },
  CHECKOUT_CUSTOMER_UNRESOLVED: {
    title: "The payment service did not answer",
    message: "No checkout was opened and nothing was charged. Try again in a moment.",
    tone: "error",
  },
  PLAN_CHANGE_ENDS_STORAGE: {
    title: "This plan does not include some of your storage",
    message: "Your Team-size storage stays until its paid date and then stops renewing. Review the change, then confirm it again.",
    tone: "info",
  },
  PLAN_CHANGE_STORAGE_MUST_END_FIRST: {
    title: "End your storage add-on first",
    message: "This plan does not include your Team storage, and we cannot stop that add-on from here. Nothing was changed. Contact support to end the add-on, then change your plan.",
    tone: "error",
  },
  STORAGE_ADDON_ALREADY_HELD: {
    title: "You already pay for this size",
    message: "You already pay for this storage size. Buying it again adds another recurring charge and more storage.",
    tone: "info",
  },
  STORAGE_PURCHASE_PENDING: {
    title: "A storage purchase is already open",
    message: "This storage size already has a purchase open with your other payment method. Check that purchase before starting another, so you are not billed twice.",
    tone: "info",
  },
  PAYPAL_STORAGE_APPROVAL_PENDING: {
    title: "A storage purchase is already open",
    message: "A PayPal storage purchase is already open on this account. Check its status under Billing activity before starting another.",
    tone: "info",
  },
  STORAGE_ADDON_PREREQUISITE_ENDING: {
    title: "Your plan is set to end",
    message: "Your plan is set to end, so this storage add-on cannot be added. Restart your plan first, then add storage.",
    tone: "info",
  },
  STORAGE_ADDON_NOT_INCLUDED: {
    title: "Extra storage is not available",
    message: "Extra storage is not available for this account.",
    tone: "info",
  },
  STORAGE_ADDON_NOT_OFFERED: {
    title: "This size is not on your plan",
    message: "This storage size is not available on your current plan. Choose from the sizes shown here.",
    tone: "info",
  },
  CHECKOUT_TARGET_NOT_SUPPORTED: {
    title: "This purchase is for your personal account",
    message: "Subscriptions and storage add-ons are bought for your Personal Workspace, not for another workspace.",
    tone: "info",
  },
  PLAN_CHANGE_OUTCOME_UNKNOWN: {
    title: "We could not confirm this plan change",
    message: "We did not get an answer from your payment provider, so we cannot say yet whether this plan change went through. Check Billing in a few minutes before trying again.",
    tone: "error",
  },
  PROVIDER_CANCELLATION_OUTCOME_UNKNOWN: {
    title: "We could not confirm this cancellation",
    message: "We did not get an answer from your payment provider, so we cannot say yet whether this subscription was cancelled. Check Billing in a few minutes before trying again.",
    tone: "error",
  },
  PLAN_CHANGE_PROVIDER_FAILED: {
    title: "Your payment provider refused this change",
    message: "Your payment provider refused this plan change, so your plan stayed as it was. Please try again, or contact support if this continues.",
    tone: "error",
  },
  PROVIDER_CANCELLATION_FAILED: {
    title: "Your payment provider refused this cancellation",
    message: "Your payment provider refused this cancellation, so your subscription stayed as it was. Please try again shortly, or contact support if this continues.",
    tone: "error",
  },
  PROVIDER_RESTART_FAILED: {
    title: "We could not restart this subscription",
    message: "We could not reach the payment provider to restart this subscription. It still shows as set to end. Check Billing before trying again.",
    tone: "error",
  },
  SUBSCRIPTION_ALREADY_ENDED: {
    title: "This subscription has ended",
    message: "This subscription has already ended. Start a new subscription instead.",
    tone: "info",
  },
  RATE_LIMIT_EXCEEDED: {
    title: "Too many attempts",
    message: "That was tried several times just now. Please wait a few minutes, then check Billing before trying again.",
    tone: "info",
  },
};

/**
 * Codes the server words differently by case, each a fixed sentence of its own
 * with no provider text in it. PLAN_CHANGE_NOT_AVAILABLE alone has "contact
 * support" and "try again shortly" answers, so one line here would be wrong for
 * one of them. The same bounded exception `toSafeUserError` makes for its list.
 */
const SERVER_WORDED: Record<string, { title: string; message: string }> = {
  PLAN_CHANGE_NOT_AVAILABLE: {
    title: "This plan change is not available",
    message: "This plan change is not available right now. Please contact support.",
  },
  PROVIDER_CANNOT_RESTART: {
    title: "This subscription cannot be restarted",
    message: "Your payment provider cannot restart this subscription. You can start a new one after it ends.",
  },
};
const SERVER_WORDED_MAX = 240;

/** A 409 with no code of its own is still the account's state, not bad input. */
const UNMAPPED_CONFLICT: Omit<BillingErrorNotice, "supportReference"> = {
  title: "That could not be done right now",
  message: "Something on this account is already in progress. Check Billing activity, then try again. If this continues, contact support.",
  tone: "info",
};

function readError(err: unknown): { code: string; status: number | undefined; message: string } {
  const e = (err && typeof err === "object" ? err : {}) as {
    code?: unknown;
    statusCode?: unknown;
    status?: unknown;
    message?: unknown;
  };
  const status = typeof e.statusCode === "number" ? e.statusCode : e.status;
  return {
    code: typeof e.code === "string" ? e.code.trim().toUpperCase() : "",
    status: typeof status === "number" ? status : undefined,
    message: typeof e.message === "string" ? e.message.trim() : "",
  };
}

/**
 * A billing failure, for a customer.
 *
 * `unknownOutcome` marks an action that may have reached the provider before the
 * answer was lost (a cancellation, a plan change). `fallback` is then said for a
 * transport failure too, in place of a sentence promising nothing happened.
 */
export function describeBillingError(
  err: unknown,
  fallback: { message: string; unknownOutcome?: boolean },
): BillingErrorNotice {
  const { code, status, message } = readError(err);
  const safe = toSafeUserError(err, { message: fallback.message });
  const reference = safe.supportReference ? { supportReference: safe.supportReference } : {};

  const known = REFUSAL_COPY[code];
  if (known) return { ...known, ...reference };

  const worded = SERVER_WORDED[code];
  if (worded) {
    const usable = message.length > 0 && !SYNTHETIC_ERROR_MESSAGE.test(message);
    return {
      title: worded.title,
      message: usable ? message.slice(0, SERVER_WORDED_MAX) : worded.message,
      tone: "info",
      ...reference,
    };
  }

  const transport = status === undefined || status === 0 || status >= 500;
  if (fallback.unknownOutcome && transport && (code === "NETWORK_ERROR" || !hasExplanationFor(err))) {
    return { title: "We could not confirm the result", message: fallback.message, tone: "error", ...reference };
  }
  if (status === 409 && !hasExplanationFor(err)) return { ...UNMAPPED_CONFLICT, ...reference };

  return {
    title: safe.title,
    message: safe.message,
    tone: safe.severity === "error" ? "error" : "info",
    ...reference,
  };
}

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
    // BILLING PAYPAL INTEGRITY (2026-09-28) — a refused request checked
    // NOTHING, and says so. "Billing was checked" (and, before it, "your
    // provider is still settling a payment") was shown for a request that
    // never reached a provider.
    if (result.outcome === "BUSY") {
      return { message: "A check is already running for this account. Nothing new was checked — wait a moment, then look again.", tone: "info" };
    }
    if (result.outcome === "RATE_LIMITED") {
      return { message: "Billing was re-checked several times just now. Nothing new was checked — please try again in a few minutes.", tone: "info" };
    }
    return result.outcome === "PROVIDER_UNAVAILABLE"
      ? { message: "We could not reach your payment provider. Nothing was changed.", tone: "error" }
      : { message: "The check did not run. Nothing was changed — please try again.", tone: "info" };
  }

  const attempts = (s.attempts ?? []).filter((a) => !a.locallyAbandoned);
  const stillPending = attempts.filter((a) => a.outcome === "STILL_PENDING");
  // "Waiting for your approval at PayPal" only for what IS waiting for the
  // buyer at PayPal; an approved activation, a payment still processing and
  // an open Stripe page are each said as themselves.
  const awaiting = stillPending.filter(
    (a) => a.provider === "PAYPAL" && (a.waitingFor ?? "APPROVAL") === "APPROVAL",
  ).length;
  const activating = stillPending.filter((a) => a.waitingFor === "ACTIVATION").length;
  const processing = stillPending.filter((a) => a.waitingFor === "PAYMENT_PROCESSING").length;
  const stripePage = stillPending.filter((a) => a.waitingFor === "PAYMENT_PAGE").length;
  const unverified = attempts.filter((a) => UNVERIFIED.has(a.outcome)).length;
  const unreachable = s.unavailable;
  // PROOVRA's own close of an unapproved attempt counts as an update on the
  // server, but it is not something a provider confirmed.
  const closedLocally = attempts.filter((a) => a.outcome === "UPDATED" && attemptStateOf(a) === "CLOSED_LOCALLY").length;
  const changed =
    s.creditsRestored +
    s.paymentsRecorded +
    s.subscriptionsUpdated +
    Math.max(0, (s.attemptsUpdated ?? 0) - closedLocally);
  const otherAction = Math.max(0, s.actionRequired - unverified);

  const parts: string[] = [];
  // Not "Nothing was charged": an attempt check can capture an order the buyer
  // already approved, which is the point of asking.
  parts.push(`Checked ${plural(s.checked, "item", "items")} with your payment provider.`);
  if (changed > 0) {
    parts.push(`${plural(changed, "record was", "records were")} updated from what the provider confirmed.`);
  }
  if (s.creditsRestored > 0) {
    parts.push(`${plural(s.creditsRestored, "evidence credit was", "evidence credits were")} added.`);
  }
  if (closedLocally > 0) {
    parts.push(
      `${plural(closedLocally, "purchase was", "purchases were")} not approved within 24 hours, so PROOVRA closed ${closedLocally === 1 ? "it" : "them"} here. PayPal did not confirm this.`,
    );
  }
  if (awaiting > 0) {
    parts.push(`${plural(awaiting, "purchase is", "purchases are")} still waiting for your approval at PayPal.`);
  }
  if (activating > 0) {
    parts.push(`${plural(activating, "purchase was", "purchases were")} approved and PayPal is activating it; PROOVRA keeps checking.`);
  }
  if (processing > 0) {
    parts.push(`${plural(processing, "payment is", "payments are")} still processing with the provider; PROOVRA keeps checking.`);
  }
  if (stripePage > 0) {
    parts.push(`${plural(stripePage, "card payment page is", "card payment pages are")} still open and unpaid.`);
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
    unreachable > 0 && changed === 0 && closedLocally === 0 && awaiting + activating + processing + stripePage === 0 && unverified === 0
      ? "error"
      : changed > 0 && closedLocally + awaiting + activating + processing + stripePage + unverified + unreachable + s.discrepancies === 0
        ? "success"
        : "info";
  return { message: parts.join(" "), tone };
}

/**
 * WHERE one attempt stands, from what the check returned.
 *
 * BILLING REMEDIATION (2026-10-30, AUD-18) — one vocabulary for the Billing
 * activity row and the storage recovery panel. Keeping `waitingFor` is the point:
 * an approved attempt that reads "waiting for your approval" sends the customer
 * to an Abandon the server then refuses.
 */
export type AttemptState =
  | "WAITING_APPROVAL"
  | "ACTIVATING"
  | "PROCESSING"
  | "PAYMENT_PAGE"
  | "PAID"
  | "FAILED"
  | "CLOSED"
  /** PROOVRA closed it. The provider did not, and may still complete it. */
  | "CLOSED_LOCALLY"
  | "UNRESOLVED";

export function attemptStateOf(
  result: Pick<CheckoutAttemptResult, "outcome" | "currentStatus" | "waitingFor">,
): AttemptState {
  if (result.outcome === "STILL_PENDING") {
    switch (result.waitingFor) {
      case "ACTIVATION":
        return "ACTIVATING";
      case "PAYMENT_PROCESSING":
        return "PROCESSING";
      case "PAYMENT_PAGE":
        return "PAYMENT_PAGE";
      default:
        return "WAITING_APPROVAL";
    }
  }
  if (result.outcome === "UPDATED" || result.outcome === "NO_CHANGE" || result.outcome === "STALE_IGNORED") {
    switch (String(result.currentStatus ?? "").toUpperCase()) {
      case "ACTIVE":
      case "COMPLETED":
      case "SUCCEEDED":
        return "PAID";
      case "FAILED":
        return "FAILED";
      case "CANCELED":
      case "CANCELLED":
      case "EXPIRED":
        return "CLOSED";
      case "ABANDONED":
        return "CLOSED_LOCALLY";
    }
  }
  return "UNRESOLVED";
}

/** A settled answer's sentence, or null when the check settled nothing. */
function settledWords(state: AttemptState, provider: string): BillingNotice | null {
  switch (state) {
    case "PAID":
      return { message: `${provider} confirmed this purchase. Billing is updated.`, tone: "success" };
    case "FAILED":
      return { message: `${provider} reports this purchase failed, so nothing was added to your account.`, tone: "error" };
    case "CLOSED":
      return { message: `${provider} reports this purchase was cancelled or expired, so nothing was added to your account.`, tone: "info" };
    case "CLOSED_LOCALLY":
      return {
        message: `This was not approved within 24 hours, so PROOVRA closed it here. ${provider} did not confirm this and nothing was cancelled there. If ${provider} later confirms a payment, PROOVRA still applies it.`,
        tone: "info",
      };
    default:
      return null;
  }
}

/** ONE attempt's "Check status" result. */
export function describeAttemptRecheck(result: CheckoutAttemptResult): BillingNotice {
  if (result.provider === "STRIPE") return describeStripeAttemptRecheck(result);
  switch (result.outcome) {
    case "UPDATED":
      return (
        settledWords(attemptStateOf(result), "PayPal") ?? {
          message: "The provider confirmed a new status for this purchase. Billing is updated.",
          tone: "success",
        }
      );
    case "STILL_PENDING":
      return {
        message:
          result.waitingFor === "ACTIVATION"
            ? "You approved this at PayPal and PayPal is activating it. PROOVRA keeps checking automatically; nothing more is needed from you."
            : result.waitingFor === "PAYMENT_PROCESSING"
              ? "PayPal is still processing this payment. PROOVRA keeps checking automatically; nothing more is needed from you."
              : result.resumeUrl
                ? "PayPal still shows this waiting for your approval. You can continue at PayPal, or abandon it."
                : "PayPal still shows this waiting for your approval. Nothing is charged unless you approve it; you can abandon it. Approvals not completed within 24 hours are closed automatically.",
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
      return (
        settledWords(attemptStateOf(result), "Stripe") ?? {
          message: "Stripe confirmed a new status for this purchase. Billing is updated.",
          tone: "success",
        }
      );
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

/** What the storage recovery panel does with a check's answer. */
export type StorageAttemptCheck = BillingNotice & {
  state: AttemptState;
  /** Still open, so another purchase of this size would risk a second charge. */
  blocked: boolean;
  /** Abandon is refused once the buyer has approved, so it is not offered. */
  canAbandon: boolean;
};

export function describeStorageAttemptCheck(result: CheckoutAttemptResult): StorageAttemptCheck {
  const state = attemptStateOf(result);
  const settled = state === "PAID" || state === "FAILED" || state === "CLOSED" || state === "CLOSED_LOCALLY";
  // A purchase already finished says so whichever outcome carried the news.
  const words =
    settledWords(state, result.provider === "STRIPE" ? "Stripe" : "PayPal") ?? describeAttemptRecheck(result);
  return {
    ...words,
    state,
    blocked: !settled,
    canAbandon: !settled && state !== "ACTIVATING" && state !== "PROCESSING",
  };
}

/**
 * What abandoning ONE attempt did.
 *
 * Never "nothing was charged" for a local abandon: PROOVRA did not ask the
 * provider to stop anything, so it cannot speak for the provider.
 */
export function describeAttemptAbandon(result: CheckoutAttemptAbandonResult): BillingNotice {
  switch (result.outcome) {
    case "PROVIDER_CANCEL_FAILED":
      return {
        message: result.warning ?? "The payment provider could not confirm this was closed, so it is still shown as open.",
        tone: "error",
      };
    case "ABANDONED":
      return {
        message: result.cancelsAtProvider
          ? "Closed at the payment provider. Nothing was charged."
          : "Removed from your open purchases in PROOVRA. This did not cancel anything at the payment provider. If the provider later confirms a payment, PROOVRA still applies it.",
        tone: "success",
      };
    case "ABANDON_NOT_ALLOWED":
      return { message: result.warning ?? "This purchase is being processed and cannot be abandoned.", tone: "info" };
    case "PROVIDER_STATE_RECORDED":
      return { message: "The provider had already settled this purchase, so its answer was recorded instead.", tone: "info" };
    default:
      return { message: "This purchase had already been resolved; nothing was changed.", tone: "info" };
  }
}

/** The plain sentence for a size one provider cannot sell, or null. */
export function offerAvailabilityNote(offer: StorageAddonOffer): string | null {
  const { stripe = true, paypal = true } = offer.checkoutAvailability ?? {};
  if (stripe && paypal) return null;
  if (!stripe && !paypal) return "This size cannot be bought right now. Please choose another size or try again later.";
  return stripe
    ? "PayPal is not available for this size right now. You can pay by card."
    : "Card payment is not available for this size right now. You can pay with PayPal.";
}

/** "of $9.00 per month", when the viewer may see the amount. */
function recurringAmount(offer: Pick<StorageAddonOffer, "priceCents" | "currency">): string {
  const price = formatMoney(offer.priceCents, offer.currency);
  return price ? ` of ${price} per month` : "";
}

/**
 * The warning beside a size the account already holds or is already buying.
 *
 * Stacking stays allowed, so this informs and refuses nothing. It only speaks
 * about what the server's rows say: a purchase that has not completed is neither
 * capacity nor, yet, a charge.
 */
export function storageStackWarning(
  held: { activeCount: number; pendingCount: number },
  offer: Pick<StorageAddonOffer, "priceCents" | "currency">,
): string | null {
  const parts: string[] = [];
  if (held.activeCount > 0) {
    const one = held.activeCount === 1;
    parts.push(
      `You already pay for ${one ? "this size" : `${held.activeCount} of this size`}. Buying it again keeps ${one ? "that charge" : "those charges"} and adds another recurring charge${recurringAmount(offer)}.`,
    );
  }
  if (held.pendingCount > 0) {
    const one = held.pendingCount === 1;
    parts.push(
      `${one ? "A purchase" : `${held.pendingCount} purchases`} of this size ${one ? "has" : "have"} not completed yet. See Billing activity before buying again, so you are not billed twice.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/** The deliberate second question, after the server said this size is held. */
export function storageAdditionalPrompt(
  activeCount: number,
  offer: Pick<StorageAddonOffer, "priceCents" | "currency"> | null,
): string {
  return `You already have ${activeCount} of this size. Adding another starts a separate recurring charge${
    offer ? recurringAmount(offer) : ""
  } on top of what you pay now, and adds more storage.`;
}

/**
 * Add-ons that depend on a paid plan.
 *
 * `endsWithPlan` is the server's flag for a SKU only a paid plan offers, which on
 * today's catalogue is the Team-size rows.
 */
function paidPlanAddons(projection: BillingAccountProjection): ActiveStorageAddon[] {
  return (projection.storageAddons?.active ?? []).filter(
    (addon) =>
      addon.endsWithPlan === true &&
      !addon.legacyOneTime &&
      ["ACTIVE", "PAST_DUE"].includes(addon.status.toUpperCase()),
  );
}

/**
 * What a move from TEAM down to PRO leaves behind.
 *
 * Team-size add-ons survive that move and keep billing. It is current behaviour
 * pending a product decision, so it is stated before the customer commits rather
 * than discovered on the next statement. A cancellation is different: it stops
 * these add-ons, and its own dialog says so.
 */
export function downgradeAddonNote(
  projection: BillingAccountProjection,
  offer: Pick<PlanOffer, "action" | "displayName">,
): string | null {
  if (offer.action !== "DOWNGRADE") return null;
  const addons = paidPlanAddons(projection);
  if (addons.length === 0) return null;
  const sizes = addons.map((addon) => addon.storageLabel).join(", ");
  const one = addons.length === 1;
  return `${offer.displayName} does not include your Team-size storage add-on${one ? "" : "s"} (${sizes}). If you continue, ${one ? "it stays until its" : "they stay until their"} paid date and then ${one ? "stops" : "stop"} renewing. Nothing replaces ${one ? "it" : "them"} and your evidence is kept, but you cannot add more while you are over your storage limit.`;
}

/**
 * The answer to Restart subscription.
 *
 * The API sends how many add-ons still end, not which. Their sizes are named
 * only when that count accounts for every add-on that can end with the plan.
 */
export function describeResume(result: ResumeResult, projection: BillingAccountProjection): BillingNotice {
  if (result.result !== "RESUMED") {
    return { message: "This subscription was not set to end; nothing changed.", tone: "info" };
  }
  const ending = result.dependentAddonsStillEnding;
  if (ending <= 0) return { message: "Subscription restarted. It will renew as normal.", tone: "success" };
  const candidates = paidPlanAddons(projection);
  const keys = result.dependentAddonKeysStillEnding ?? [];
  const labels = keys.length === ending
    ? keys.map((key) => candidates.find((addon) => addon.addonKey === key)?.storageLabel ?? null)
    : [];
  // An API from before the release sends the count alone.
  const fallback = keys.length === 0 && candidates.length === ending ? candidates.map((addon) => addon.storageLabel) : [];
  const shown = labels.length > 0 && labels.every(Boolean) ? labels : fallback;
  const named = shown.length > 0 ? ` (${shown.join(", ")})` : "";
  return {
    message: `Subscription restarted. ${plural(ending, "storage add-on", "storage add-ons")}${named} set to end will still end. Add storage again if you want to keep that capacity.`,
    tone: "info",
  };
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
