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
import { ensureEntitlement, recordPayment, upsertWorkspaceStorageAddon } from "../billing.service.js";
import {
  getEvidenceCreditPriceCents,
  normalizeBillingCurrency,
} from "../billing-pricing.service.js";
import {
  parsePayPalCustomId,
  parsePayPalStorageAddonCustomId,
} from "../paypal-checkout-policy.service.js";
import {
  currencyForPayPalBasePlanId,
  resolvePlanFromPayPalPlanId,
} from "../paypal-plan-map.service.js";
import {
  PayPalHttpError,
  capturePayPalOrder,
  getPayPalOrder,
  getPayPalSubscription,
  paypalGet,
  readPayPalSubscriptionPaidFact,
} from "../paypal.service.js";
import { grantEvidenceCredits, reverseEvidenceCreditPurchase } from "./evidence-credits.service.js";
import { applyPaymentAdjustment } from "./payment-adjustments.service.js";
import { noteActiveWithoutCompletedPayment, recordBillingReviewItem } from "./billing-review.service.js";
import { applyStorageSubscriptionObservation } from "./storage-activation.service.js";
import {
  recordCheckoutAttemptProviderOutcome,
  type CheckoutState,
} from "./checkout-attempts.service.js";
import { syncPlanForSubscription } from "./subscription-lifecycle.handlers.js";
import { expireUnapprovedPlanChange, markPlanChangeApproved } from "./plan-transition.service.js";
import { reclassifyLegacyLocalTermination } from "./subscription-cancellation.service.js";

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

/** PRO-BL1-04 — re-exported; the helper lives beside the PayPal API reader. */
export { addOneMonthUtc } from "../paypal.service.js";

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
// LEGACY one-time storage captures
// ===========================================================================

export type LegacyStorageCaptureSettlement =
  | { outcome: "GRANTED"; addonId: string }
  /** The binding is no longer waiting (a redelivery, or decided earlier). Nothing is written. */
  | { outcome: "ALREADY_SETTLED"; addonId: string }
  | {
      outcome: "REVIEW";
      reason: "LEGACY_STORAGE_CAPTURE_UNMATCHED" | "AMOUNT_MISMATCH" | "STORAGE_ACTIVATION_REFUSED";
      cause: string;
    }
  /** Nothing names a payer PROOVRA knows; nothing can be recorded against anyone. */
  | { outcome: "UNATTRIBUTABLE" };

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * AUDIT E-03 (2026-11-15) — a PAYMENT.CAPTURE.COMPLETED for a LEGACY one-time
 * storage order (the pre-2026-08 `ONE_TIME` cycle; no checkout path creates
 * one any more: `upsertWorkspaceStorageAddon`, billing.routes.ts
 * StorageAddonCheckoutBody).
 *
 * The webhook used to grant perpetual ONE_TIME capacity from the capture's
 * `custom_id` alone, at whatever amount the capture carried. Those orders never
 * had a local attempt (the old checkout created the order at PayPal only), so
 * the custom_id was the only thing tying money to a payer — and a custom_id is
 * whatever the order's creator wrote. Capacity is now granted only through a
 * DURABLE LOCAL BINDING: one `workspace_storage_addons` row (PAYPAL, ONE_TIME)
 * whose `external_payment_id` is this capture or its order. That row is the
 * trusted statement of payer, workspace, size, amount and currency; the capture
 * must match all of them. Everything else goes to the review queue
 * (`billing_review_items`) and grants nothing:
 *
 *   * no binding, or more than one     LEGACY_STORAGE_CAPTURE_UNMATCHED
 *   * a binding naming another payer, workspace or size   (same reason)
 *   * amount or currency not the binding's               AMOUNT_MISMATCH
 *   * the payer's workspace cannot hold it now           STORAGE_ACTIVATION_REFUSED
 *
 * Only a PENDING binding is settled. A live (or ended) one — this capture's
 * earlier delivery, or a grant made before this rule — is a redelivery or an
 * old decision: nothing is written, so storage granted earlier stays exactly as
 * it is. Database failures
 * throw (BILLING-013: the caller must not mark the event processed).
 * The caller has verified the event signature.
 */
