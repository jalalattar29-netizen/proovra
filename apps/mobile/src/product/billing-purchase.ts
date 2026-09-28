/** Private-distribution checkout only. Public store builds fail closed. */
export type PurchaseProvider = "stripe" | "paypal";
export type PurchaseIntent =
  | { kind: "PLAN"; plan: "PRO" | "TEAM"; transition: boolean }
  | { kind: "CREDITS" }
  /** `currency` is the SELECTED OFFER's own currency (storage SKUs are priced
   * in one currency each). Never the pricing catalogue's display currency. */
  | { kind: "STORAGE"; addonKey: string; currency?: string | null };

export function externalCheckoutEnabled(): boolean {
  return process.env.EXPO_PUBLIC_DISTRIBUTION === "PRIVATE" &&
    process.env.EXPO_PUBLIC_PRIVATE_BILLING === "enabled";
}

export function checkoutRequest(intent: PurchaseIntent, provider: PurchaseProvider, currency?: string | null): { path: string; body: Record<string, string> } {
  const body: Record<string, string> = {};
  if (currency === "EUR" || currency === "USD") body.currency = currency;
  if (intent.kind === "PLAN") {
    body.plan = intent.plan;
    return { path: intent.transition ? "/v1/billing/subscription/plan" : `/v1/billing/checkout/${provider}`, body };
  }
  if (intent.kind === "CREDITS") return { path: `/v1/billing/credits/checkout/${provider}`, body };
  // BILLING CHECKOUT ATTEMPTS (2026-09-28) — the same USD/EUR defect the web
  // drawer had: the catalogue's display currency (USD by default) was sent
  // for an EUR-only storage SKU. The server now refuses a mismatch with 409,
  // so send the offer's own currency, or none and let the server decide.
  delete body.currency;
  if (intent.currency === "EUR" || intent.currency === "USD") body.currency = intent.currency;
  body.addonKey = intent.addonKey;
  body.billingCycle = "MONTHLY";
  return { path: `/v1/billing/storage-addons/checkout/${provider}`, body };
}

/** Provider-approved HTTPS URLs only. A plan transition may return approvalUrl
 * without a provider discriminator; validate against BOTH provider allowlists. */
export function verifiedCheckoutUrl(candidate: unknown): string | null {
  if (typeof candidate !== "string") return null;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return null;
    const host = parsed.hostname.toLowerCase();
    const stripe = host === "checkout.stripe.com" || host.endsWith(".checkout.stripe.com");
    const paypal = ["paypal.com", "www.paypal.com", "sandbox.paypal.com", "www.sandbox.paypal.com"].includes(host);
    return stripe || paypal ? parsed.toString() : null;
  } catch { return null; }
}

/**
 * BILLING PAYPAL INTEGRITY (2026-09-28) — the server confirmation to run when
 * the in-app browser closes after a PayPal checkout.
 *
 * The web page confirms a PayPal return server-side (capture an approved
 * credit order; read and apply a plan or storage subscription). The private
 * mobile build only refreshed, so an approved credit order was never captured
 * unless a webhook happened to do it. The browser does not tell the app
 * whether the buyer approved; asking the server is safe either way — the
 * server reads PayPal, captures only an order the buyer APPROVED, and grants
 * only what PayPal confirms. Returns null for Stripe (its webhook settles it).
 */
export function payPalReturnConfirmation(
  payload: unknown,
  provider: PurchaseProvider,
): { kind: "ORDER_CAPTURE" | "SUBSCRIPTION_CONFIRM"; path: string } | null {
  if (provider !== "paypal") return null;
  const o = (v: unknown): Record<string, unknown> => v && typeof v === "object" ? v as Record<string, unknown> : {};
  const response = o(payload);
  const id = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9-]{6,64}$/.test(v) ? v : null);
  const subscriptionId = id(o(response.subscription).id);
  if (subscriptionId) {
    return { kind: "SUBSCRIPTION_CONFIRM", path: `/v1/billing/checkout/paypal/subscriptions/${encodeURIComponent(subscriptionId)}/confirm` };
  }
  const orderId = id(o(response.order).id);
  if (orderId) {
    return { kind: "ORDER_CAPTURE", path: `/v1/billing/credits/checkout/paypal/${encodeURIComponent(orderId)}/capture` };
  }
  return null;
}

