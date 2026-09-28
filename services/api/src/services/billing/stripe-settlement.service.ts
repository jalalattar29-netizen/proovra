/**
 * STRIPE SETTLEMENT (2026-09-28) — the ONE place a Stripe Checkout Session
 * becomes a commercial consequence, shared by the verified webhook
 * (`checkout.session.completed`) and provider-first recovery (re-check).
 *
 * WHY IT MOVED OUT OF THE WEBHOOK
 * ---------------------------------------------------------------------------
 * The session handler lived inline in `webhooks.routes.ts`, so a completed
 * session whose webhook was lost could not be applied by anything else: the
 * account re-check could only look at `payments` rows the webhook would have
 * written. Recovery now reads the session live from Stripe and hands it to
 * this same function.
 *
 * WHAT CHANGED IN THE RULES
 * ---------------------------------------------------------------------------
 *   * Credits are granted only when Stripe reports `payment_status: "paid"`
 *     AND the amount/currency are the server price. Before, any completed
 *     session granted, whatever it said it had collected.
 *   * A plan session's subscription is applied through
 *     `syncPlanForSubscription` from the LIVE subscription (recovery only; the
 *     webhook keeps doing it from `customer.subscription.*`).
 *   * The durable checkout attempt that started the session is updated.
 */

import * as prismaPkg from "@prisma/client";
import { EVIDENCE_CREDIT_PRODUCT } from "@proovra/shared-billing";

import {
  ensureEntitlement,
  recordPayment,
  upsertWorkspaceStorageAddon,
} from "../billing.service.js";
import { getEvidenceCreditPriceCents } from "../billing-pricing.service.js";
import { stripeGet } from "../stripe.service.js";
import {
  recordCheckoutAttemptProviderOutcome,
  type CheckoutState,
} from "./checkout-attempts.service.js";
import { grantEvidenceCredits } from "./evidence-credits.service.js";
import { assertWebhookStorageAddonAllowed } from "./paypal-settlement.service.js";
import { syncPlanForSubscription } from "./subscription-lifecycle.handlers.js";

const STRIPE = prismaPkg.PaymentProvider.STRIPE;

export function parsePlan(value: unknown): prismaPkg.PlanType | null {
  return value === prismaPkg.PlanType.FREE ||
    value === prismaPkg.PlanType.PAYG ||
    value === prismaPkg.PlanType.PRO ||
    value === prismaPkg.PlanType.TEAM
    ? value
    : null;
}

export function parseStorageAddonKey(value: unknown): prismaPkg.StorageAddonKey | null {
  return typeof value === "string" &&
    (Object.values(prismaPkg.StorageAddonKey) as string[]).includes(value)
    ? (value as prismaPkg.StorageAddonKey)
    : null;
}

/**
 * BOTH cycles. This returned null for MONTHLY, and the subscription-lifecycle
 * webhook skips a null cycle — so every renewal, payment failure and
 * cancellation of a Stripe monthly storage add-on was silently dropped.
 */
export function parseStorageAddonBillingCycle(
  value: unknown,
): prismaPkg.StorageAddonBillingCycle | null {
  if (value === prismaPkg.StorageAddonBillingCycle.ONE_TIME) return value;
  if (value === prismaPkg.StorageAddonBillingCycle.MONTHLY) return value;
  return null;
}

export function parseStripeSubscriptionStatus(status?: string | null): prismaPkg.SubscriptionStatus {
  const normalized = (status ?? "").trim().toLowerCase();
  if (normalized === "active") return prismaPkg.SubscriptionStatus.ACTIVE;
  if (normalized === "trialing") return prismaPkg.SubscriptionStatus.TRIALING;
  if (normalized === "past_due" || normalized === "unpaid") return prismaPkg.SubscriptionStatus.PAST_DUE;
  return prismaPkg.SubscriptionStatus.CANCELED;
}

export function dateFromUnixSeconds(value: unknown): Date | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return new Date(value * 1000);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type StripeCheckoutSession = {
  id: string;
  subscription?: string | null;
  mode?: string;
  status?: string | null;
  payment_status?: string | null;
  amount_total?: number | null;
  currency?: string | null;
  client_reference_id?: string | null;
  created?: number;
  metadata?: Record<string, string | undefined> | null;
};

export type StripeSessionSettlement = {
  product: "EVIDENCE_CREDIT" | "STORAGE_ADDON" | "PLAN" | "UNKNOWN";
  outcome: "GRANTED" | "ALREADY_GRANTED" | "APPLIED" | "PENDING" | "EXPIRED" | "REJECTED" | "IGNORED";
  reason?: string;
};