export async function settleLegacyStorageCapture(input: {
  capture: unknown;
  /** What the capture's custom_id claims (legacy JSON / key=value / sa1). */
  claimed: {
    userId?: string | null;
    teamId?: string | null;
    storageAddonKey?: prismaPkg.StorageAddonKey | null;
  };
  eventType: string;
}): Promise<LegacyStorageCaptureSettlement> {
  const capture = rec(input.capture);
  const captureId = str(capture?.id);
  if (!capture || !isPayPalResourceId(captureId)) return { outcome: "UNATTRIBUTABLE" };
  const orderIdRaw = str(rec(rec(capture.supplementary_data)?.related_ids)?.order_id);
  const orderId = isPayPalResourceId(orderIdRaw) ? orderIdRaw : null;
  const amount = rec(capture.amount);
  const capturedCents = centsFromValue(amount?.value);
  const capturedCurrency = str(amount?.currency_code)?.toUpperCase() ?? null;
  const claimedUserId =
    input.claimed.userId && UUID_SHAPE.test(input.claimed.userId) ? input.claimed.userId : null;
  const facts = {
    eventType: input.eventType,
    orderId,
    capturedCents,
    capturedCurrency,
    claimedAddonKey: input.claimed.storageAddonKey ?? null,
  };

  const bindings = await prisma.workspaceStorageAddon.findMany({
    where: {
      paymentProvider: PROVIDER,
      billingCycle: prismaPkg.StorageAddonBillingCycle.ONE_TIME,
      externalPaymentId: { in: orderId ? [captureId, orderId] : [captureId] },
    },
    select: {
      id: true,
      ownerUserId: true,
      teamId: true,
      addonKey: true,
      status: true,
      externalPaymentId: true,
      amountCents: true,
      currency: true,
    },
    take: 3,
  });

  const review = async (
    userId: string,
    reason: "LEGACY_STORAGE_CAPTURE_UNMATCHED" | "AMOUNT_MISMATCH" | "STORAGE_ACTIVATION_REFUSED",
    cause: string,
    detail: Record<string, string | number | boolean | null> = {},
  ): Promise<LegacyStorageCaptureSettlement> => {
    await recordBillingReviewItem({
      userId,
      provider: PROVIDER,
      providerResourceId: captureId,
      product: "STORAGE_ADDON",
      reason,
      refundReviewRequired: true,
      detail: { ...facts, cause, ...detail },
    });
    return { outcome: "REVIEW", reason, cause };
  };

  if (bindings.length !== 1) {
    // Recorded against the binding's owner when one exists, else the payer the
    // custom_id names — only if that account exists (the review row needs one).
    let subject: string | null = bindings[0]?.ownerUserId ?? null;
    if (!subject && claimedUserId) {
      const named = await prisma.user.findUnique({ where: { id: claimedUserId }, select: { id: true } });
      subject = named?.id ?? null;
    }
    if (!subject) return { outcome: "UNATTRIBUTABLE" };
    return review(subject, "LEGACY_STORAGE_CAPTURE_UNMATCHED", bindings.length === 0 ? "NO_BINDING" : "AMBIGUOUS_BINDING", {
      bindings: bindings.length,
    });
  }

  const binding = bindings[0]!;
  // Only a binding still WAITING (PENDING) can be settled. One that is live,
  // cancelled or expired was decided already — by this capture's earlier
  // delivery or another way — and is never rewritten.
  if (binding.status !== prismaPkg.WorkspaceStorageAddonStatus.PENDING) {
    return { outcome: "ALREADY_SETTLED", addonId: binding.id };
  }

  const identityMatches =
    (!input.claimed.userId || input.claimed.userId === binding.ownerUserId) &&
    (input.claimed.teamId === undefined || (input.claimed.teamId ?? null) === (binding.teamId ?? null)) &&
    (!input.claimed.storageAddonKey || input.claimed.storageAddonKey === binding.addonKey);
  if (!identityMatches) {
    return review(binding.ownerUserId, "LEGACY_STORAGE_CAPTURE_UNMATCHED", "IDENTITY_MISMATCH", {
      bindingId: binding.id,
    });
  }

  const status = str(capture.status)?.toUpperCase() ?? "COMPLETED";
  if (status !== "COMPLETED") {
    return review(binding.ownerUserId, "LEGACY_STORAGE_CAPTURE_UNMATCHED", "CAPTURE_NOT_COMPLETED", {
      bindingId: binding.id,
      captureStatus: status,
    });
  }

  // The binding is the price this purchase was sold at. A binding without one
  // cannot vouch for any amount.
  const expectedCents = binding.amountCents ?? null;
  const expectedCurrency = binding.currency?.toUpperCase() ?? null;

  // The binding names its payer, so the money is recorded in their history
  // whatever is decided below (a refund review needs the payment it refunds).
  const recordCapture = () =>
    recordPayment({
      userId: binding.ownerUserId,
      provider: PROVIDER,
      providerPaymentId: captureId,
      amountCents: capturedCents ?? 0,
      currency: capturedCurrency ?? expectedCurrency ?? "USD",
      status: prismaPkg.PaymentStatus.SUCCEEDED,
      teamId: binding.teamId ?? null,
      product: "STORAGE_ADDON_ONE_TIME",
      providerResourceId: orderId,
    });

  if (
    expectedCents === null ||
    expectedCurrency === null ||
    capturedCents !== expectedCents ||
    capturedCurrency !== expectedCurrency
  ) {
    await recordCapture();
    return review(binding.ownerUserId, "AMOUNT_MISMATCH", "AMOUNT_OR_CURRENCY", {
      bindingId: binding.id,
      expectedCents,
      expectedCurrency,
    });
  }

  try {
    await assertWebhookStorageAddonAllowed({
      userId: binding.ownerUserId,
      addonKey: binding.addonKey,
      teamId: binding.teamId ?? null,
    });
  } catch (err) {
    // BILLING-013 — only a policy refusal (an HTTP status below 500) is a
    // decision; anything else is a failure the provider must redeliver.
    const refusal = (err as { statusCode?: number })?.statusCode;
    if (typeof refusal !== "number" || refusal >= 500) throw err;
    await recordCapture();
    return review(binding.ownerUserId, "STORAGE_ACTIVATION_REFUSED", "POLICY_REFUSED", {
      bindingId: binding.id,
      refusalStatus: refusal,
    });
  }

  await recordCapture();
  const granted = await upsertWorkspaceStorageAddon({
    attemptId: binding.id,
    ownerUserId: binding.ownerUserId,
    teamId: binding.teamId ?? null,
    addonKey: binding.addonKey,
    billingCycle: prismaPkg.StorageAddonBillingCycle.ONE_TIME,
    status: prismaPkg.WorkspaceStorageAddonStatus.ACTIVE,
    paymentProvider: PROVIDER,
    externalPaymentId: captureId,
    amountCents: expectedCents,
    currency: expectedCurrency,
    metadata: { source: input.eventType },
  });
  return { outcome: "GRANTED", addonId: granted.id };
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
  /** The durable checkout attempt named in custom_id, when present. */
  attemptId: string | null;
  amountCents: number;
  currency: "USD" | "EUR";
  /**
   * BILLING PAYPAL INTEGRITY (2026-09-28) — the price THIS purchase was sold
   * at: the immutable amount on its checkout attempt. Only an order from
   * before attempts existed (no attempt in custom_id) is compared with the
   * current catalogue — and a mismatch there is sent to review, never
   * guessed.
   */
  expected: { amountCents: number; currency: string };
  /** The order holds exactly the expected amount and currency. */
  priceMatches: boolean;
};

/**
 * Identify an evidence-credit purchase from what PROOVRA itself wrote into the
 * order (`custom_id`, amount) — read back from PayPal, never from the browser.
 */
