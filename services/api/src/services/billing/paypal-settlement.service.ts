/**
 * PAYPAL SETTLEMENT — the ONE place a PayPal order or subscription becomes a
 * commercial consequence (credits, a plan, a storage add-on).
 *
 * THE DEFECTS THIS CLOSES
 * ---------------------------------------------------------------------------
 * 1. Evidence-credit ORDERS were never captured. `createPayPalOrder` opens an
 *    `intent: CAPTURE` order, the buyer approves it, and PayPal returns them
 *    to /billing — but no code ever called `capturePayPalOrder`. An approved,
 *    uncaptured order moves no money and emits no PAYMENT.CAPTURE.COMPLETED,
 *    so the webhook that grants credits could never fire.
 * 2. The capture webhook read `purchase_units[0].custom_id`, which a CAPTURE
 *    resource does not have (a capture is not an order). The purchase is now
 *    recovered from the related ORDER, read server-side from PayPal.
 * 3. A PayPal plan change (`revise`) swaps `plan_id` but keeps `custom_id`, so
 *    reading the plan from custom_id re-applied the OLD plan on every later
 *    webhook. The configured `plan_id` now decides the plan.
 *
 * WHAT IS AUTHORITATIVE
 * ---------------------------------------------------------------------------
 * Only PayPal's own server-side answer: the order / subscription read with our
 * credentials. The browser returning with `success=1` grants nothing; a
 * webhook body is used only when the live read is unavailable and the body's
 * signature has been verified by the caller.
 *
 * IDEMPOTENCY
 * ---------------------------------------------------------------------------
 * Credits are granted through the canonical wallet keyed on the CAPTURE id
 * (the same key the webhook always used), so the return page, the
 * CHECKOUT.ORDER.APPROVED webhook and the PAYMENT.CAPTURE.COMPLETED webhook —
 * in any order, any number of times — grant exactly once. Payments go through
 * `recordPayment`, which never moves a settled row backwards.
 */

import * as prismaPkg from "@prisma/client";
import {
  EVIDENCE_CREDIT_PRODUCT,
  isWorkspaceSubscriptionActive as isPaidTeamSubscriptionActive,
} from "@proovra/shared-billing";

import { prisma } from "../../db.js";
import {
  ensureEntitlement,
  recordPayment,
  upsertWorkspaceStorageAddon,
} from "../billing.service.js";
import {
  getEvidenceCreditPriceCents,
  normalizeBillingCurrency,
} from "../billing-pricing.service.js";
import {
  parsePayPalCustomId,
  parsePayPalStorageAddonCustomId,
} from "../paypal-checkout-policy.service.js";
import {
  isPayPalStorageAddonPlanId,
  resolvePlanFromPayPalPlanId,
} from "../paypal-plan-map.service.js";
import {
  PayPalHttpError,
  capturePayPalOrder,
  getPayPalOrder,
  getPayPalSubscription,
} from "../paypal.service.js";
import { grantEvidenceCredits } from "./evidence-credits.service.js";
import {
  storageAddonStatusFromSubscription,
  syncPlanForSubscription,
} from "./subscription-lifecycle.handlers.js";

const PROVIDER = prismaPkg.PaymentProvider.PAYPAL;

type Json = Record<string, unknown>;

