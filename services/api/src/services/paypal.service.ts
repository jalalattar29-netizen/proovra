import * as prismaPkg from "@prisma/client";
import {
  normalizePayPalCurrency,
  resolvePayPalPlanId,
  type PayPalRecurringPlan,
  resolvePayPalStorageAddonPlanId,
} from "./paypal-plan-map.service.js";
import { buildPayPalCustomId } from "./paypal-checkout-policy.service.js";
// Phase P2.0 — PAYPAL_SECRET is in the migrated set. Other PayPal env
// names (PAYPAL_CLIENT_ID, PAYPAL_WEBHOOK_ID, PAYPAL_API_BASE) are NOT
// migrated yet — they keep reading process.env directly via the
// non-migrated branch of `must()`.
import {
  MIGRATED_SECRETS,
  requireSecret,
} from "../config/runtime-secrets.js";
// PHASE 11 — canonical internal URL builder. Used ONLY to compose the
// return/cancel URL (buildReturnUrl below); the PayPal API-call endpoints
// (apiBase/must) are untouched.
import { absoluteInternalUrl, internalNavPath } from "@proovra/shared";

type PayPalToken = {
  access_token: string;
};

function must(name: string): string {
  if ((MIGRATED_SECRETS as readonly string[]).includes(name)) {
    return requireSecret(name);
  }
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`${name} is not set`);
  }
  return value.trim();
}

function apiBase() {
  return process.env.PAYPAL_API_BASE?.trim() || "https://api-m.paypal.com";
}

function cleanUrl(value: string | undefined): string | null {
  const v = value?.trim();
  return v ? v.replace(/\/+$/, "") : null;
}

function getWebBaseUrl() {
  return (
    cleanUrl(process.env.APP_BASE_URL) ??
    cleanUrl(process.env.WEB_BASE_URL) ??
    cleanUrl(process.env.NEXT_PUBLIC_APP_BASE) ??
    cleanUrl(process.env.NEXT_PUBLIC_WEB_BASE) ??
    "https://app.proovra.com"
  );
}

function buildReturnUrl(path: string) {
  // PHASE 11 — canonical absolute-internal-URL builder. `path` may carry a
  // query string (e.g. "/billing?checkout=success&kind=storage-addon");
  // internalNavPath only normalises the leading slash and leaves the rest
  // of the string intact, so callers are unaffected.
  return absoluteInternalUrl(getWebBaseUrl(), internalNavPath(path));
}

function buildStorageAddonCustomId(params: {
  userId: string;
  addonKey: prismaPkg.StorageAddonKey;
  billingCycle: prismaPkg.StorageAddonBillingCycle;
  teamId?: string | null;
  workspacePlan: prismaPkg.PlanType;
}) {
  return JSON.stringify({
    userId: params.userId,
    teamId: params.teamId ?? null,
    storageAddonKey: params.addonKey,
    billingCycle: params.billingCycle,
    workspacePlan: params.workspacePlan,
  });
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

type PayPalPlanDetails = {
  id?: string;
  status?: string;
  product_id?: string;
  name?: string;
};

function extractPayPalDebugId(res: Response) {
  return res.headers.get("paypal-debug-id") ?? null;
}

/**
 * A PayPal HTTP failure, with the facts a caller needs to CLASSIFY it.
 *
 * BILLING PAYMENT LIFECYCLE (2026-08-30) — every PayPal failure used to arrive
 * as a bare `Error` carrying a sentence, so the one caller that has to tell
 * these apart — the observation adapter — could only catch it and say
 * "unavailable". A 404 for a reference PayPal has never heard of, a 401 from a
 * rotated credential and a genuine outage are three different problems with
 * three different remedies, and collapsing them told a customer to try again
 * later in two cases where waiting cannot help.
 *
 * It still extends `Error` and still carries the same message, so every
 * existing catch site behaves exactly as before.
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY: the response body. A PayPal error
 * payload can echo request fields, and this object is logged.
 */
export class PayPalHttpError extends Error {
  readonly status: number;
  /** PayPal's own error name, e.g. RESOURCE_NOT_FOUND. Never a payload. */
  readonly providerErrorName: string | null;
  /** PayPal's correlation id, for support to trace one call. */
  readonly debugId: string | null;

  constructor(init: {
    message: string;
    status: number;
    providerErrorName: string | null;
    debugId: string | null;
  }) {
    super(init.message);
    this.name = "PayPalHttpError";
    this.status = init.status;
    this.providerErrorName = init.providerErrorName;
    this.debugId = init.debugId;
  }
}

async function readPayPalError(res: Response, prefix: string): Promise<never> {
  const text = await res.text();
  const debugId = extractPayPalDebugId(res);

  let message = text;
  let providerErrorName: string | null = null;
  try {
    const parsed = JSON.parse(text) as { message?: string; name?: string };
    message = parsed.message || parsed.name || text;
    providerErrorName = parsed.name ?? null;
  } catch {
    // keep raw text
  }

  throw new PayPalHttpError({
    message: `${prefix}: ${message}${debugId ? ` (paypal-debug-id: ${debugId})` : ""}`,
    status: res.status,
    providerErrorName,
    debugId,
  });
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
    await readPayPalError(res, "PayPal error");
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
    await readPayPalError(res, "PayPal GET error");
  }

  return (await res.json()) as Record<string, unknown>;
}