async function readCreditPurchase(unit: Json | null): Promise<CreditPurchase | null> {
  const parsed = parsePayPalCustomId(str(unit?.custom_id));
  if (!parsed.userId || parsed.plan !== prismaPkg.PlanType.PAYG) return null;

  const amount = rec(unit?.amount);
  const rawCurrency = str(amount?.currency_code)?.toUpperCase() ?? "";
  const cents = centsFromValue(amount?.value);
  const attemptId = parsed.attemptId ?? null;

  let expected: { amountCents: number; currency: string } | null = null;
  if (attemptId) {
    const attempt = await prisma.billingCheckoutAttempt.findUnique({
      where: { id: attemptId },
      select: { userId: true, product: true, provider: true, amountCents: true, currency: true },
    });
    if (
      attempt &&
      attempt.userId === parsed.userId &&
      attempt.product === prismaPkg.BillingCheckoutProduct.EVIDENCE_CREDIT &&
      attempt.provider === PROVIDER
    ) {
      expected = { amountCents: attempt.amountCents, currency: attempt.currency.toUpperCase() };
    }
  }
  if (!expected) {
    const currency = normalizeBillingCurrency(rawCurrency);
    expected = { amountCents: getEvidenceCreditPriceCents(currency), currency };
  }

  return {
    userId: parsed.userId,
    attemptId,
    amountCents: cents ?? 0,
    currency: normalizeBillingCurrency(rawCurrency),
    expected,
    priceMatches:
      (rawCurrency === "USD" || rawCurrency === "EUR") &&
      cents !== null &&
      cents === expected.amountCents &&
      rawCurrency === expected.currency,
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
 * are exactly the price of the purchase attempt.
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
        : status === "REFUNDED"
          ? prismaPkg.PaymentStatus.REFUNDED
          : status === "PARTIALLY_REFUNDED"
            ? prismaPkg.PaymentStatus.SUCCEEDED
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
    product: "EVIDENCE_CREDIT",
    checkoutAttemptId: purchase.attemptId,
    providerResourceId: orderId || null,
  });

  if (status === "PENDING") {
    return { outcome: "PENDING", orderId, reason: "CAPTURE_PENDING", captureId };
  }
  if (status === "REFUNDED") {
    // A refund of a capture that may already have granted: undo it.
    await applyCreditRefund({ userId: purchase.userId, captureId, kind: "REFUNDED" });
    return { outcome: "FAILED", orderId, reason: "CAPTURE_REFUNDED", providerIssue: status, captureId };
  }
  if (status !== "COMPLETED" && status !== "PARTIALLY_REFUNDED") {
    return {
      outcome: "FAILED",
      orderId,
      reason: "CAPTURE_DECLINED",
      providerIssue: status || null,
      captureId,
    };
  }

  const captureMatchesPurchase =
    captureCents === purchase.expected.amountCents &&
    captureCurrency === purchase.expected.currency;
  if (!purchase.priceMatches || !captureMatchesPurchase) {
    // Money moved but not at this purchase's price: record the payment
    // (above), grant nothing, and send it to review — a refund may be owed.
    await recordBillingReviewItem({
      userId: purchase.userId,
      provider: PROVIDER,
      providerResourceId: captureId,
      product: "EVIDENCE_CREDIT",
      reason: "AMOUNT_MISMATCH",
      refundReviewRequired: true,
      detail: {
        orderId,
        capturedCents: captureCents,
        capturedCurrency: captureCurrency,
        expectedCents: purchase.expected.amountCents,
        expectedCurrency: purchase.expected.currency,
      },
    });
    return { outcome: "REJECTED", orderId, reason: "AMOUNT_MISMATCH" };
  }

  const credits = EVIDENCE_CREDIT_PRODUCT.creditsGrantedPerPurchase;
  const grant = await grantEvidenceCredits({
    userId: purchase.userId,
    credits,
    provider: PROVIDER,
    providerRef: captureId,
  });

  if (status === "PARTIALLY_REFUNDED") {
    // The credit is indivisible: a partial refund is sent to review rather
    // than guessed into a fraction of a credit.
    await recordBillingReviewItem({
      userId: purchase.userId,
      provider: PROVIDER,
      providerResourceId: captureId,
      product: "EVIDENCE_CREDIT",
      reason: "PARTIAL_REFUND",
      detail: { orderId },
    });
  }

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
 * `capture: true` (the authenticated return route, the CHECKOUT.ORDER.APPROVED
 * webhook, the per-attempt re-check and the sweep) captures an APPROVED
 * order; `false` (the capture webhooks) only observes. `expectedUserId` binds
 * the order to the authenticated caller — an order whose custom_id names
 * someone else is refused before anything is captured.
 */
export async function settlePayPalEvidenceCreditOrder(params: {
  orderId: string;
  expectedUserId?: string | null;
  capture: boolean;
  /** The capture a webhook is about, when it names one. */
  captureId?: string | null;
}): Promise<PayPalCreditSettlement> {
  const sink: { purchase: CreditPurchase | null; observedAtUtc: Date | null; captureAttempted?: boolean } = {
    purchase: null,
    observedAtUtc: null,
    captureAttempted: false,
  };
  let result: PayPalCreditSettlement;
  try {
    result = await settleCreditOrder(params, sink);
  } catch (err) {
    // BILLING PAYPAL INTEGRITY (2026-09-28) — the capture (or the read after
    // it) failed in a way that does NOT prove nothing was captured: a
    // timeout, a dropped connection, a 5xx. The buyer approved; money may
    // have moved. The attempt is marked CAPTURE_PENDING — "processing", never
    // abandonable — so the hourly sweep settles it through this same function
    // (PayPal's capture idempotency key makes the retry return the original
    // capture) and the credit is granted exactly once.
    if (sink.purchase && sink.captureAttempted) {
      await recordCheckoutAttemptProviderOutcome({
        provider: PROVIDER,
        userId: sink.purchase.userId,
        product: prismaPkg.BillingCheckoutProduct.EVIDENCE_CREDIT,
        providerResourceId: params.orderId,
        attemptId: sink.purchase.attemptId,
        status: prismaPkg.BillingCheckoutAttemptStatus.PENDING,
        checkoutState: "CAPTURE_PENDING",
      }).catch(() => false);
    }
    throw err;
  }
  if (sink.purchase) {
    await recordCreditAttemptOutcome({
      orderId: params.orderId,
      purchase: sink.purchase,
      result,
      observedAtUtc: sink.observedAtUtc,
    });
  }
  return result;
}

