/**
 * PAYPAL RETURN — what the Billing page does when PayPal sends the buyer back.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * PayPal returns the buyer to `/billing?success=1&provider=paypal&kind=…` with
 * its own parameters appended: `token=<orderId>` for an evidence-credit ORDER,
 * `subscription_id=I-…` for a plan or storage add-on SUBSCRIPTION. Nothing read
 * them. An evidence-credit order is created with `intent: CAPTURE`, so an
 * approved order that nobody captures moves no money and grants nothing — the
 * buyer came back to a page that silently showed the same zero balance.
 *
 * WHAT THE BROWSER DECIDES
 * ---------------------------------------------------------------------------
 * Only WHICH server confirmation to ask for. The query string grants nothing:
 * the server reads the order / subscription from PayPal, checks it belongs to
 * the signed-in account, captures (orders only) and applies the result. A
 * forged `success=1` produces a 404 from the server, never a credit.
 *
 * Pure: no React, no fetch.
 */

type ParamReader = { get(name: string): string | null };

export type PayPalReturnProduct = "credits" | "plan" | "storage-addon";

export type PayPalReturn =
  | { kind: "ORDER_CAPTURE"; orderId: string }
  | {
      kind: "SUBSCRIPTION_CONFIRM";
      subscriptionId: string;
      product: Exclude<PayPalReturnProduct, "credits">;
    }
  | {
      kind: "BUYER_CANCELED";
      product: PayPalReturnProduct;
      /** The PayPal resource PayPal names on the cancel return, when it does. */
      subscriptionId: string | null;
      orderId: string | null;
    };

/** Every query parameter the PayPal round trip adds; removed after handling. */
export const PAYPAL_RETURN_PARAMS = [
  "success",
  "canceled",
  "checkout",
  "provider",
  "kind",
  "token",
  "PayerID",
  "subscription_id",
  "ba_token",
] as const;

const PAYPAL_ID = /^[A-Za-z0-9-]{6,64}$/;

function product(params: ParamReader): PayPalReturnProduct {
  const kind = params.get("kind");
  if (kind === "credits" || kind === "storage-addon") return kind;
  return "plan";
}

export function parsePayPalReturn(params: ParamReader): PayPalReturn | null {
  if (params.get("provider") !== "paypal") return null;

  const prod = product(params);

  if (params.get("canceled") === "1") {
    const subscriptionId = params.get("subscription_id");
    const token = params.get("token");
    return {
      kind: "BUYER_CANCELED",
      product: prod,
      subscriptionId: subscriptionId && PAYPAL_ID.test(subscriptionId) ? subscriptionId : null,
      orderId: prod === "credits" && token && PAYPAL_ID.test(token) ? token : null,
    };
  }
  if (params.get("success") !== "1") return null;

  const subscriptionId = params.get("subscription_id");
  if (subscriptionId && PAYPAL_ID.test(subscriptionId)) {
    return {
      kind: "SUBSCRIPTION_CONFIRM",
      subscriptionId,
      product: prod === "credits" ? "plan" : prod,
    };
  }

  // Orders carry the order id as `token`. A subscription return ALSO carries
  // a `token`, so this is only read when there is no subscription id.
  const token = params.get("token");
  if (prod === "credits" && token && PAYPAL_ID.test(token)) {
    return { kind: "ORDER_CAPTURE", orderId: token };
  }

  return null;
}

/** Server-side capture of an approved evidence-credit order. */
export function payPalOrderCapturePath(orderId: string): string {
  return `/v1/billing/credits/checkout/paypal/${encodeURIComponent(orderId)}/capture`;
}

/** Server-side confirmation of an approved plan / storage add-on subscription. */
export function payPalSubscriptionConfirmPath(subscriptionId: string): string {
  return `/v1/billing/checkout/paypal/subscriptions/${encodeURIComponent(subscriptionId)}/confirm`;
}

/** The server confirmation for a return, or null when there is nothing to ask. */
export function payPalReturnRequestPath(ret: PayPalReturn): string | null {
  switch (ret.kind) {
    case "ORDER_CAPTURE":
      return payPalOrderCapturePath(ret.orderId);
    case "SUBSCRIPTION_CONFIRM":
      return payPalSubscriptionConfirmPath(ret.subscriptionId);
    case "BUYER_CANCELED":
      return null;
  }
}

export type PayPalReturnMessage = {
  tone: "success" | "info" | "error";
  message: string;
  /** PayPal has not finished yet — ask again shortly. */
  retry: boolean;
};

