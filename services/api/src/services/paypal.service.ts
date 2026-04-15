// D:\digital-witness\services\api\src\services\paypal.service.ts
import * as prismaPkg from "@prisma/client";
import {
  normalizePayPalCurrency,
  resolvePayPalPlanId,
  type PayPalRecurringPlan,
} from "./paypal-plan-map.service.js";
import { buildPayPalCustomId } from "./paypal-checkout-policy.service.js";

type PayPalToken = {
  access_token: string;
};

function must(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`${name} is not set`);
  }
  return value.trim();
}

function apiBase() {
  return process.env.PAYPAL_API_BASE?.trim() || "https://api-m.paypal.com";
}

export async function getPayPalAccessToken(): Promise<string> {
  const clientId = must("PAYPAL_CLIENT_ID");
  const secret = must("PAYPAL_SECRET");
  const creds = Buffer.from(`${clientId}:${secret}`).toString("base64");

  const res = await fetch(`${apiBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal token error: ${text}`);
  }

  const data = (await res.json()) as PayPalToken;
  return data.access_token;
}

export async function paypalRequest(
  path: string,
  body: Record<string, unknown>,
  method: "POST" | "GET" = "POST"
) {
  const token = await getPayPalAccessToken();

  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal error: ${text}`);
  }

  return (await res.json()) as Record<string, unknown>;
}

export async function paypalGet(path: string) {
  const token = await getPayPalAccessToken();

  const res = await fetch(`${apiBase()}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal GET error: ${text}`);
  }

  return (await res.json()) as Record<string, unknown>;
}

export async function getPayPalSubscription(subscriptionId: string) {
  return paypalGet(`/v1/billing/subscriptions/${subscriptionId}`);
}

export async function createPayPalOrder(params: {
  userId: string;
  plan: prismaPkg.PlanType | "PAYG";
  currency: string;
  amount: string;
  teamId?: string | null;
  returnUrl: string;
  cancelUrl: string;
}) {
  const normalizedCurrency = normalizePayPalCurrency(params.currency);
  const plan = String(params.plan).trim().toUpperCase();
  const description =
    plan === prismaPkg.PlanType.TEAM && params.teamId
      ? `PROOVRA ${plan} ${params.teamId}`
      : `PROOVRA ${plan}`;

  return paypalRequest("/v2/checkout/orders", {
    intent: "CAPTURE",
    purchase_units: [
      {
        custom_id: buildPayPalCustomId({
          userId: params.userId,
          plan: params.plan as prismaPkg.PlanType,
          teamId: params.teamId ?? null,
        }),
        description,
        amount: {
          currency_code: normalizedCurrency,
          value: params.amount,
        },
      },
    ],
    application_context: {
      brand_name: "PROOVRA",
      shipping_preference: "NO_SHIPPING",
      user_action: "PAY_NOW",
      return_url: params.returnUrl,
      cancel_url: params.cancelUrl,
    },
  });
}

export async function createPayPalSubscription(params: {
  userId: string;
  plan: PayPalRecurringPlan;
  currency: string;
  teamId?: string | null;
  returnUrl: string;
  cancelUrl: string;
}) {
  const planId = resolvePayPalPlanId({
    plan: params.plan,
    currency: params.currency,
  });

  return paypalRequest("/v1/billing/subscriptions", {
    plan_id: planId,
    custom_id: buildPayPalCustomId({
      userId: params.userId,
      teamId: params.teamId ?? null,
      plan: params.plan,
    }),
    application_context: {
      brand_name: "PROOVRA",
      user_action: "SUBSCRIBE_NOW",
      shipping_preference: "NO_SHIPPING",
      return_url: params.returnUrl,
      cancel_url: params.cancelUrl,
    },
  });
}

export async function cancelPayPalSubscription(
  subscriptionId: string,
  reason?: string
) {
  const token = await getPayPalAccessToken();

  const res = await fetch(
    `${apiBase()}/v1/billing/subscriptions/${subscriptionId}/cancel`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        reason: reason?.trim() || "Canceled by customer",
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal cancel subscription error: ${text}`);
  }

  return true;
}

export async function verifyPayPalWebhook(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string
) {
  const headerValue = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value[0] : value;

  const token = await getPayPalAccessToken();

  const res = await fetch(
    `${apiBase()}/v1/notifications/verify-webhook-signature`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        auth_algo: headerValue(headers["paypal-auth-algo"]),
        cert_url: headerValue(headers["paypal-cert-url"]),
        transmission_id: headerValue(headers["paypal-transmission-id"]),
        transmission_sig: headerValue(headers["paypal-transmission-sig"]),
        transmission_time: headerValue(headers["paypal-transmission-time"]),
        webhook_id: must("PAYPAL_WEBHOOK_ID"),
        webhook_event: JSON.parse(rawBody),
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal verify error: ${text}`);
  }

  return (await res.json()) as { verification_status: string };
}

export async function capturePayPalOrder(orderId: string) {
  const token = await getPayPalAccessToken();

  const res = await fetch(`${apiBase()}/v2/checkout/orders/${orderId}/capture`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal capture error: ${text}`);
  }

  return (await res.json()) as Record<string, unknown>;
}