/**
 * BILLING CHECKOUT ATTEMPTS (2026-09-28) — what a credit settlement means for
 * the durable attempt that started the order. Every path that settles an
 * order (return route, both webhooks, re-check, sweep) passes through here, so
 * the attempt converges however the answer arrived.
 */
async function recordCreditAttemptOutcome(input: {
  orderId: string;
  purchase: CreditPurchase;
  result: PayPalCreditSettlement;
  observedAtUtc: Date | null;
}): Promise<void> {
  const { result } = input;
  if (!input.orderId) return;
  const A = prismaPkg.BillingCheckoutAttemptStatus;
  let status: prismaPkg.BillingCheckoutAttemptStatus;
  let checkoutState: CheckoutState;
  let providerPaymentRef: string | null = null;
  switch (result.outcome) {
    case "GRANTED":
    case "ALREADY_GRANTED":
      status = A.COMPLETED;
      checkoutState = "SETTLED";
      providerPaymentRef = result.captureId;
      break;
    case "PENDING":
      status = A.PENDING;
      checkoutState =
        result.reason === "AWAITING_APPROVAL" ? "AWAITING_CUSTOMER_APPROVAL" : "CAPTURE_PENDING";
      providerPaymentRef = result.captureId;
      break;
    case "CANCELED":
      status = A.CANCELED;
      checkoutState = "PROVIDER_CANCELED";
      break;
    case "FAILED":
      status = A.FAILED;
      checkoutState = "PAYMENT_DECLINED";
      providerPaymentRef = result.captureId;
      break;
    case "REJECTED":
      // Only an amount mismatch on a genuine credit order is the attempt's
      // business: money or approval exists that the attempt's price does not
      // match.
      if (result.reason !== "AMOUNT_MISMATCH") return;
      status = A.PENDING;
      checkoutState = "NEEDS_REVIEW";
      break;
  }
  await recordCheckoutAttemptProviderOutcome({
    provider: PROVIDER,
    userId: input.purchase.userId,
    product: prismaPkg.BillingCheckoutProduct.EVIDENCE_CREDIT,
    providerResourceId: input.orderId,
    attemptId: input.purchase.attemptId,
    status,
    checkoutState,
    observedAtUtc: input.observedAtUtc,
    providerPaymentRef,
  }).catch(() => false);
}

async function settleCreditOrder(
  params: {
    orderId: string;
    expectedUserId?: string | null;
    capture: boolean;
    captureId?: string | null;
  },
  sink: { purchase: CreditPurchase | null; observedAtUtc: Date | null; captureAttempted?: boolean },
): Promise<PayPalCreditSettlement> {
  const { orderId } = params;
  let order = rec(await getPayPalOrder(orderId));
  if (!order || str(order.id) !== orderId) {
    return { outcome: "REJECTED", orderId, reason: "MALFORMED" };
  }

  const purchase = await readCreditPurchase(firstUnit(order));
  if (!purchase) {
    return { outcome: "REJECTED", orderId, reason: "NOT_EVIDENCE_CREDIT" };
  }
  if (params.expectedUserId && purchase.userId !== params.expectedUserId) {
    return { outcome: "REJECTED", orderId, reason: "NOT_OWNED" };
  }
  sink.purchase = purchase;
  sink.observedAtUtc = dateFromIso(order.update_time ?? order.create_time);

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
      // Never take money for an amount this purchase was not sold at.
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
    sink.captureAttempted = true;
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
        // A concurrent capture (webhook, sweep or second tab) won; read its result.
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
 * A PAYMENT.CAPTURE.{COMPLETED,PENDING,DENIED,DECLINED} webhook. The resource
 * is a CAPTURE: it carries no `purchase_units`, and `custom_id` only when
 * PayPal chooses to copy it. The purchase is recovered from the related order
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
  const purchase = await readCreditPurchase(capture);
  if (!purchase || !captureId) return null;
  return applyCreditCapture({
    orderId: "",
    purchase,
    capture,
  });
}

/**
 * BILLING PAYPAL INTEGRITY (2026-09-28) — historic credit recovery by
 * POSITIVE PROOF.
 *
 * A `payments` row written before product identity existed is only treated
 * as a credit purchase when PayPal proves it: the id is a CAPTURE whose order
 * carries PROOVRA's PAYG custom_id. Then the ONE settlement path records and
 * grants it. A plan or storage renewal SALE is not a capture and is reported
 * as NOT_A_CREDIT — never "provider unavailable", never granted by amount.
 */
export async function recoverPayPalCreditFromPayment(input: {
  captureId: string;
  expectedUserId: string;
}): Promise<
  | { outcome: "SETTLED"; settlement: PayPalCreditSettlement }
  | { outcome: "NOT_A_CREDIT" }
  | { outcome: "UNKNOWN" }
> {
  let capture: Json | null;
  try {
    capture = rec(await paypalGet(`/v2/payments/captures/${encodeURIComponent(input.captureId)}`));
  } catch (err) {
    if (err instanceof PayPalHttpError && (err.status === 404 || err.status === 400 || err.status === 422)) {
      return { outcome: "NOT_A_CREDIT" };
    }
    return { outcome: "UNKNOWN" };
  }
  const orderId = str(rec(rec(capture?.supplementary_data)?.related_ids)?.order_id);
  if (!capture || str(capture.id) !== input.captureId || !orderId || !isPayPalResourceId(orderId)) {
    return { outcome: "NOT_A_CREDIT" };
  }
  try {
    const settlement = await settlePayPalEvidenceCreditOrder({
      orderId,
      expectedUserId: input.expectedUserId,
      capture: false,
      captureId: input.captureId,
    });
    if (settlement.outcome === "REJECTED" && settlement.reason !== "AMOUNT_MISMATCH") {
      return { outcome: "NOT_A_CREDIT" };
    }
    return { outcome: "SETTLED", settlement };
  } catch {
    return { outcome: "UNKNOWN" };
  }
}

