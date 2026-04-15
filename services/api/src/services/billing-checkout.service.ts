import * as prismaPkg from "@prisma/client";
import { stripeRequest } from "./stripe.service.js";
import { createPayPalOrder, createPayPalSubscription } from "./paypal.service.js";
import { isPayPalRecurringPlan } from "./paypal-plan-map.service.js";

function normalizeCurrency(value?: string | null): "USD" | "EUR" | "GBP" {
  const currency = (value ?? "USD").trim().toUpperCase();
  if (currency === "EUR" || currency === "GBP") return currency;
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

function appBaseUrl(): string {
  return (
    process.env.APP_BASE_URL?.trim() ||
    process.env.WEB_BASE_URL?.trim() ||
    "https://app.proovra.com"
  );
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
  const appBase = appBaseUrl();

  const searchParams = new URLSearchParams();
  searchParams.append("mode", mode);
  searchParams.append("success_url", `${appBase.replace(/\/+$/, "")}/billing?success=1`);
  searchParams.append("cancel_url", `${appBase.replace(/\/+$/, "")}/billing?canceled=1`);
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

export async function createPayPalCheckout(params: {
  userId: string;
  plan: prismaPkg.PlanType;
  currency?: string | null;
  teamId?: string | null;
}) {
  const currency = normalizeCurrency(params.currency);
  const amountCents = priceCentsFor(params.plan);
  const amount = (amountCents / 100).toFixed(2);
  const appBase = appBaseUrl();

  const successUrl = `${appBase.replace(/\/+$/, "")}/billing?success=1&provider=paypal`;
  const cancelUrl = `${appBase.replace(/\/+$/, "")}/billing?canceled=1&provider=paypal`;

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