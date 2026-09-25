import * as prismaPkg from "@prisma/client";
import {
  normalizePayPalCurrency,
  resolvePayPalPlanId,
  type PayPalRecurringPlan,
  resolvePayPalStorageAddonPlanId,
} from "./paypal-plan-map.service.js";
import {
  buildPayPalCustomId,
  buildPayPalStorageAddonCustomId,
} from "./paypal-checkout-policy.service.js";
// Phase P2.0 — PAYPAL_SECRET is in the migrated set. Other PayPal env
// names (PAYPAL_CLIENT_ID, PAYPAL_WEBHOOK_ID, PAYPAL_API_BASE) are NOT
// migrated yet — they keep reading process.env directly via the
// non-migrated branch of `must()`.
import { MIGRATED_SECRETS, getSecret } from "../config/runtime-secrets.js";
import { paymentsUnavailable } from "./billing/payments-unavailable.js";
import { DomainError } from "../errors.js";
// PHASE 11 — canonical internal URL builder. Used ONLY to compose the
// return/cancel URL (buildReturnUrl below); the PayPal API-call endpoints
// (apiBase/must) are untouched.
import { absoluteInternalUrl, internalNavPath } from "@proovra/shared";

type PayPalToken = {
  access_token: string;
};

function must(name: string): string {
  const value = (MIGRATED_SECRETS as readonly string[]).includes(name)
    ? getSecret(name)
    : process.env[name];
  // PV-DEFECT-003 — the bounded 503 PAYMENTS_UNAVAILABLE, not a bare 500.
  if (!value || !value.trim()) {
    throw paymentsUnavailable("paypal", name);
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
 * One entry of PayPal's `details[]`, reduced to the fields that DIAGNOSE a
 * failure: which rule (`issue`), where (`field`, `location`) and PayPal's own
 * generic explanation (`description`). PayPal's `value` — which can echo the
 * submitted request value — is deliberately never read.
 */
export type PayPalErrorDetail = {
  issue: string | null;
  field: string | null;
  location: string | null;
  description: string | null;
};

const MAX_ERROR_DETAILS = 5;
const MAX_DETAIL_TEXT = 200;

/**
 * Bounded, single-line text. Strips anything that looks like an e-mail
 * address or a long digit run (a card / account number), so a provider
 * description can never carry payer data into a log line.
 */
function sanitizeProviderText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[\r\n\t]+/g, " ")
    // A real address, not a JSON-pointer like `/purchase_units/@reference_id`.
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted]")
    .replace(/\d{9,}/g, "[redacted]")
    .trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_DETAIL_TEXT
    ? `${cleaned.slice(0, MAX_DETAIL_TEXT)}…`
    : cleaned;
}

export function parsePayPalErrorDetails(body: unknown): PayPalErrorDetail[] {
  const details =
    body && typeof body === "object"
      ? (body as { details?: unknown }).details
      : undefined;
  if (!Array.isArray(details)) return [];
  return details.slice(0, MAX_ERROR_DETAILS).map((raw) => {
    const d =
      raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    return {
      issue: sanitizeProviderText(d.issue),
      field: sanitizeProviderText(d.field),
      location: sanitizeProviderText(d.location),
      description: sanitizeProviderText(d.description),
    };
  });
}

function formatPayPalErrorDetails(details: PayPalErrorDetail[]): string {
  return details
    .map((d) =>
      [
        d.issue ?? "UNKNOWN_ISSUE",
        d.field ? `field=${d.field}` : null,
        d.location ? `location=${d.location}` : null,
        d.description ? `"${d.description}"` : null,
      ]
        .filter(Boolean)
        .join(" "),
    )
    .join("; ");
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
  /**
   * PayPal's sanitized `details[]` — the part of a 422 that actually names
   * the failing rule (e.g. `CURRENCY_NOT_SUPPORTED field=/purchase_units/0/…`).
   * A 422 without these is undiagnosable, which is how the evidence-credit
   * failure (debug id 09f8161575975) reached production as a bare
   * "unprocessable" with nothing to act on.
   */
  readonly details: PayPalErrorDetail[];

  constructor(init: {
    message: string;
    status: number;
    providerErrorName: string | null;
    debugId: string | null;
    details?: PayPalErrorDetail[];
  }) {
    super(init.message);
    this.name = "PayPalHttpError";
    this.status = init.status;
    this.providerErrorName = init.providerErrorName;
    this.debugId = init.debugId;
    this.details = init.details ?? [];
  }

  /** The first `details[].issue`, the one a caller branches on. */
  get primaryIssue(): string | null {
    return this.details[0]?.issue ?? null;
  }
}

async function readPayPalError(res: Response, prefix: string): Promise<never> {
  const text = await res.text();
  const debugId = extractPayPalDebugId(res);

  let message = sanitizeProviderText(text) ?? `HTTP ${res.status}`;
  let providerErrorName: string | null = null;
  let details: PayPalErrorDetail[] = [];
  try {
    const parsed = JSON.parse(text) as { message?: string; name?: string };
    message =
      sanitizeProviderText(parsed.message) ??
      sanitizeProviderText(parsed.name) ??
      message;
    providerErrorName = sanitizeProviderText(parsed.name);
    details = parsePayPalErrorDetails(parsed);
  } catch {
    // keep bounded raw text
  }

  const detailText = details.length
    ? ` [${formatPayPalErrorDetails(details)}]`
    : "";

  throw new PayPalHttpError({
    message: `${prefix} ${res.status}${providerErrorName ? ` ${providerErrorName}` : ""}: ${message}${detailText}${debugId ? ` (paypal-debug-id: ${debugId})` : ""}`,
    status: res.status,
    providerErrorName,
    debugId,
    details,
  });
}