const PRODUCT_NOUN: Record<PayPalReturnProduct, string> = {
  credits: "evidence credit",
  plan: "plan",
  "storage-addon": "storage add-on",
};

export function payPalCanceledMessage(prod: PayPalReturnProduct): PayPalReturnMessage {
  return {
    tone: "info",
    message: `PayPal checkout was cancelled. Nothing was charged and your ${PRODUCT_NOUN[prod]} was not changed.`,
    retry: false,
  };
}

/** The server's settlement outcome, in the customer's words. */
export function payPalReturnMessage(ret: PayPalReturn, response: unknown): PayPalReturnMessage {
  if (ret.kind === "BUYER_CANCELED") return payPalCanceledMessage(ret.product);
  const r = response && typeof response === "object" ? (response as Record<string, unknown>) : {};
  const outcome = typeof r.outcome === "string" ? r.outcome : "";

  if (ret.kind === "ORDER_CAPTURE") {
    if (r.statusCode === 404 || r.statusCode === 409) {
      // The server refused: not this account's order, or not a credit order,
      // or not at this purchase's price. Nothing was captured or added.
      return { tone: "error", message: "We could not confirm this PayPal payment for your account, so no credit was added. If you were charged, contact support.", retry: false };
    }
    switch (outcome) {
      case "GRANTED":
      case "ALREADY_GRANTED":
        return { tone: "success", message: "Payment received. Your evidence credit has been added.", retry: false };
      case "PENDING":
        return r.reason === "AWAITING_APPROVAL"
          ? { tone: "info", message: "PayPal has not confirmed this payment yet. Nothing has been charged.", retry: false }
          : { tone: "info", message: "PayPal is still processing this payment. Your credit will appear as soon as it settles.", retry: true };
      case "CANCELED":
        return { tone: "info", message: "This PayPal payment was cancelled. Nothing was charged.", retry: false };
      case "FAILED":
        return { tone: "error", message: "PayPal declined this payment, so no credit was added. You can try again with another payment method.", retry: false };
      default:
        // BILLING PAYPAL INTEGRITY (2026-09-28) — true now: an approved
        // payment whose confirmation failed stays "processing" and the hourly
        // billing sweep settles it (one capture, one credit).
        return { tone: "info", message: "We could not confirm this PayPal payment yet. PROOVRA keeps checking with PayPal automatically; if you were charged, your credit is added once PayPal confirms it.", retry: false };
    }
  }

  const noun = PRODUCT_NOUN[ret.product];
  if (r.code === "PAYPAL_STORAGE_ACTIVATION_REFUSED") {
    return {
      tone: "error",
      message: "PayPal activated this storage add-on, but it could not be added to this account, so PROOVRA cancelled it at PayPal. Support will review the charge — you do not need to do anything.",
      retry: false,
    };
  }
  switch (outcome) {
    case "ACTIVE":
      return r.superseded === true
        ? {
            tone: "info",
            message: "You already have an active plan, so this second PayPal subscription was cancelled at PayPal and support will review the charge. Your current plan is unchanged.",
            retry: false,
          }
        : { tone: "success", message: `Your ${noun} is active. Thank you!`, retry: false };
    // BILLING PAYPAL INTEGRITY (2026-09-28) — "approved, activating" and "not
    // approved yet" are different facts, and the page no longer promises to
    // update itself after it has stopped asking.
    case "PENDING":
      return { tone: "info", message: `You approved this at PayPal and PayPal is activating your ${noun}. PROOVRA keeps checking automatically — refresh Billing in a few minutes to see it.`, retry: true };
    case "AWAITING_APPROVAL":
      return { tone: "info", message: `PayPal has not confirmed your approval of this ${noun} yet. Nothing has been charged.`, retry: true };
    case "PAYMENT_PROBLEM":
      return { tone: "error", message: `PayPal reports a problem collecting payment for this ${noun}.`, retry: false };
    case "ENDED":
      return { tone: "info", message: `This PayPal ${noun} subscription is not active. Nothing further will be charged.`, retry: false };
    default:
      return { tone: "error", message: `We could not confirm this PayPal ${noun} yet. It will update automatically once PayPal confirms it.`, retry: false };
  }
}

/** The current query string with every PayPal round-trip parameter removed. */
export function stripPayPalReturnParams(search: string): string {
  const next = new URLSearchParams(search);
  for (const key of PAYPAL_RETURN_PARAMS) next.delete(key);
  const qs = next.toString();
  return qs ? `?${qs}` : "";
}
