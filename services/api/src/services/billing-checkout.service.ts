import * as prismaPkg from "@prisma/client";
import { stripeRequest } from "./stripe.service.js";
import {
  createPayPalOrder,
  createPayPalSubscription,
  createPayPalStorageAddonCheckout as createPayPalStorageAddonCheckoutApi,
} from "./paypal.service.js";
import { isPayPalRecurringPlan } from "./paypal-plan-map.service.js";
import { getStorageAddonDefinition } from "./billing.service.js";
import {
  getPlanPriceCents,
  getStorageAddonCurrency,
  getStorageAddonPriceCents,
  getStripePlanPriceId,
  getStripeStorageAddonPriceId,
  resolveCheckoutCurrency,
} from "./billing-pricing.service.js";
// PHASE 11 — canonical internal URL builder. Used ONLY to compose the
// checkout success/cancel return URLs; the Stripe/PayPal session-creation
// logic itself is untouched.
import { absoluteInternalUrl, internalNavPath } from "@proovra/shared";

function appBaseUrl(): string {
  return (
    process.env.APP_BASE_URL?.trim() ||
    process.env.WEB_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_WEB_BASE?.trim() ||
    "https://app.proovra.com"
  );
}

function normalizedBaseUrl(): string {
  return appBaseUrl().replace(/\/+$/, "");
}

/**
 * PHASE 11 — the checkout success/cancel return URL always targets the
 * fixed in-app /billing nav path (never a caller-supplied destination);
 * composed via the canonical absolute-internal-URL builder for consistency
 * with every other post-auth/checkout redirect in the app.
 */
function billingReturnUrl(appBase: string, query: string): string {
  return `${absoluteInternalUrl(appBase, internalNavPath("/billing"))}?${query}`;
}

export async function createPayPalStorageAddonCheckout(params: {
  userId: string;
  addonKey: prismaPkg.StorageAddonKey;
  billingCycle: prismaPkg.StorageAddonBillingCycle;
  currency?: string | null;
  teamId?: string | null;
  workspacePlan: prismaPkg.PlanType;
}) {
  if (params.billingCycle !== prismaPkg.StorageAddonBillingCycle.MONTHLY) {
    throw new Error(
      "Storage add-ons are sold as recurring monthly subscriptions",
    );
  }

  const currency = getStorageAddonCurrency({
    requestedCurrency: params.currency,
  });

  const amountCents = getStorageAddonPriceCents({
    addonKey: params.addonKey,
    currency,
  });

  const amount = (amountCents / 100).toFixed(2);

  return createPayPalStorageAddonCheckoutApi({
    userId: params.userId,
    addonKey: params.addonKey,
    billingCycle: prismaPkg.StorageAddonBillingCycle.MONTHLY,
    currency,
    amount,
    teamId: params.teamId ?? null,
    workspacePlan: params.workspacePlan,
  });
}

export async function createStripeCheckoutSession(params: {
  userId: string;
  plan: prismaPkg.PlanType;
  currency?: string | null;
  teamId?: string | null;
}) {
  const currency = resolveCheckoutCurrency({
    requestedCurrency: params.currency,
  });
  const amountCents = getPlanPriceCents(params.plan, currency);
  const mode =
    params.plan === prismaPkg.PlanType.PAYG ? "payment" : "subscription";
  const appBase = normalizedBaseUrl();

  const searchParams = new URLSearchParams();
  searchParams.append("mode", mode);
  searchParams.append("success_url", billingReturnUrl(appBase, "success=1"));
  searchParams.append("cancel_url", billingReturnUrl(appBase, "canceled=1"));
  searchParams.append("metadata[userId]", params.userId);
  searchParams.append("metadata[plan]", params.plan);
  searchParams.append("metadata[currency]", currency);
  searchParams.append("metadata[amountCents]", String(amountCents));
  searchParams.append("payment_method_types[]", "card");

  if (params.teamId) {
    searchParams.append("metadata[teamId]", params.teamId);
  }

  const priceId = getStripePlanPriceId(params.plan, currency);

  if (priceId) {
    searchParams.append("line_items[0][price]", priceId);
    searchParams.append("line_items[0][quantity]", "1");
  } else {
    searchParams.append("line_items[0][price_data][currency]", currency);
    searchParams.append(
      "line_items[0][price_data][product_data][name]",
      `Proovra ${params.plan}`
    );
    searchParams.append(
      "line_items[0][price_data][unit_amount]",
      amountCents.toString()
    );
    searchParams.append("line_items[0][quantity]", "1");

    if (mode === "subscription") {
      searchParams.append(
        "line_items[0][price_data][recurring][interval]",
        "month"
      );
    }
  }

  if (mode === "subscription") {
    searchParams.append("subscription_data[metadata][userId]", params.userId);
    searchParams.append("subscription_data[metadata][plan]", params.plan);
    searchParams.append("subscription_data[metadata][currency]", currency);
    searchParams.append(
      "subscription_data[metadata][amountCents]",
      String(amountCents)
    );

    if (params.teamId) {
      searchParams.append("subscription_data[metadata][teamId]", params.teamId);
    }
  }

  const session = await stripeRequest("/checkout/sessions", searchParams);

  return {
    mode,
    currency,
    amountCents,
    session,
  };
}