export async function getPayPalPlan(planId: string) {
  return (await paypalGet(`/v1/billing/plans/${planId}`)) as PayPalPlanDetails;
}

async function assertPayPalPlanIsActive(planId: string) {
  const plan = await getPayPalPlan(planId);
  const status = String(plan.status ?? "").trim().toUpperCase();

  if (status !== "ACTIVE") {
    throw new Error(
      `PayPal plan ${planId} is not ACTIVE. Current status: ${status || "UNKNOWN"}`
    );
  }

  return plan;
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

  await assertPayPalPlanIsActive(planId);

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
      return_url: params.returnUrl,
      cancel_url: params.cancelUrl,
    },
  });
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
  /**
   * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — a RECURRING subscription
   * against the configured PayPal billing plan, not a one-time ORDER.
   *
   * This function used to create `/v2/checkout/orders` with intent CAPTURE:
   * one payment, and a `workspace_storage_addons` row that nothing ever
   * expired, granting capacity for ever. Meanwhile twelve
   * `PAYPAL_PLAN_STORAGE_*` recurring plan ids sat configured in the
   * environment, read by no code at all. Those plans are now what an add-on
   * subscribes to, so the charge recurs exactly as the storage does.
   */
  if (params.billingCycle !== prismaPkg.StorageAddonBillingCycle.MONTHLY) {
    throw new Error(
      "Storage add-ons are sold as recurring monthly subscriptions",
    );
  }

  const returnUrl = buildReturnUrl("/billing?checkout=success&kind=storage-addon");
  const cancelUrl = buildReturnUrl("/billing?checkout=cancel&kind=storage-addon");
  const normalizedCurrency = normalizePayPalCurrency(params.currency);

  const planId = resolvePayPalStorageAddonPlanId({
    addonKey: String(params.addonKey),
    currency: normalizedCurrency,
  });

  await assertPayPalPlanIsActive(planId);

  const subscription = await paypalRequest("/v1/billing/subscriptions", {
    plan_id: planId,
    custom_id: buildStorageAddonCustomId({
      userId: params.userId,
      addonKey: params.addonKey,
      billingCycle: prismaPkg.StorageAddonBillingCycle.MONTHLY,
      teamId: params.teamId ?? null,
      workspacePlan: params.workspacePlan,
    }),
    application_context: {
      brand_name: "PROOVRA",
      user_action: "SUBSCRIBE_NOW",
      return_url: returnUrl,
      cancel_url: cancelUrl,
    },
  });

  return {
    provider: "PAYPAL" as const,
    mode: "subscription" as const,
    subscription,
    currency: normalizedCurrency,
    amountCents: Math.round(Number(params.amount) * 100),
  };
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