// ===========================================================================
// Refunds, reversals, disputes
// ===========================================================================

/**
 * Undo a refunded/reversed CREDIT capture: the payment row reads REFUNDED and
 * the credits it granted leave the wallet (see `reverseEvidenceCreditPurchase`
 * for the policy). A shortfall — credits already spent — is sent to review.
 */
async function applyCreditRefund(input: {
  userId: string;
  captureId: string;
  kind: "REFUNDED" | "REVERSED";
}): Promise<{ reversed: boolean; shortfall: number }> {
  const reversal = await reverseEvidenceCreditPurchase({
    userId: input.userId,
    provider: PROVIDER,
    providerRef: input.captureId,
    shortfallReviewDetail: { kind: input.kind },
  });
  return { reversed: reversal.reversed, shortfall: reversal.shortfall };
}

/** The capture a refund / reversal resource is about. */
function captureIdFromRefundResource(resource: Json | null): string | null {
  const links = Array.isArray(resource?.links) ? resource.links : [];
  for (const raw of links) {
    const link = rec(raw);
    const href = str(link?.href);
    if (str(link?.rel) === "up" && href) {
      const m = href.match(/\/v2\/payments\/captures\/([A-Za-z0-9-]+)/);
      if (m) return m[1]!;
    }
  }
  // PAYMENT.CAPTURE.REVERSED carries the capture itself.
  const status = str(resource?.status)?.toUpperCase();
  if (status === "REVERSED" || status === "REFUNDED") return str(resource?.id);
  return null;
}

/** The sale a PAYMENT.SALE.REFUNDED / REVERSED resource is about. */
function saleIdFromRefundResource(resource: Json | null): string | null {
  const saleId = str(resource?.sale_id);
  if (saleId) return saleId;
  const state = (str(resource?.state) ?? str(resource?.status))?.toLowerCase();
  if (state === "reversed" || state === "refunded") return str(resource?.id);
  return null;
}

export type PayPalAdverseOutcome = {
  outcome: "APPLIED" | "UNATTRIBUTED";
  product: string | null;
};

/**
 * PAYMENT.CAPTURE.REFUNDED / PAYMENT.CAPTURE.REVERSED /
 * PAYMENT.SALE.REFUNDED / PAYMENT.SALE.REVERSED.
 *
 * POLICY
 *   * a CREDIT purchase: the payment reads REFUNDED and its credits are
 *     reversed out of the wallet (auditable REVERSAL, never deleted);
 *   * a PLAN or STORAGE payment: the payment reads REFUNDED and the case is
 *     recorded for review. Access follows the SUBSCRIPTION's own state (a
 *     merchant who refunds and cancels sends the CANCELLED event, which ends
 *     it); a refund of one renewal does not by itself end a subscription the
 *     provider still bills.
 *
 * Correlated through the stored payment row (provider + payment id), whose
 * owner is authoritative; an unknown payment is reported, never guessed.
 */
export async function applyPayPalRefundOrReversal(input: {
  eventType: string;
  resource: unknown;
}): Promise<PayPalAdverseOutcome> {
  const resource = rec(input.resource);
  const sale = input.eventType.startsWith("PAYMENT.SALE.");
  const reversed = input.eventType.endsWith(".REVERSED");
  const paymentRef = sale ? saleIdFromRefundResource(resource) : captureIdFromRefundResource(resource);
  if (!paymentRef) return { outcome: "UNATTRIBUTED", product: null };

  let payment = await prisma.payment.findUnique({
    where: { provider_providerPaymentId: { provider: PROVIDER, providerPaymentId: paymentRef } },
    select: { id: true, userId: true, product: true, amountCents: true, currency: true, providerResourceId: true },
  });

  if (!payment && !sale) {
    // A refund of a credit capture this server never recorded (its webhook
    // was lost): settle the order first, then the refund below applies.
    const owner = await recoverOwnerOfCapture(paymentRef);
    if (owner) {
      await recoverPayPalCreditFromPayment({ captureId: paymentRef, expectedUserId: owner });
      payment = await prisma.payment.findUnique({
        where: { provider_providerPaymentId: { provider: PROVIDER, providerPaymentId: paymentRef } },
        select: { id: true, userId: true, product: true, amountCents: true, currency: true, providerResourceId: true },
      });
    }
  }
  if (!payment) return { outcome: "UNATTRIBUTED", product: null };

  const isCredit =
    payment.product === "EVIDENCE_CREDIT" ||
    ((!payment.product || payment.product === "UNCLASSIFIED") &&
      (await prisma.evidenceCreditLedgerEntry.count({
        where: {
          entryType: prismaPkg.EvidenceCreditEntryType.PURCHASE,
          provider: PROVIDER,
          providerRef: paymentRef,
        },
      })) > 0);

  // BILLING REMEDIATION (2026-10-30, AUD-29) — one row per PayPal movement. Two
  // partial refunds that together return everything now add up to a refund; a
  // redelivery of either changes nothing. A refund resource that states no
  // amount, or a reversal, is the whole payment.
  const statedCents = centsFromValue(rec(resource?.amount)?.value ?? rec(resource?.amount)?.total);
  const adjustment = await applyPaymentAdjustment({
    paymentId: payment.id,
    provider: PROVIDER,
    providerAdjustmentId: str(resource?.id) ?? `${paymentRef}:${input.eventType}`,
    kind: reversed ? "REVERSAL" : "REFUND",
    amountCents: reversed ? payment.amountCents : (statedCents ?? payment.amountCents),
    currency: payment.currency,
    observedAtUtc: dateFromIso(resource?.update_time ?? resource?.create_time),
  });

  if (!adjustment.fullyRefunded) {
    await recordBillingReviewItem({
      userId: payment.userId,
      provider: PROVIDER,
      providerResourceId: paymentRef,
      product: isCredit ? "EVIDENCE_CREDIT" : payment.product === "STORAGE_ADDON" ? "STORAGE_ADDON" : "PLAN",
      reason: "PARTIAL_REFUND",
      detail: { eventType: input.eventType, refundedAmountCents: adjustment.refundedAmountCents },
    });
    return { outcome: "APPLIED", product: payment.product };
  }

  if (isCredit) {
    await applyCreditRefund({
      userId: payment.userId,
      captureId: paymentRef,
      kind: reversed ? "REVERSED" : "REFUNDED",
    });
    return { outcome: "APPLIED", product: "EVIDENCE_CREDIT" };
  }

  await recordBillingReviewItem({
    userId: payment.userId,
    provider: PROVIDER,
    providerResourceId: paymentRef,
    product: payment.product === "STORAGE_ADDON" ? "STORAGE_ADDON" : "PLAN",
    reason: "SUBSCRIPTION_PAYMENT_REVERSED",
    // A chargeback is money the merchant did not choose to return.
    refundReviewRequired: false,
    detail: { eventType: input.eventType, subscriptionId: payment.providerResourceId },
  });
  if (payment.providerResourceId && isPayPalResourceId(payment.providerResourceId)) {
    // The subscription decides access; read it now so a merchant-side
    // cancellation that accompanied the refund is applied.
    await applyPayPalSubscriptionState({
      subscriptionId: payment.providerResourceId,
      source: input.eventType,
    }).catch(() => undefined);
  }
  return { outcome: "APPLIED", product: payment.product };
}

