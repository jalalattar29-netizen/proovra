import * as prismaPkg from "@prisma/client";
import { normalizePayPalCurrency, resolvePayPalPlanId, } from "./paypal-plan-map.service.js";
import { buildPayPalCustomId } from "./paypal-checkout-policy.service.js";
// Phase P2.0 — PAYPAL_SECRET is in the migrated set. Other PayPal env
// names (PAYPAL_CLIENT_ID, PAYPAL_WEBHOOK_ID, PAYPAL_API_BASE) are NOT
// migrated yet — they keep reading process.env directly via the
// non-migrated branch of `must()`.
import { MIGRATED_SECRETS, requireSecret, } from "../config/runtime-secrets.js";
function must(name) {
    if (MIGRATED_SECRETS.includes(name)) {
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
function cleanUrl(value) {
    const v = value?.trim();
    return v ? v.replace(/\/+$/, "") : null;
}
function getWebBaseUrl() {
    return (cleanUrl(process.env.APP_BASE_URL) ??
        cleanUrl(process.env.WEB_BASE_URL) ??
        cleanUrl(process.env.NEXT_PUBLIC_APP_BASE) ??
        cleanUrl(process.env.NEXT_PUBLIC_WEB_BASE) ??
        "https://app.proovra.com");
}
function buildReturnUrl(path) {
    return `${getWebBaseUrl()}${path}`;
}
function buildStorageAddonCustomId(params) {
    return JSON.stringify({
        userId: params.userId,
        teamId: params.teamId ?? null,
        storageAddonKey: params.addonKey,
        billingCycle: params.billingCycle,
        workspacePlan: params.workspacePlan,
    });
}
export async function getPayPalAccessToken() {
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
    const data = (await res.json());
    return data.access_token;
}
function extractPayPalDebugId(res) {
    return res.headers.get("paypal-debug-id") ?? null;
}
async function readPayPalError(res, prefix) {
    const text = await res.text();
    const debugId = extractPayPalDebugId(res);
    let message = text;
    try {
        const parsed = JSON.parse(text);
        message = parsed.message || parsed.name || text;
    }
    catch {
        // keep raw text
    }
    throw new Error(`${prefix}: ${message}${debugId ? ` (paypal-debug-id: ${debugId})` : ""}`);
}
export async function paypalRequest(path, body, method = "POST") {
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
    return (await res.json());
}
export async function paypalGet(path) {
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
    return (await res.json());
}
export async function getPayPalPlan(planId) {
    return (await paypalGet(`/v1/billing/plans/${planId}`));
}
async function assertPayPalPlanIsActive(planId) {
    const plan = await getPayPalPlan(planId);
    const status = String(plan.status ?? "").trim().toUpperCase();
    if (status !== "ACTIVE") {
        throw new Error(`PayPal plan ${planId} is not ACTIVE. Current status: ${status || "UNKNOWN"}`);
    }
    return plan;
}
export async function getPayPalSubscription(subscriptionId) {
    return paypalGet(`/v1/billing/subscriptions/${subscriptionId}`);
}
export async function createPayPalOrder(params) {
    const normalizedCurrency = normalizePayPalCurrency(params.currency);
    const plan = String(params.plan).trim().toUpperCase();
    const description = plan === prismaPkg.PlanType.TEAM && params.teamId
        ? `PROOVRA ${plan} ${params.teamId}`
        : `PROOVRA ${plan}`;
    return paypalRequest("/v2/checkout/orders", {
        intent: "CAPTURE",
        purchase_units: [
            {
                custom_id: buildPayPalCustomId({
                    userId: params.userId,
                    plan: params.plan,
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
export async function createPayPalSubscription(params) {
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
export async function createPayPalStorageAddonCheckout(params) {
    if (params.billingCycle !== prismaPkg.StorageAddonBillingCycle.ONE_TIME) {
        throw new Error("Storage add-ons are available only as one-time purchases");
    }
    const returnUrl = buildReturnUrl("/billing?checkout=success&kind=storage-addon");
    const cancelUrl = buildReturnUrl("/billing?checkout=cancel&kind=storage-addon");
    const normalizedCurrency = normalizePayPalCurrency(params.currency);
    const order = await paypalRequest("/v2/checkout/orders", {
        intent: "CAPTURE",
        purchase_units: [
            {
                custom_id: buildStorageAddonCustomId({
                    userId: params.userId,
                    addonKey: params.addonKey,
                    billingCycle: prismaPkg.StorageAddonBillingCycle.ONE_TIME,
                    teamId: params.teamId ?? null,
                    workspacePlan: params.workspacePlan,
                }),
                description: `PROOVRA Storage Add-on ${params.addonKey}`,
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
            return_url: returnUrl,
            cancel_url: cancelUrl,
        },
    });
    return {
        provider: "PAYPAL",
        mode: "order",
        order,
        currency: normalizedCurrency,
        amountCents: Math.round(Number(params.amount) * 100),
    };
}
export async function cancelPayPalSubscription(subscriptionId, reason) {
    const token = await getPayPalAccessToken();
    const res = await fetch(`${apiBase()}/v1/billing/subscriptions/${subscriptionId}/cancel`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            reason: reason?.trim() || "Canceled by customer",
        }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`PayPal cancel subscription error: ${text}`);
    }
    return true;
}
export async function verifyPayPalWebhook(headers, rawBody) {
    const headerValue = (value) => Array.isArray(value) ? value[0] : value;
    const token = await getPayPalAccessToken();
    const res = await fetch(`${apiBase()}/v1/notifications/verify-webhook-signature`, {
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
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`PayPal verify error: ${text}`);
    }
    return (await res.json());
}
export async function capturePayPalOrder(orderId) {
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
    return (await res.json());
}