/** What the server's PayPal confirmation means, in the customer's words. */
export function payPalReturnNotice(
  kind: "ORDER_CAPTURE" | "SUBSCRIPTION_CONFIRM",
  response: unknown,
  error?: { code?: unknown; statusCode?: unknown } | null,
): string {
  const r = response && typeof response === "object" ? (response as Record<string, unknown>) : {};
  if (error) {
    if (error.code === "PAYPAL_STORAGE_ACTIVATION_REFUSED") {
      return "PayPal activated this storage add-on, but it could not be added to this account, so PROOVRA cancelled it at PayPal. Support will review the charge.";
    }
    if (error.statusCode === 404 || error.statusCode === 409) {
      return "We could not confirm this PayPal payment for your account, so nothing was added. If you were charged, contact support.";
    }
    return "We could not confirm this with PayPal yet. PROOVRA keeps checking automatically; if you were charged, it is applied once PayPal confirms it.";
  }
  const outcome = typeof r.outcome === "string" ? r.outcome : "";
  if (kind === "ORDER_CAPTURE") {
    switch (outcome) {
      case "GRANTED":
      case "ALREADY_GRANTED":
        return "Payment received. Your evidence credit has been added.";
      case "PENDING":
        return r.reason === "AWAITING_APPROVAL"
          ? "PayPal has not confirmed this payment — nothing has been charged."
          : "PayPal is still processing this payment. PROOVRA keeps checking automatically; your credit is added when it settles.";
      case "FAILED":
        return "PayPal declined this payment, so no credit was added.";
      case "CANCELED":
        return "This PayPal payment was cancelled. Nothing was charged.";
      default:
        return "We could not confirm this PayPal payment yet. PROOVRA keeps checking automatically.";
    }
  }
  switch (outcome) {
    case "ACTIVE":
      return r.superseded === true
        ? "You already have an active plan, so this second PayPal subscription was cancelled at PayPal and support will review the charge."
        : "Your purchase is active. Thank you!";
    case "PENDING":
      return "You approved this at PayPal and PayPal is activating it. PROOVRA keeps checking automatically.";
    case "AWAITING_APPROVAL":
      return "PayPal has not confirmed your approval — nothing has been charged. An approval not completed within 24 hours is closed automatically.";
    case "PAYMENT_PROBLEM":
      return "PayPal reports a problem collecting this payment.";
    case "ENDED":
      return "This PayPal subscription is not active. Nothing further will be charged.";
    default:
      return "We could not confirm this with PayPal yet. PROOVRA keeps checking automatically.";
  }
}

/** Only URLs from the documented Stripe/PayPal checkout response shapes. */
export function checkoutApprovalUrl(payload: unknown, provider: PurchaseProvider): string | null {
  const o = (v: unknown): Record<string, unknown> => v && typeof v === "object" ? v as Record<string, unknown> : {};
  const response = o(payload);
  const providerObject = o(provider === "stripe" ? response.session : response.subscription ?? response.order);
  const links = Array.isArray(providerObject.links) ? providerObject.links : [];
  const candidate = provider === "stripe" ? providerObject.url :
    links.map(o).find(link => link.rel === "approve" || link.rel === "payer-action")?.href;
  if (typeof candidate !== "string") return null;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return null;
    const host = parsed.hostname.toLowerCase();
    const approved = provider === "stripe"
      ? (host === "checkout.stripe.com" || host.endsWith(".checkout.stripe.com"))
      : (host === "www.paypal.com" || host === "paypal.com" || host === "www.sandbox.paypal.com" || host === "sandbox.paypal.com");
    return approved ? parsed.toString() : null;
  } catch { return null; }
}