async function recoverOwnerOfCapture(captureId: string): Promise<string | null> {
  try {
    const capture = rec(await paypalGet(`/v2/payments/captures/${encodeURIComponent(captureId)}`));
    const orderId = str(rec(rec(capture?.supplementary_data)?.related_ids)?.order_id);
    if (!orderId) return null;
    const order = rec(await getPayPalOrder(orderId));
    const parsed = parsePayPalCustomId(str(firstUnit(order)?.custom_id));
    return parsed.plan === prismaPkg.PlanType.PAYG ? parsed.userId : null;
  } catch {
    return null;
  }
}

/**
 * CUSTOMER.DISPUTE.CREATED / UPDATED / RESOLVED. A dispute changes no
 * entitlement by itself (a lost dispute arrives as a REVERSAL, which does);
 * it is recorded for review against the disputed payment.
 */
export async function applyPayPalDispute(input: {
  eventType: string;
  resource: unknown;
}): Promise<PayPalAdverseOutcome> {
  const resource = rec(input.resource);
  const disputed = Array.isArray(resource?.disputed_transactions)
    ? (resource!.disputed_transactions as unknown[]).map(rec)
    : [];
  let applied = false;
  let product: string | null = null;
  for (const tx of disputed) {
    const ref = str(tx?.seller_transaction_id);
    if (!ref) continue;
    const payment = await prisma.payment.findUnique({
      where: { provider_providerPaymentId: { provider: PROVIDER, providerPaymentId: ref } },
      select: { userId: true, product: true },
    });
    if (!payment) continue;
    product = payment.product;
    await recordBillingReviewItem({
      userId: payment.userId,
      provider: PROVIDER,
      providerResourceId: ref,
      product:
        payment.product === "EVIDENCE_CREDIT"
          ? "EVIDENCE_CREDIT"
          : payment.product === "STORAGE_ADDON"
            ? "STORAGE_ADDON"
            : "PLAN",
      reason: "PAYMENT_DISPUTED",
      detail: {
        eventType: input.eventType,
        disputeId: str(resource?.dispute_id),
        disputeStatus: str(resource?.status),
        disputeOutcome: str(rec(resource?.dispute_outcome)?.outcome_code),
      },
    });
    applied = true;
  }
  return { outcome: applied ? "APPLIED" : "UNATTRIBUTED", product };
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
 *
 * BILLING PAYPAL INTEGRITY (2026-09-28) — APPROVED ("you approved, PayPal is
 * activating") is not APPROVAL_PENDING ("you have not approved"): the return
 * page and Billing activity now say which.
 */
export type PayPalSubscriptionReturnOutcome =
  | "ACTIVE"
  | "PENDING"
  | "AWAITING_APPROVAL"
  | "PAYMENT_PROBLEM"
  | "ENDED";

function returnOutcomeFor(
  status: prismaPkg.SubscriptionStatus,
  rawStatus: string | null,
): PayPalSubscriptionReturnOutcome {
  switch (status) {
    case prismaPkg.SubscriptionStatus.ACTIVE:
      return "ACTIVE";
    case prismaPkg.SubscriptionStatus.TRIALING:
      return (rawStatus ?? "").toUpperCase() === "APPROVED" ? "PENDING" : "AWAITING_APPROVAL";
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
      /** A plan subscription that activated as a DUPLICATE and was stopped. */
      superseded?: boolean;
    }
  | {
      outcome: "REJECTED";
      subscriptionId: string;
      reason:
        | "NOT_OWNED"
        | "UNATTRIBUTABLE"
        | "PLAN_ID_MISMATCH"
        | "STORAGE_ADDON_NOT_ALLOWED"
        /** PayPal activated storage PROOVRA cannot grant; it was cancelled and sent to review. */
        | "STORAGE_ADDON_REFUSED";
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
  let liveRead = true;
  try {
    sub = rec(await getPayPalSubscription(subscriptionId));
  } catch (err) {
    if (!params.fallbackResource) throw err;
    sub = rec(params.fallbackResource);
    liveRead = false;
  }
  if (!sub || (str(sub.id) && str(sub.id) !== subscriptionId)) {
    return { outcome: "REJECTED", subscriptionId, reason: "UNATTRIBUTABLE" };
  }

  const customId = str(sub.custom_id);
  const planId = str(sub.plan_id);
  const rawStatus = str(sub.status);
  const status = parsePayPalSubscriptionStatus(rawStatus);
  const billingInfo = rec(sub.billing_info);
  const observedAtUtc = dateFromIso(
    sub.status_update_time ?? sub.update_time ?? sub.create_time,
  );

  // PRO-BL1-04 (WS-BILL) — the PAID fact, one reader for the base plan and for
  // a recurring storage add-on (DEC-02: the paid period applies to both).
  const paidFact = readPayPalSubscriptionPaidFact(billingInfo);

  // --- Storage add-on --------------------------------------------------------
  const addon = parsePayPalStorageAddonCustomId(customId);
  if (addon) {
    if (params.expectedUserId && addon.userId !== params.expectedUserId) {
      return { outcome: "REJECTED", subscriptionId, reason: "NOT_OWNED" };
    }
    // PRO-BL1-04 — the add-on follows money too. PayPal keeps it ACTIVE while
    // a payment is failing: that is PAST_DUE here (and never a first
    // activation). Its paid-through date is the last completed payment plus
    // one cycle; with no completed payment none is stated, so a cancellation
    // keeps no "paid month" (paid-period.service) for an add-on never paid for.
    const addonStatus =
      status === prismaPkg.SubscriptionStatus.ACTIVE && paidFact.paymentFailing
        ? prismaPkg.SubscriptionStatus.PAST_DUE
        : status;
    const applied = await applyStorageSubscriptionObservation({
      provider: PROVIDER,
      subscriptionId,
      status: addonStatus,
      planId,
      claimed: {
        userId: addon.userId,
        teamId: addon.teamId,
        addonKey: addon.storageAddonKey,
        attemptId: addon.attemptId ?? null,
      },
      currentPeriodEnd: paidFact.paidThroughUtc,
      // DEC-02 — ACTIVE with no completed payment is never a first activation.
      paymentProven: paidFact.paidThroughUtc !== null,
      observedAtUtc,
      source: params.source,
    });
    if (applied.outcome === "REFUSED") {
      params.log?.warn(
        { provider: "PAYPAL", subscriptionId, reason: applied.reason, canceledAtProvider: applied.canceledAtProvider },
        "paypal.storage_addon_activation_refused",
      );
      return { outcome: "REJECTED", subscriptionId, reason: "STORAGE_ADDON_REFUSED" };
    }
    if (applied.outcome === "IGNORED") {
      return {
        outcome: "REJECTED",
        subscriptionId,
        reason: applied.reason === "IDENTITY_MISMATCH" ? "NOT_OWNED" : "UNATTRIBUTABLE",
      };
    }
    return {
      outcome: "APPLIED",
      kind: "STORAGE_ADDON",
      subscriptionId,
      status: addonStatus,
      returnOutcome: returnOutcomeFor(status, rawStatus),
      plan: null,
      storageAddonKey: addon.storageAddonKey,
    };
  }

  // --- Base plan -------------------------------------------------------------
  // PRO-BL1-04 (WS-BILL, 2026-11-18) — a PAID fact, not a status label. PayPal
  // keeps a subscription ACTIVE while a renewal (or the first payment) is
  // failing and being retried, and `next_billing_time` is a date not yet paid
  // for. The entitlement and the paid-through date now follow money:
  //   * ACTIVE with failed payments or an outstanding balance is PAST_DUE, so
  //     the bounded grace applies instead of indefinite paid access;
  //   * the paid-through date is the last completed payment plus one monthly
  //     cycle; with no completed payment it is not stated (the recorded one
  //     stays), never the unpaid next billing time.
  const basePlanStatus =
    status === prismaPkg.SubscriptionStatus.ACTIVE && paidFact.paymentFailing
      ? prismaPkg.SubscriptionStatus.PAST_DUE
      : status;
  const paidThroughUtc = paidFact.paidThroughUtc;
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

  const stored = await prisma.subscription.findUnique({
    where: {
      provider_providerSubId: { provider: PROVIDER, providerSubId: subscriptionId },
    },
    select: {
      id: true,
      status: true,
      plan: true,
      pendingPlan: true,
      pendingPlanEffectiveAtUtc: true,
      pendingPlanAwaitingApproval: true,
      activatedAtUtc: true,
      currentPeriodEnd: true,
      canceledAtUtc: true,
      locallyTerminatedAtUtc: true,
      providerStateAtUtc: true,
    },
  });

  if (stored?.pendingPlan) {
    if (stored.pendingPlanAwaitingApproval && planFromPlanId === stored.pendingPlan) {
      // The buyer approved the revision: it is now a provider-confirmed
      // scheduled change.
      await markPlanChangeApproved(stored.id);
    } else if (stored.pendingPlanAwaitingApproval) {
      await expireUnapprovedPlanChange(stored.id);
    }
  }

  // A provider-confirmed SCHEDULED change (plan-transition.service records it
  // as pendingPlan) takes effect at its date, not the moment PayPal swaps the
  // plan id: the current period is paid for at the current plan.
  if (
    stored &&
    stored.pendingPlan === plan &&
    stored.plan !== plan &&
    stored.pendingPlanEffectiveAtUtc &&
    stored.pendingPlanEffectiveAtUtc.getTime() > Date.now()
  ) {
    plan = stored.plan;
  }

  // BILLING PAYPAL INTEGRITY (2026-09-28) — a checkout abandoned in PROOVRA
  // by the OLD code stamped local time into `providerStateAtUtc`, so a
  // buyer's later approval read as "older" and was discarded while PayPal
  // billed. A LIVE read of ACTIVE on such a row (CANCELED, never activated,
  // no provider period, no provider-confirmed cancellation) is PayPal's
  // current truth — PayPal never re-activates a subscription it cancelled —
  // so the local stamp is moved to where it belongs.
  if (
    liveRead &&
    status === prismaPkg.SubscriptionStatus.ACTIVE &&
    stored &&
    stored.status === prismaPkg.SubscriptionStatus.CANCELED &&
    !stored.activatedAtUtc &&
    !stored.currentPeriodEnd &&
    !stored.canceledAtUtc &&
    !stored.locallyTerminatedAtUtc &&
    stored.providerStateAtUtc
  ) {
    await reclassifyLegacyLocalTermination({
      subscriptionId: stored.id,
      localStampUtc: stored.providerStateAtUtc,
    });
  }

  // PRO-BL1-04 / DEC-02 — an ACTIVE label is not a payment. A subscription
  // that was never activated here and for which PayPal reports no completed
  // payment (none yet, or one failing) is PENDING: no entitlement, the checkout
  // attempt stays open, and the existing reconciliation path settles it — the
  // payment's own event (PAYMENT.SALE.COMPLETED re-reads this state), the
  // customer's re-check, or the sweep. A label that stays unpaid for over an
  // hour is recorded for review. A subscription already activated is not
  // un-granted by a read that merely omits the payment.
  const awaitingFirstPayment =
    !stored?.activatedAtUtc &&
    (basePlanStatus === prismaPkg.SubscriptionStatus.PAST_DUE ||
      (basePlanStatus === prismaPkg.SubscriptionStatus.ACTIVE && paidThroughUtc === null));
  const settledStatus = awaitingFirstPayment ? prismaPkg.SubscriptionStatus.TRIALING : basePlanStatus;
  if (awaitingFirstPayment) {
    await noteActiveWithoutCompletedPayment({
      userId: parsed.userId,
      provider: PROVIDER,
      providerResourceId: subscriptionId,
      product: "PLAN",
      observedAtUtc,
    });
  }

  // What PayPal bills: the configured plan's currency, and the amount of the
  // last payment PayPal reports (absent before the first charge).
  const lastPayment = rec(rec(billingInfo?.last_payment)?.amount);
  const billedCurrency =
    currencyForPayPalBasePlanId(planId) ?? str(lastPayment?.currency_code)?.toUpperCase() ?? null;
  const lastPaymentCents = centsFromValue(lastPayment?.value);
  const synced = await syncPlanForSubscription({
    userId: parsed.userId,
    plan,
    teamId: parsed.teamId,
    provider: PROVIDER,
    providerSubId: subscriptionId,
    status: settledStatus,
    currentPeriodEnd: paidThroughUtc,
    observedAtUtc,
    billedCurrency,
    billedUnitAmountCents:
      lastPaymentCents !== null &&
      str(lastPayment?.currency_code)?.toUpperCase() === billedCurrency
        ? lastPaymentCents
        : null,
  });

  await recordPlanAttemptOutcome({
    userId: parsed.userId,
    subscriptionId,
    attemptId: parsed.attemptId ?? null,
    // Awaiting its first payment: the buyer approved, PayPal is activating.
    status: awaitingFirstPayment ? prismaPkg.SubscriptionStatus.TRIALING : status,
    rawStatus: awaitingFirstPayment ? "APPROVED" : rawStatus,
    observedAtUtc,
  });

  return {
    outcome: "APPLIED",
    kind: "PLAN",
    subscriptionId,
    status: awaitingFirstPayment ? prismaPkg.SubscriptionStatus.TRIALING : status,
    returnOutcome: awaitingFirstPayment ? "PENDING" : returnOutcomeFor(status, rawStatus),
    plan,
    storageAddonKey: null,
    ...(synced.outcome === "SUPERSEDED" ? { superseded: true } : {}),
  };
}

/**
 * BILLING CHECKOUT ATTEMPTS (2026-09-28) — a base-plan subscription's state,
 * as it concerns the checkout attempt that created it.
 *
 * Only the ATTEMPT is described here: ACTIVE completes it; APPROVAL_PENDING
 * keeps it awaiting the customer; APPROVED (buyer consented, PayPal
 * activating) is recorded as such — it is not abandonable; CANCELLED/EXPIRED
 * before activation end it. A later cancellation of an already-completed
 * attempt is subscription lifecycle, not checkout, and the monotonic
 * transition rule ignores it.
 */
async function recordPlanAttemptOutcome(input: {
  userId: string;
  subscriptionId: string;
  attemptId: string | null;
  status: prismaPkg.SubscriptionStatus;
  rawStatus: string | null;
  observedAtUtc: Date | null;
}): Promise<void> {
  const A = prismaPkg.BillingCheckoutAttemptStatus;
  const raw = (input.rawStatus ?? "").toUpperCase();
  let status: prismaPkg.BillingCheckoutAttemptStatus;
  let checkoutState: CheckoutState;
  switch (input.status) {
    case prismaPkg.SubscriptionStatus.ACTIVE:
      status = A.COMPLETED;
      checkoutState = "SETTLED";
      break;
    case prismaPkg.SubscriptionStatus.TRIALING:
      status = A.PENDING;
      checkoutState = raw === "APPROVED" ? "APPROVED_AWAITING_ACTIVATION" : "AWAITING_CUSTOMER_APPROVAL";
      break;
    case prismaPkg.SubscriptionStatus.PAST_DUE:
      status = A.FAILED;
      checkoutState = "PAYMENT_DECLINED";
      break;
    default:
      status = raw === "EXPIRED" ? A.EXPIRED : A.CANCELED;
      checkoutState = raw === "EXPIRED" ? "PROVIDER_EXPIRED" : "PROVIDER_CANCELED";
  }
  await recordCheckoutAttemptProviderOutcome({
    provider: PROVIDER,
    userId: input.userId,
    product: prismaPkg.BillingCheckoutProduct.PLAN,
    providerResourceId: input.subscriptionId,
    attemptId: input.attemptId,
    status,
    checkoutState,
    observedAtUtc: input.observedAtUtc,
  }).catch(() => false);
}
