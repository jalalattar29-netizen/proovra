import * as prismaPkg from "@prisma/client";
import { stripeRequest } from "./stripe.service.js";
import {
  createPayPalOrder,
  createPayPalSubscription,
  createPayPalStorageAddonCheckout as createPayPalStorageAddonCheckoutApi,
} from "./paypal.service.js";
import { isPayPalRecurringPlan } from "./paypal-plan-map.service.js";
import { getStorageAddonDefinition } from "./billing.service.js";

function normalizeCurrency(value?: string | null): "USD" | "EUR" {
  const currency = (value ?? "USD").trim().toUpperCase();
  if (currency === "EUR") return "EUR";
  return "USD";
}

function priceCentsFor(plan: prismaPkg.PlanType) {
  if (plan === prismaPkg.PlanType.PAYG) {
    return Number.parseInt(process.env.STRIPE_PAYG_PRICE_CENTS ?? "500", 10);
  }
  if (plan === prismaPkg.PlanType.PRO) {
    return Number.parseInt(process.env.STRIPE_PRO_PRICE_CENTS ?? "1900", 10);
  }
  if (plan === prismaPkg.PlanType.TEAM) {
    return Number.parseInt(process.env.STRIPE_TEAM_PRICE_CENTS ?? "7900", 10);
  }
  return 0;
}

function priceIdFor(plan: prismaPkg.PlanType): string | null {
  if (plan === prismaPkg.PlanType.PAYG) {
    return process.env.STRIPE_PAYG_PRICE_ID?.trim() || null;
  }
  if (plan === prismaPkg.PlanType.PRO) {
    return process.env.STRIPE_PRO_PRICE_ID?.trim() || null;
  }
  if (plan === prismaPkg.PlanType.TEAM) {
    return process.env.STRIPE_TEAM_PRICE_ID?.trim() || null;
  }
  return null;
}

function storageAddonStripePriceId(params: {
  addonKey: prismaPkg.StorageAddonKey;
  billingCycle: prismaPkg.StorageAddonBillingCycle;
}): string | null {
  const suffix =
    params.billingCycle === prismaPkg.StorageAddonBillingCycle.ONE_TIME
      ? "ONE_TIME"
      : "MONTHLY";

  return (
    process.env[`STRIPE_STORAGE_${params.addonKey}_${suffix}_PRICE_ID`]?.trim() ||
    null
  );
}

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

export async function createPayPalStorageAddonCheckout(params: {
  userId: string;
  addonKey: prismaPkg.StorageAddonKey;
  billingCycle: prismaPkg.StorageAddonBillingCycle;
  currency: string;
  amount: string;
  teamId?: string | null;
  workspacePlan: prismaPkg.PlanType;
}) {
  return createPayPalStorageAddonCheckoutApi({
    userId: params.userId,
    addonKey: params.addonKey,
    billingCycle: params.billingCycle,
    currency: params.currency,
    amount: params.amount,
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
  const currency = normalizeCurrency(params.currency);
  const amountCents = priceCentsFor(params.plan);
  const mode = params.plan === prismaPkg.PlanType.PAYG ? "payment" : "subscription";
  const appBase = normalizedBaseUrl();

  const searchParams = new URLSearchParams();
  searchParams.append("mode", mode);
  searchParams.append("success_url", `${appBase}/billing?success=1`);
  searchParams.append("cancel_url", `${appBase}/billing?canceled=1`);
  searchParams.append("metadata[userId]", params.userId);
  searchParams.append("metadata[plan]", params.plan);
  searchParams.append("payment_method_types[]", "card");

  if (params.teamId) {
    searchParams.append("metadata[teamId]", params.teamId);
  }

  const priceId = priceIdFor(params.plan);

  if (priceId) {
    searchParams.append("line_items[0][price]", priceId);
    searchParams.append("line_items[0][quantity]", "1");
  } else {
    searchParams.append("line_items[0][price_data][currency]", currency);
    searchParams.append(
      "line_items[0][price_data][product_data][name]",
      `Proovra ${params.plan}`
    );
    searchParams.append("line_items[0][price_data][unit_amount]", amountCents.toString());
    searchParams.append("line_items[0][quantity]", "1");

    if (mode === "subscription") {
      searchParams.append("line_items[0][price_data][recurring][interval]", "month");
    }
  }

  if (mode === "subscription") {
    searchParams.append("subscription_data[metadata][userId]", params.userId);
    searchParams.append("subscription_data[metadata][plan]", params.plan);

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
  const definition = getStorageAddonDefinition(params.addonKey);
  const currency = normalizeCurrency(params.currency ?? definition.currency);
  const amountCents = definition.priceCents;
  const mode =
    params.billingCycle === prismaPkg.StorageAddonBillingCycle.ONE_TIME
      ? "payment"
      : "subscription";
  const appBase = normalizedBaseUrl();

  const searchParams = new URLSearchParams();
  searchParams.append("mode", mode);
  searchParams.append(
    "success_url",
    `${appBase}/billing?success=1&kind=storage-addon`
  );
  searchParams.append(
    "cancel_url",
    `${appBase}/billing?canceled=1&kind=storage-addon`
  );
  searchParams.append("payment_method_types[]", "card");
  searchParams.append("metadata[userId]", params.userId);
  searchParams.append("metadata[storageAddonKey]", params.addonKey);
  searchParams.append("metadata[billingCycle]", params.billingCycle);
  searchParams.append("metadata[workspacePlan]", params.workspacePlan);

  if (params.teamId) {
    searchParams.append("metadata[teamId]", params.teamId);
  }

  const priceId = storageAddonStripePriceId({
    addonKey: params.addonKey,
    billingCycle: params.billingCycle,
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
    searchParams.append("line_items[0][price_data][unit_amount]", String(amountCents));
    searchParams.append("line_items[0][quantity]", "1");

    if (mode === "subscription") {
      searchParams.append("line_items[0][price_data][recurring][interval]", "month");
    }
  }

  if (mode === "subscription") {
    searchParams.append("subscription_data[metadata][userId]", params.userId);
    searchParams.append(
      "subscription_data[metadata][storageAddonKey]",
      params.addonKey
    );
    searchParams.append(
      "subscription_data[metadata][billingCycle]",
      params.billingCycle
    );
    searchParams.append(
      "subscription_data[metadata][workspacePlan]",
      params.workspacePlan
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

export async function createPayPalCheckout(params: {
  userId: string;
  plan: prismaPkg.PlanType;
  currency?: string | null;
  teamId?: string | null;
}) {
  const currency = normalizeCurrency(params.currency);
  const amountCents = priceCentsFor(params.plan);
  const amount = (amountCents / 100).toFixed(2);
  const appBase = normalizedBaseUrl();

  const successUrl = `${appBase}/billing?success=1&provider=paypal`;
  const cancelUrl = `${appBase}/billing?canceled=1&provider=paypal`;

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