function rec(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function dateFromIso(value: unknown): Date | null {
  const s = str(value);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** PayPal money is a decimal string ("5.00"); cents, or null if unreadable. */
function centsFromValue(value: unknown): number | null {
  const s = typeof value === "number" ? String(value) : str(value);
  if (!s || !/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

/** A PayPal id is short, opaque and URL-safe; anything else is not asked about. */
export function isPayPalResourceId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9-]{6,64}$/.test(value);
}

// ===========================================================================
// Storage add-on guard (shared by the Stripe and PayPal paths)
// ===========================================================================

/**
 * A provider-confirmed add-on may only attach to a workspace the payer owns
 * and that can hold it. Moved verbatim from `webhooks.routes.ts` so the PayPal
 * subscription confirmation applies the SAME check as the Stripe webhook.
 */
export async function assertWebhookStorageAddonAllowed(params: {
  userId: string;
  addonKey: prismaPkg.StorageAddonKey;
  teamId?: string | null;
}) {
  if (params.teamId) {
    const team = await prisma.team.findUnique({
      where: { id: params.teamId },
      select: {
        id: true,
        ownerUserId: true,
        billingPlan: true,
        billingStatus: true,
      },
    });

    if (!team) {
      const err: Error & { statusCode?: number } = new Error("Team not found");
      err.statusCode = 404;
      throw err;
    }

    if (team.ownerUserId !== params.userId) {
      const err: Error & { statusCode?: number } = new Error(
        "Storage add-on team ownership mismatch"
      );
      err.statusCode = 403;
      throw err;
    }

    const isTeamAddon =
      params.addonKey === prismaPkg.StorageAddonKey.TEAM_100_GB ||
      params.addonKey === prismaPkg.StorageAddonKey.TEAM_500_GB ||
      params.addonKey === prismaPkg.StorageAddonKey.TEAM_1_TB;

    if (!isTeamAddon) {
      const err: Error & { statusCode?: number } = new Error(
        "Personal storage add-on cannot be attached to a team workspace"
      );
      err.statusCode = 400;
      throw err;
    }

    // PHASE 9 §12 — canonical commercial decision (no raw plan literals).
    const effectiveTeamActive = isPaidTeamSubscriptionActive({
      billingPlan: team.billingPlan,
      billingStatus: team.billingStatus,
    });

    if (!effectiveTeamActive) {
      const err: Error & { statusCode?: number } = new Error(
        "Team storage add-ons require an active TEAM workspace"
      );
      err.statusCode = 409;
      throw err;
    }

    return;
  }

  const entitlement = await ensureEntitlement(params.userId);

  const isPersonalAddon =
    params.addonKey === prismaPkg.StorageAddonKey.PERSONAL_10_GB ||
    params.addonKey === prismaPkg.StorageAddonKey.PERSONAL_50_GB ||
    params.addonKey === prismaPkg.StorageAddonKey.PERSONAL_200_GB;

  if (!isPersonalAddon) {
    const err: Error & { statusCode?: number } = new Error(
      "Team storage add-on cannot be attached to a personal workspace"
    );
    err.statusCode = 400;
    throw err;
  }

  if (
    entitlement.plan === prismaPkg.PlanType.PAYG &&
    params.addonKey !== prismaPkg.StorageAddonKey.PERSONAL_10_GB &&
    params.addonKey !== prismaPkg.StorageAddonKey.PERSONAL_50_GB
  ) {
    const err: Error & { statusCode?: number } = new Error(
      "PAYG supports only PERSONAL_10_GB and PERSONAL_50_GB"
    );
    err.statusCode = 400;
    throw err;
  }
}

// ===========================================================================
// Evidence-credit ORDERS
// ===========================================================================

export type PayPalCreditSettlement =
  | {
      outcome: "GRANTED" | "ALREADY_GRANTED";
      orderId: string;
      captureId: string;
      credits: number;
      balanceAfter: number;
    }
  | {
      /** Nothing is owed yet: the buyer has not approved, or PayPal is still settling. */
      outcome: "PENDING";
      orderId: string;
      reason: "AWAITING_APPROVAL" | "AWAITING_CAPTURE" | "CAPTURE_PENDING";
      captureId: string | null;
    }
  | { outcome: "CANCELED"; orderId: string }
  | {
      outcome: "FAILED";
      orderId: string;
      reason: "CAPTURE_DECLINED" | "CAPTURE_REFUNDED" | "CAPTURE_REJECTED";
      providerIssue: string | null;
      captureId: string | null;
    }
  | {
      /** The order is not one this caller may settle. Nothing was captured or granted. */
      outcome: "REJECTED";
      orderId: string;
      reason:
        | "NOT_OWNED"
        | "NOT_EVIDENCE_CREDIT"
        | "AMOUNT_MISMATCH"
        | "MALFORMED";
    };

type CreditPurchase = {
  userId: string;
  amountCents: number;
  currency: "USD" | "EUR";
  /** The server price for this currency matches what PayPal holds. */
  priceMatches: boolean;
};

/**
 * Identify an evidence-credit purchase from what PROOVRA itself wrote into the
 * order (`custom_id`, amount) — read back from PayPal, never from the browser.
 */
function readCreditPurchase(unit: Json | null): CreditPurchase | null {
  const parsed = parsePayPalCustomId(str(unit?.custom_id));
  if (!parsed.userId || parsed.plan !== prismaPkg.PlanType.PAYG) return null;

  const amount = rec(unit?.amount);
  const rawCurrency = str(amount?.currency_code)?.toUpperCase() ?? "";
  const cents = centsFromValue(amount?.value);
  if ((rawCurrency !== "USD" && rawCurrency !== "EUR") || cents === null) {
    return {
      userId: parsed.userId,
      amountCents: cents ?? 0,
      currency: normalizeBillingCurrency(rawCurrency),
      priceMatches: false,
    };
  }
  const currency = normalizeBillingCurrency(rawCurrency);
  return {
    userId: parsed.userId,
    amountCents: cents,
    currency,
    priceMatches: cents === getEvidenceCreditPriceCents(currency),
  };
}

function capturesOf(order: Json | null): Json[] {
  const units = Array.isArray(order?.purchase_units) ? order.purchase_units : [];
  const payments = rec(rec(units[0])?.payments);
  return Array.isArray(payments?.captures)
    ? (payments.captures as unknown[]).map(rec).filter((c): c is Json => c !== null)
    : [];
}

function firstUnit(order: Json | null): Json | null {
  return Array.isArray(order?.purchase_units) ? rec(order.purchase_units[0]) : null;
}

/**
 * Apply ONE capture's provider state to the wallet and payment history.
 * Credits are granted only for a COMPLETED capture whose amount and currency
 * are exactly the server price of the product.
 */
async function applyCreditCapture(params: {
  orderId: string;
  purchase: CreditPurchase;
  capture: Json;
}): Promise<PayPalCreditSettlement> {
  const { orderId, purchase, capture } = params;
  const captureId = str(capture.id);
  if (!captureId) {
    return { outcome: "REJECTED", orderId, reason: "MALFORMED" };
  }

  const captureAmount = rec(capture.amount);
  const captureCents = centsFromValue(captureAmount?.value);
  const captureCurrency = str(captureAmount?.currency_code)?.toUpperCase() ?? null;
  const status = str(capture.status)?.toUpperCase() ?? "";
  const observedAtUtc = dateFromIso(capture.update_time ?? capture.create_time);

  const amountCents = captureCents ?? purchase.amountCents;
  const currency = captureCurrency ?? purchase.currency;

  const paymentStatus =
    status === "COMPLETED"
      ? prismaPkg.PaymentStatus.SUCCEEDED
      : status === "PENDING"
        ? prismaPkg.PaymentStatus.PENDING
        : status === "REFUNDED" || status === "PARTIALLY_REFUNDED"
          ? prismaPkg.PaymentStatus.REFUNDED
          : prismaPkg.PaymentStatus.FAILED;

  await ensureEntitlement(purchase.userId);
  await recordPayment({
    userId: purchase.userId,
    provider: PROVIDER,
    providerPaymentId: captureId,
    amountCents,
    currency,
    status: paymentStatus,
    teamId: null,
    observedAtUtc,
  });

  if (status === "PENDING") {
    return { outcome: "PENDING", orderId, reason: "CAPTURE_PENDING", captureId };
  }
  if (status !== "COMPLETED") {
    return {
      outcome: "FAILED",
      orderId,
      reason:
        paymentStatus === prismaPkg.PaymentStatus.REFUNDED
          ? "CAPTURE_REFUNDED"
          : "CAPTURE_DECLINED",
      providerIssue: status || null,
      captureId,
    };
  }

  const captureMatchesOrder =
    captureCents === purchase.amountCents && captureCurrency === purchase.currency;
  if (!purchase.priceMatches || !captureMatchesOrder) {
    // Money moved but not the product's price: record the payment (above),
    // grant nothing, and leave it for an operator rather than guess.
    return { outcome: "REJECTED", orderId, reason: "AMOUNT_MISMATCH" };
  }

  const credits = EVIDENCE_CREDIT_PRODUCT.creditsGrantedPerPurchase;
  const grant = await grantEvidenceCredits({
    userId: purchase.userId,
    credits,
    provider: PROVIDER,
    providerRef: captureId,
  });

  return {
    outcome: grant.granted ? "GRANTED" : "ALREADY_GRANTED",
    orderId,
    captureId,
    credits,
    balanceAfter: grant.balanceAfter,
  };
}

/**
 * Settle an evidence-credit order from PayPal's server-side state.
 *
 * `capture: true` (the authenticated return route and the
 * CHECKOUT.ORDER.APPROVED webhook) captures an APPROVED order; `false` (the
 * capture webhooks) only observes. `expectedUserId` binds the order to the
 * authenticated caller — an order whose custom_id names someone else is
 * refused before anything is captured.
 */
export async function settlePayPalEvidenceCreditOrder(params: {
  orderId: string;
  expectedUserId?: string | null;
  capture: boolean;
  /** The capture a webhook is about, when it names one. */
  captureId?: string | null;
}): Promise<PayPalCreditSettlement> {
  const { orderId } = params;
  let order = rec(await getPayPalOrder(orderId));
  if (!order || str(order.id) !== orderId) {
    return { outcome: "REJECTED", orderId, reason: "MALFORMED" };
  }

  const purchase = readCreditPurchase(firstUnit(order));
  if (!purchase) {
    return { outcome: "REJECTED", orderId, reason: "NOT_EVIDENCE_CREDIT" };
  }
  if (params.expectedUserId && purchase.userId !== params.expectedUserId) {
    return { outcome: "REJECTED", orderId, reason: "NOT_OWNED" };
  }

  const status = str(order.status)?.toUpperCase() ?? "";

  if (status === "VOIDED") return { outcome: "CANCELED", orderId };

  if (
    status === "CREATED" ||
    status === "SAVED" ||
    status === "PAYER_ACTION_REQUIRED"
  ) {
    return {
      outcome: "PENDING",
      orderId,
      reason: "AWAITING_APPROVAL",
      captureId: null,
    };
  }

  if (status === "APPROVED") {
    if (!purchase.priceMatches) {
      // Never take money for an amount the server does not sell.
      return { outcome: "REJECTED", orderId, reason: "AMOUNT_MISMATCH" };
    }
    if (!params.capture) {
      return {
        outcome: "PENDING",
        orderId,
        reason: "AWAITING_CAPTURE",
        captureId: null,
      };
    }
    try {
      const captured = rec(await capturePayPalOrder(orderId));
      // The capture response carries the capture; if PayPal returned a
      // minimal body, fall back to a fresh server-side read.
      order = capturesOf(captured).length > 0 ? captured : rec(await getPayPalOrder(orderId));
    } catch (err) {
      if (
        err instanceof PayPalHttpError &&
        err.primaryIssue === "ORDER_ALREADY_CAPTURED"
      ) {
        // A concurrent capture (webhook or second tab) won; read its result.
        order = rec(await getPayPalOrder(orderId));
      } else if (err instanceof PayPalHttpError && err.status === 422) {
        // e.g. INSTRUMENT_DECLINED / PAYER_ACTION_REQUIRED: nothing captured.
        return {
          outcome: "FAILED",
          orderId,
          reason: "CAPTURE_REJECTED",
          providerIssue: err.primaryIssue ?? err.providerErrorName,
          captureId: null,
        };
      } else {
        throw err;
      }
    }
  } else if (status !== "COMPLETED") {
    return {
      outcome: "PENDING",
      orderId,
      reason: "AWAITING_APPROVAL",
      captureId: null,
    };
  }

  const captures = capturesOf(order);
  const capture =
    (params.captureId
      ? captures.find((c) => str(c.id) === params.captureId)
      : undefined) ?? captures[0];
  if (!capture) {
    return {
      outcome: "PENDING",
      orderId,
      reason: "AWAITING_CAPTURE",
      captureId: null,
    };
  }

  return applyCreditCapture({ orderId, purchase, capture });
}

/**
 * A PAYMENT.CAPTURE.* webhook. The resource is a CAPTURE: it carries no
 * `purchase_units`, and `custom_id` only when PayPal chooses to copy it. The
 * purchase is recovered from the related order
 * (`supplementary_data.related_ids.order_id`), read live from PayPal, so the
 * grant is decided on the order's current state — which also makes an
 * out-of-order PENDING delivery after COMPLETED harmless.
 *
 * Returns null when the capture is not an evidence-credit purchase (e.g. a
 * legacy one-time storage add-on order), so the caller can try other handlers.
 */
export async function handlePayPalCaptureWebhook(
  resource: unknown,
): Promise<PayPalCreditSettlement | null> {
  const capture = rec(resource);
  if (!capture) return null;
  const captureId = str(capture.id);
  const orderId = str(
    rec(rec(capture.supplementary_data)?.related_ids)?.order_id,
  );

  if (orderId && isPayPalResourceId(orderId)) {
    const result = await settlePayPalEvidenceCreditOrder({
      orderId,
      capture: false,
      captureId,
    });
    return result.outcome === "REJECTED" &&
      result.reason === "NOT_EVIDENCE_CREDIT"
      ? null
      : result;
  }

  // No related order id: fall back to the capture's own custom_id and amount
  // (the event body is signature-verified by the caller).
  const purchase = readCreditPurchase(capture);
  if (!purchase || !captureId) return null;
  return applyCreditCapture({
    orderId: "",
    purchase,
    capture,
  });
}

// ===========================================================================
// SUBSCRIPTIONS (base plans and storage add-ons)
// ===========================================================================

/**
 * PayPal subscription status → the canonical status.
 *
 * CREATED / APPROVAL_PENDING / APPROVED are all "the buyer has not paid yet":
 * TRIALING, which `syncPlanForSubscription` deliberately treats as grant
 * NOTHING, and which a storage add-on maps to PENDING (not counted as
 * capacity). Only ACTIVE grants.
 */
export function parsePayPalSubscriptionStatus(
  status?: string | null,
): prismaPkg.SubscriptionStatus {
  const normalized = (status ?? "").trim().toUpperCase();

  if (normalized === "ACTIVE") return prismaPkg.SubscriptionStatus.ACTIVE;
  if (
    normalized === "APPROVAL_PENDING" ||
    normalized === "APPROVED" ||
    normalized === "CREATED"
  ) {
    return prismaPkg.SubscriptionStatus.TRIALING;
  }
  if (normalized === "SUSPENDED") return prismaPkg.SubscriptionStatus.PAST_DUE;
  return prismaPkg.SubscriptionStatus.CANCELED;
}

/**
 * What the buyer is told on return. Derived here, beside the status mapping,
 * so the route layer names no subscription status.
 */
export type PayPalSubscriptionReturnOutcome =
  | "ACTIVE"
  | "PENDING"
  | "PAYMENT_PROBLEM"
  | "ENDED";

function returnOutcomeFor(
  status: prismaPkg.SubscriptionStatus,
): PayPalSubscriptionReturnOutcome {
  switch (status) {
    case prismaPkg.SubscriptionStatus.ACTIVE:
      return "ACTIVE";
    case prismaPkg.SubscriptionStatus.TRIALING:
      return "PENDING";
    case prismaPkg.SubscriptionStatus.PAST_DUE:
      return "PAYMENT_PROBLEM";
    case prismaPkg.SubscriptionStatus.CANCELED:
      return "ENDED";
  }
}

export type PayPalSubscriptionSettlement =
  | {
      outcome: "APPLIED";
      kind: "PLAN" | "STORAGE_ADDON";
      subscriptionId: string;
      status: prismaPkg.SubscriptionStatus;
      returnOutcome: PayPalSubscriptionReturnOutcome;
      plan: prismaPkg.PlanType | null;
      storageAddonKey: prismaPkg.StorageAddonKey | null;
    }
  | {
      outcome: "REJECTED";
      subscriptionId: string;
      reason:
        | "NOT_OWNED"
        | "UNATTRIBUTABLE"
        | "PLAN_ID_MISMATCH"
        | "STORAGE_ADDON_NOT_ALLOWED";
    };

/**
 * Apply one PayPal subscription's state.
 *
 * The LIVE subscription is read from PayPal first; the (signature-verified)
 * webhook resource is only a fallback for when that read fails. Reading live
 * state is what makes duplicate and out-of-order webhook delivery converge:
 * whichever event arrives, the state applied is PayPal's current one.
 */
export async function applyPayPalSubscriptionState(params: {
  subscriptionId: string;
  /** Verified webhook resource, used only if the live read fails. */
  fallbackResource?: unknown;
  /** Binds the subscription to the authenticated caller (return route). */
  expectedUserId?: string | null;
  source: string;
  log?: { warn: (obj: unknown, msg: string) => void };
}): Promise<PayPalSubscriptionSettlement> {
  const { subscriptionId } = params;

  let sub: Json | null = null;
  try {
    sub = rec(await getPayPalSubscription(subscriptionId));
  } catch (err) {
    if (!params.fallbackResource) throw err;
    sub = rec(params.fallbackResource);
  }
  if (!sub || (str(sub.id) && str(sub.id) !== subscriptionId)) {
    return { outcome: "REJECTED", subscriptionId, reason: "UNATTRIBUTABLE" };
  }

  const customId = str(sub.custom_id);
  const planId = str(sub.plan_id);
  const status = parsePayPalSubscriptionStatus(str(sub.status));
  const billingInfo = rec(sub.billing_info);
  const currentPeriodEnd = dateFromIso(billingInfo?.next_billing_time);
  const observedAtUtc = dateFromIso(
    sub.status_update_time ?? sub.update_time ?? sub.create_time,
  );

  // --- Storage add-on --------------------------------------------------------
  const addon = parsePayPalStorageAddonCustomId(customId);
  if (addon) {
    if (params.expectedUserId && addon.userId !== params.expectedUserId) {
      return { outcome: "REJECTED", subscriptionId, reason: "NOT_OWNED" };
    }
    if (status === prismaPkg.SubscriptionStatus.ACTIVE) {
      // Capacity is granted only for the configured plan of THIS add-on
      // (its server price) and only to a workspace the payer may extend.
      if (
        !isPayPalStorageAddonPlanId({ planId, addonKey: addon.storageAddonKey })
      ) {
        params.log?.warn(
          { provider: "PAYPAL", subscriptionId, storageAddonKey: addon.storageAddonKey },
          "paypal.storage_addon_plan_id_mismatch",
        );
        return { outcome: "REJECTED", subscriptionId, reason: "PLAN_ID_MISMATCH" };
      }
      try {
        await assertWebhookStorageAddonAllowed({
          userId: addon.userId,
          addonKey: addon.storageAddonKey,
          teamId: addon.teamId,
        });
      } catch (err) {
        params.log?.warn(
          { err, provider: "PAYPAL", subscriptionId, storageAddonKey: addon.storageAddonKey },
          "paypal.storage_addon_activation_refused",
        );
        return {
          outcome: "REJECTED",
          subscriptionId,
          reason: "STORAGE_ADDON_NOT_ALLOWED",
        };
      }
    }

    await upsertWorkspaceStorageAddon({
      ownerUserId: addon.userId,
      teamId: addon.teamId,
      addonKey: addon.storageAddonKey,
      billingCycle: prismaPkg.StorageAddonBillingCycle.MONTHLY,
      status: storageAddonStatusFromSubscription(status),
      paymentProvider: PROVIDER,
      externalSubscriptionId: subscriptionId,
      currentPeriodEnd,
      metadata: { source: params.source },
    });

    return {
      outcome: "APPLIED",
      kind: "STORAGE_ADDON",
      subscriptionId,
      status,
      returnOutcome: returnOutcomeFor(status),
      plan: null,
      storageAddonKey: addon.storageAddonKey,
    };
  }

  // --- Base plan -------------------------------------------------------------
  const parsed = parsePayPalCustomId(customId);
  if (!parsed.userId) {
    return { outcome: "REJECTED", subscriptionId, reason: "UNATTRIBUTABLE" };
  }
  if (params.expectedUserId && parsed.userId !== params.expectedUserId) {
    return { outcome: "REJECTED", subscriptionId, reason: "NOT_OWNED" };
  }

  // The plan PayPal is billing wins over the plan checkout stamped.
  const planFromPlanId = resolvePlanFromPayPalPlanId(planId);
  if (planId && !planFromPlanId) {
    params.log?.warn(
      { provider: "PAYPAL", subscriptionId },
      "paypal.subscription_plan_id_not_configured",
    );
  }
  let plan = planFromPlanId ?? parsed.plan;
  if (!plan) {
    return { outcome: "REJECTED", subscriptionId, reason: "UNATTRIBUTABLE" };
  }

  // A provider-confirmed SCHEDULED change (plan-transition.service records it
  // as pendingPlan) takes effect at its date, not the moment PayPal swaps the
  // plan id: the current period is paid for at the current plan.
  const stored = await prisma.subscription.findUnique({
    where: {
      provider_providerSubId: { provider: PROVIDER, providerSubId: subscriptionId },
    },
    select: { plan: true, pendingPlan: true, pendingPlanEffectiveAtUtc: true },
  });
  if (
    stored &&
    stored.pendingPlan === plan &&
    stored.plan !== plan &&
    stored.pendingPlanEffectiveAtUtc &&
    stored.pendingPlanEffectiveAtUtc.getTime() > Date.now()
  ) {
    plan = stored.plan;
  }

  await syncPlanForSubscription({
    userId: parsed.userId,
    plan,
    teamId: parsed.teamId,
    provider: PROVIDER,
    providerSubId: subscriptionId,
    status,
    currentPeriodEnd,
    observedAtUtc,
  });

  return {
    outcome: "APPLIED",
    kind: "PLAN",
    subscriptionId,
    status,
    returnOutcome: returnOutcomeFor(status),
    plan,
    storageAddonKey: null,
  };
}