/**
 * A PayPal 4xx while CREATING a checkout (order / subscription), as a bounded
 * `DomainError`.
 *
 * The customer sees a stable code and "nothing was charged" (true: PayPal
 * refused before any approval page existed). The operator log — through the
 * error's metadata — receives the HTTP status, PayPal's error name, its debug
 * id and the sanitized `details[]` issue/field/description, which is exactly
 * what a 422 UNPROCESSABLE_ENTITY needs to be diagnosed. No credential, token,
 * payer detail or raw request body is included.
 */
export function payPalCheckoutRejected(
  err: PayPalHttpError,
  operation:
    | "order_create"
    | "subscription_create"
    | "storage_addon_subscription_create",
): DomainError {
  const first = err.details[0];
  return new DomainError(err.message, {
    httpStatus: 502,
    publicCode: "PAYMENT_PROVIDER_REJECTED",
    publicMessage:
      "PayPal could not start this checkout, and nothing was charged. Please try again, or choose another payment method.",
    reportability: "OPERATIONAL_WARNING",
    severity: "critical",
    metadata: {
      provider: "paypal",
      operation,
      providerStatus: err.status,
      providerErrorName: err.providerErrorName,
      paypalDebugId: err.debugId,
      providerIssue: first?.issue ?? null,
      providerField: first?.field ?? null,
      providerDescription: first?.description ?? null,
      providerIssues:
        err.details
          .map((d) => [d.issue, d.field].filter(Boolean).join("@"))
          .join(",") || null,
    },
  });
}

async function withCheckoutDiagnostics<T>(
  operation: Parameters<typeof payPalCheckoutRejected>[1],
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (
      err instanceof PayPalHttpError &&
      err.status >= 400 &&
      err.status < 500
    ) {
      throw payPalCheckoutRejected(err, operation);
    }
    throw err;
  }
}

export async function paypalRequest(
  path: string,
  body: Record<string, unknown>,
  method: "POST" | "GET" = "POST",
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
  const status = String(plan.status ?? "")
    .trim()
    .toUpperCase();

  // A configured plan PayPal does not report as ACTIVE is a configuration
  // fault the customer cannot fix: the bounded 503 PAYMENTS_UNAVAILABLE (the
  // failure precedes any subscription call, so nothing was charged), with the
  // plan and its status in the operator log only — never a bare 500.
  if (status !== "ACTIVE") {
    throw paymentsUnavailable(
      "paypal",
      `PayPal plan ${planId} (status ${status || "UNKNOWN"})`,
      "plan_not_configured",
    );
  }

  return plan;
}

export async function getPayPalSubscription(subscriptionId: string) {
  return paypalGet(
    `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`,
  );
}

/** Server-side read of a Checkout order — the authority on what was bought. */
export async function getPayPalOrder(orderId: string) {
  return paypalGet(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
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

  return withCheckoutDiagnostics("order_create", () =>
    paypalRequest("/v2/checkout/orders", {
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
    }),
  );
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

  return withCheckoutDiagnostics("subscription_create", () =>
    paypalRequest("/v1/billing/subscriptions", {
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
    }),
  );
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

  // The same return contract as every other PayPal checkout, so the Billing
  // page recognises the return and confirms the subscription server-side.
  const returnUrl = buildReturnUrl(
    "/billing?success=1&provider=paypal&kind=storage-addon",
  );
  const cancelUrl = buildReturnUrl(
    "/billing?canceled=1&provider=paypal&kind=storage-addon",
  );
  const normalizedCurrency = normalizePayPalCurrency(params.currency);

  const planId = resolvePayPalStorageAddonPlanId({
    addonKey: String(params.addonKey),
    currency: normalizedCurrency,
  });

  await assertPayPalPlanIsActive(planId);

  const subscription = await withCheckoutDiagnostics(
    "storage_addon_subscription_create",
    () =>
      paypalRequest("/v1/billing/subscriptions", {
        plan_id: planId,
        custom_id: buildPayPalStorageAddonCustomId({
          userId: params.userId,
          addonKey: params.addonKey,
          teamId: params.teamId ?? null,
        }),
        application_context: {
          brand_name: "PROOVRA",
          user_action: "SUBSCRIBE_NOW",
          return_url: returnUrl,
          cancel_url: cancelUrl,
        },
      }),
  );

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
  reason?: string,
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
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal cancel subscription error: ${text}`);
  }

  return true;
}

export async function verifyPayPalWebhook(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
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
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal verify error: ${text}`);
  }

  return (await res.json()) as { verification_status: string };
}

/**
 * Capture an APPROVED order.
 *
 * `PayPal-Request-Id` is derived from the order id, so a retried capture (a
 * double click, the return page and the CHECKOUT.ORDER.APPROVED webhook racing)
 * is idempotent at PayPal: it returns the original capture rather than
 * charging twice. Failures surface as `PayPalHttpError` with sanitized
 * `details[]` (e.g. ORDER_ALREADY_CAPTURED, INSTRUMENT_DECLINED).
 */
export async function capturePayPalOrder(orderId: string) {
  const token = await getPayPalAccessToken();

  const res = await fetch(
    `${apiBase()}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": `proovra-capture-${orderId}`,
        Prefer: "return=representation",
      },
      body: "{}",
    },
  );

  if (!res.ok) {
    await readPayPalError(res, "PayPal capture error");
  }

  return (await res.json()) as Record<string, unknown>;
}