function attemptIdOf(session: StripeCheckoutSession): string | null {
  const id = session.metadata?.attemptId ?? session.client_reference_id ?? null;
  return id && UUID_RE.test(id) ? id : null;
}

/** Record what a session means for the durable attempt that started it. */
export async function recordStripeSessionAttemptOutcome(input: {
  session: StripeCheckoutSession;
  userId: string;
  product: prismaPkg.BillingCheckoutProduct;
  status: prismaPkg.BillingCheckoutAttemptStatus;
  checkoutState: CheckoutState;
}): Promise<void> {
  await recordCheckoutAttemptProviderOutcome({
    provider: STRIPE,
    userId: input.userId,
    product: input.product,
    providerResourceId: input.session.id,
    attemptId: attemptIdOf(input.session),
    status: input.status,
    checkoutState: input.checkoutState,
    observedAtUtc: dateFromUnixSeconds(input.session.created) ?? null,
    providerPaymentRef: input.session.id,
  }).catch(() => false);
}

/**
 * Apply ONE Checkout Session. Idempotent: credits and payments are keyed by
 * the session id, storage by the subscription id, plans by the subscription.
 */
export async function settleStripeCheckoutSession(input: {
  session: StripeCheckoutSession;
  /** Binds the session to the caller (recovery); omitted by the webhook. */
  expectedUserId?: string | null;
  /** Recovery also applies a PLAN session's subscription from Stripe. */
  applyPlanSubscription?: boolean;
  log?: { warn: (obj: unknown, msg: string) => void };
}): Promise<StripeSessionSettlement> {
  const { session } = input;
  const meta = session.metadata ?? {};
  const userId = meta.userId ?? null;
  if (!userId) return { product: "UNKNOWN", outcome: "IGNORED", reason: "NO_SUBJECT" };
  if (input.expectedUserId && userId !== input.expectedUserId) {
    return { product: "UNKNOWN", outcome: "REJECTED", reason: "NOT_OWNED" };
  }

  const plan = parsePlan(meta.plan);
  const storageAddonKey = parseStorageAddonKey(meta.storageAddonKey);
  const isCredit = meta.productKey === "EVIDENCE_CREDIT" || plan === prismaPkg.PlanType.PAYG;
  const product: StripeSessionSettlement["product"] = isCredit
    ? "EVIDENCE_CREDIT"
    : storageAddonKey
      ? "STORAGE_ADDON"
      : plan
        ? "PLAN"
        : "UNKNOWN";
  const attemptProduct =
    product === "EVIDENCE_CREDIT"
      ? prismaPkg.BillingCheckoutProduct.EVIDENCE_CREDIT
      : product === "STORAGE_ADDON"
        ? prismaPkg.BillingCheckoutProduct.STORAGE_ADDON
        : prismaPkg.BillingCheckoutProduct.PLAN;
  const A = prismaPkg.BillingCheckoutAttemptStatus;

  const status = (session.status ?? "").toLowerCase();
  const paymentStatus = (session.payment_status ?? "").toLowerCase();
  const paid = paymentStatus === "paid";

  if (status === "expired") {
    await recordStripeSessionAttemptOutcome({ session, userId, product: attemptProduct, status: A.EXPIRED, checkoutState: "PROVIDER_EXPIRED" });
    return { product, outcome: "EXPIRED" };
  }
  if (status === "open") {
    await recordStripeSessionAttemptOutcome({ session, userId, product: attemptProduct, status: A.PENDING, checkoutState: "AWAITING_CUSTOMER_APPROVAL" });
    return { product, outcome: "PENDING", reason: "AWAITING_PAYMENT_PAGE" };
  }
  if (!paid) {
    // Completed without payment (an asynchronous method still settling).
    await recordStripeSessionAttemptOutcome({ session, userId, product: attemptProduct, status: A.PENDING, checkoutState: "CAPTURE_PENDING" });
    return { product, outcome: "PENDING", reason: "PAYMENT_NOT_SETTLED" };
  }

  const currency = (session.currency ?? meta.currency ?? "usd").toUpperCase();
  const amountCents = session.amount_total ?? 0;

  if (product === "EVIDENCE_CREDIT") {
    await ensureEntitlement(userId);
    await recordPayment({
      userId,
      provider: STRIPE,
      providerPaymentId: session.id,
      amountCents,
      currency,
      status: prismaPkg.PaymentStatus.SUCCEEDED,
      teamId: null,
    });
    const priceMatches =
      (currency === "USD" || currency === "EUR") &&
      amountCents === getEvidenceCreditPriceCents(currency);
    if (!priceMatches) {
      input.log?.warn({ provider: "STRIPE", sessionId: session.id }, "stripe.credit_amount_mismatch");
      await recordStripeSessionAttemptOutcome({ session, userId, product: attemptProduct, status: A.PENDING, checkoutState: "NEEDS_REVIEW" });
      return { product, outcome: "REJECTED", reason: "AMOUNT_MISMATCH" };
    }
    const grant = await grantEvidenceCredits({
      userId,
      credits: EVIDENCE_CREDIT_PRODUCT.creditsGrantedPerPurchase,
      provider: STRIPE,
      providerRef: session.id,
    });
    await recordStripeSessionAttemptOutcome({ session, userId, product: attemptProduct, status: A.COMPLETED, checkoutState: "SETTLED" });
    return { product, outcome: grant.granted ? "GRANTED" : "ALREADY_GRANTED" };
  }

  if (product === "STORAGE_ADDON" && storageAddonKey) {
    const teamId = meta.teamId ?? null;
    try {
      await assertWebhookStorageAddonAllowed({ userId, addonKey: storageAddonKey, teamId });
    } catch (err) {
      input.log?.warn({ err, provider: "STRIPE", sessionId: session.id }, "stripe.storage_addon_checkout_ignored");
      return { product, outcome: "REJECTED", reason: "STORAGE_ADDON_NOT_ALLOWED" };
    }
    await recordPayment({
      userId,
      provider: STRIPE,
      providerPaymentId: session.id,
      amountCents,
      currency,
      status: prismaPkg.PaymentStatus.SUCCEEDED,
      teamId,
    });
    if (!session.subscription) {
      input.log?.warn({ provider: "STRIPE", sessionId: session.id }, "stripe.storage_addon_checkout_without_subscription_ignored");
      return { product, outcome: "IGNORED", reason: "NO_SUBSCRIPTION" };
    }
    await upsertWorkspaceStorageAddon({
      ownerUserId: userId,
      teamId,
      addonKey: storageAddonKey,
      billingCycle:
        parseStorageAddonBillingCycle(meta.billingCycle) ?? prismaPkg.StorageAddonBillingCycle.MONTHLY,
      status: prismaPkg.WorkspaceStorageAddonStatus.ACTIVE,
      paymentProvider: STRIPE,
      externalSubscriptionId: String(session.subscription),
      externalPaymentId: session.id,
      amountCents,
      currency,
      metadata: { source: "stripe.checkout.session.completed", mode: session.mode ?? null },
    });
    await recordStripeSessionAttemptOutcome({ session, userId, product: attemptProduct, status: A.COMPLETED, checkoutState: "SETTLED" });
    return { product, outcome: "APPLIED" };
  }

  if (product === "PLAN" && plan) {
    if (input.applyPlanSubscription && session.subscription) {
      const sub = (await stripeGet(`/subscriptions/${encodeURIComponent(String(session.subscription))}`)) as {
        id?: string;
        status?: string;
        current_period_end?: number;
        currency?: string;
        items?: { data?: Array<{ price?: { unit_amount?: number | null } }> };
        metadata?: Record<string, string | undefined>;
      };
      if (sub.id === session.subscription && (sub.metadata?.userId ?? userId) === userId) {
        await syncPlanForSubscription({
          userId,
          plan: parsePlan(sub.metadata?.plan) ?? plan,
          teamId: sub.metadata?.teamId ?? null,
          provider: STRIPE,
          providerSubId: sub.id,
          status: parseStripeSubscriptionStatus(sub.status),
          currentPeriodEnd: dateFromUnixSeconds(sub.current_period_end),
          billedCurrency: sub.currency ? sub.currency.toUpperCase() : null,
          billedUnitAmountCents:
            typeof sub.items?.data?.[0]?.price?.unit_amount === "number"
              ? sub.items.data[0].price.unit_amount
              : null,
        });
      }
    }
    await recordStripeSessionAttemptOutcome({ session, userId, product: attemptProduct, status: A.COMPLETED, checkoutState: "SETTLED" });
    return { product, outcome: "APPLIED" };
  }

  return { product, outcome: "IGNORED", reason: "UNRECOGNISED_PRODUCT" };
}
