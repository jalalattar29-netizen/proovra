/** Private-distribution checkout only. Public store builds fail closed. */
export type PurchaseProvider = "stripe" | "paypal";
export type PurchaseIntent =
  | { kind: "PLAN"; plan: "PRO" | "TEAM"; transition: boolean }
  | { kind: "CREDITS" }
  | { kind: "STORAGE"; addonKey: string };

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