export async function createStripeStorageAddonCheckoutSession(params: {
  userId: string;
  addonKey: prismaPkg.StorageAddonKey;
  billingCycle: prismaPkg.StorageAddonBillingCycle;
  currency?: string | null;
  teamId?: string | null;
  workspacePlan: prismaPkg.PlanType;
}) {
  /**
   * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — a storage add-on is a
   * RECURRING MONTHLY subscription.
   *
   * The one-time SKU it replaces granted capacity that nothing ever expired:
   * every row was written with `expiresAtUtc: null` and
   * `WorkspaceStorageAddonStatus.EXPIRED` had no writer at all, so €2.99 bought
   * 10 GB for ever, surviving cancellation of the base plan. Existing one-time
   * rows are grandfathered and keep their capacity; no NEW one can be created.
   */
  if (params.billingCycle !== prismaPkg.StorageAddonBillingCycle.MONTHLY) {
    throw new Error(
      "Storage add-ons are sold as recurring monthly subscriptions",
    );
  }

  const definition = getStorageAddonDefinition(params.addonKey);
  const currency = getStorageAddonCurrency({
    requestedCurrency: params.currency ?? definition.currency,
  });

  const amountCents = getStorageAddonPriceCents({
    addonKey: params.addonKey,
    currency,
  });

  const mode = "subscription";
  const appBase = normalizedBaseUrl();

  const searchParams = new URLSearchParams();
  searchParams.append("mode", mode);
  searchParams.append(
    "success_url",
    billingReturnUrl(appBase, "success=1&kind=storage-addon")
  );
  searchParams.append(
    "cancel_url",
    billingReturnUrl(appBase, "canceled=1&kind=storage-addon")
  );
  searchParams.append("payment_method_types[]", "card");
  searchParams.append("metadata[userId]", params.userId);
  searchParams.append("metadata[storageAddonKey]", params.addonKey);
  searchParams.append(
    "metadata[billingCycle]",
    prismaPkg.StorageAddonBillingCycle.MONTHLY
  );
  // The SAME metadata on the SUBSCRIPTION, so every renewal invoice can be
  // bound back to this add-on without depending on invoice-level metadata
  // that Stripe does not populate.
  searchParams.append("subscription_data[metadata][userId]", params.userId);
  searchParams.append(
    "subscription_data[metadata][storageAddonKey]",
    params.addonKey
  );
  searchParams.append(
    "subscription_data[metadata][billingCycle]",
    prismaPkg.StorageAddonBillingCycle.MONTHLY
  );
  if (params.teamId) {
    searchParams.append("subscription_data[metadata][teamId]", params.teamId);
  }
  searchParams.append("metadata[workspacePlan]", params.workspacePlan);
  searchParams.append("metadata[currency]", currency);
  searchParams.append("metadata[amountCents]", String(amountCents));

  if (params.teamId) {
    searchParams.append("metadata[teamId]", params.teamId);
  }

  const priceId = getStripeStorageAddonPriceId({
    addonKey: params.addonKey,
    billingCycle: prismaPkg.StorageAddonBillingCycle.MONTHLY,
    currency,
  });

  if (priceId) {
    searchParams.append("line_items[0][price]", priceId);
    searchParams.append("line_items[0][quantity]", "1");
  } else {
    searchParams.append("line_items[0][price_data][currency]", currency);
    searchParams.append(
      "line_items[0][price_data][product_data][name]",
      `Proovra Storage Add-on ${params.addonKey}`
    );
    searchParams.append(
      "line_items[0][price_data][unit_amount]",
      String(amountCents)
    );
    // Without this the inline price is a ONE-TIME charge and Stripe rejects it
    // in subscription mode — which is precisely the mismatch that would let a
    // "monthly" add-on bill once and never again.
    searchParams.append(
      "line_items[0][price_data][recurring][interval]",
      "month"
    );
    searchParams.append("line_items[0][quantity]", "1");
  }

  const session = await stripeRequest("/checkout/sessions", searchParams);

  return {
    mode,
    currency,
    amountCents,
    session,
  };
}

export async function createPayPalCheckout(params: {
  userId: string;
  plan: prismaPkg.PlanType;
  currency?: string | null;
  teamId?: string | null;
}) {
  const currency = resolveCheckoutCurrency({
    requestedCurrency: params.currency,
  });
  const amountCents = getPlanPriceCents(params.plan, currency);
  const amount = (amountCents / 100).toFixed(2);
  const appBase = normalizedBaseUrl();

  const successUrl = billingReturnUrl(appBase, "success=1&provider=paypal");
  const cancelUrl = billingReturnUrl(appBase, "canceled=1&provider=paypal");

  if (params.plan === prismaPkg.PlanType.PAYG) {
    const order = await createPayPalOrder({
      userId: params.userId,
      plan: params.plan,
      currency,
      amount,
      teamId: null,
      returnUrl: successUrl,
      cancelUrl,
    });

    return {
      mode: "order" as const,
      currency,
      amountCents,
      amount,
      order,
    };
  }

  if (!isPayPalRecurringPlan(params.plan)) {
    throw new Error(`Unsupported PayPal checkout plan: ${params.plan}`);
  }

  const subscription = await createPayPalSubscription({
    userId: params.userId,
    plan: params.plan,
    currency,
    teamId: params.teamId ?? null,
    returnUrl: successUrl,
    cancelUrl,
  });

  return {
    mode: "subscription" as const,
    currency,
    amountCents,
    amount,
    subscription,
  };
}