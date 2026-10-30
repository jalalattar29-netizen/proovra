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

import { ensureEntitlement, recordPayment } from "../billing.service.js";
import { getEvidenceCreditPriceCents, planFromStripePriceId } from "../billing-pricing.service.js";
import { stripeGet } from "../stripe.service.js";
import { applyPaymentAdjustment } from "./payment-adjustments.service.js";
import {
  stripeSubscriptionEnding,
  stripeSubscriptionPeriodEnd,
  stripeSubscriptionPriceId,
  stripeSubscriptionScheduleId,
  stripeSubscriptionUnitAmount,
  type StripeSubscriptionLike,
} from "./stripe-object-shapes.js";
import {
  recordCheckoutAttemptProviderOutcome,
  type CheckoutState,
} from "./checkout-attempts.service.js";
import { grantEvidenceCredits, reverseEvidenceCreditPurchase } from "./evidence-credits.service.js";
import { recordBillingReviewItem } from "./billing-review.service.js";
import { applyStorageSubscriptionObservation } from "./storage-activation.service.js";
import { prisma } from "../../db.js";
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

/**
 * Stripe's subscription status as the canonical status, or null for a word this
 * version does not know.
 *
 * BILLING REMEDIATION (2026-10-30, AUD-02) — `incomplete` is NOT an ending. It
 * is what every subscription that needs immediate payment is born as, moving to
 * `active` on payment; it mapped to CANCELED, so paying depended on the ACTIVE
 * event beating a same-second tie. It is now pending: it grants nothing and takes
 * nothing away. An unknown status used to mean CANCELED too, which is the one
 * disposition that removes paid access on a word nobody read.
 */
export function parseStripeSubscriptionStatus(status?: string | null): prismaPkg.SubscriptionStatus | null {
  switch ((status ?? "").trim().toLowerCase()) {
    case "active":
      return prismaPkg.SubscriptionStatus.ACTIVE;
    case "trialing":
    case "incomplete":
      return prismaPkg.SubscriptionStatus.TRIALING;
    case "past_due":
    case "unpaid":
    case "paused":
      return prismaPkg.SubscriptionStatus.PAST_DUE;
    case "canceled":
    case "incomplete_expired":
      return prismaPkg.SubscriptionStatus.CANCELED;
    default:
      return null;
  }
}

export type StripeSubscriptionFactOutcome =
  | { outcome: "APPLIED"; kind: "PLAN" | "STORAGE_ADDON" }
  | { outcome: "IGNORED"; reason: "UNKNOWN_STATUS" | "UNATTRIBUTED" };

/**
 * Apply ONE Stripe subscription object. The ONE reading of "what this subscription
 * is", shared by the webhook, recovery and the plan change that reads it back.
 *
 * The plan comes from the PRICE Stripe bills (AUD-01): a scheduled downgrade
 * changes the price at the phase boundary whether or not metadata moved. Metadata
 * is the fallback for a grandfathered price this deployment no longer maps, and
 * the stored row the fallback for an object carrying neither.
 */
export async function applyStripeSubscriptionObject(input: {
  subscription: StripeSubscriptionLike;
  observedAtUtc: Date | null;
  source: string;
}): Promise<StripeSubscriptionFactOutcome> {
  const { subscription } = input;
  const status = parseStripeSubscriptionStatus(subscription.status);
  if (!status) return { outcome: "IGNORED", reason: "UNKNOWN_STATUS" };

  const meta = subscription.metadata ?? {};
  const storageAddonKey = parseStorageAddonKey(meta.storageAddonKey);
  const currentPeriodEnd = stripeSubscriptionPeriodEnd(subscription);

  if (storageAddonKey) {
    if (!meta.userId || parseStorageAddonBillingCycle(meta.billingCycle) === null) {
      return { outcome: "IGNORED", reason: "UNATTRIBUTED" };
    }
    await applyStorageSubscriptionObservation({
      provider: STRIPE,
      subscriptionId: subscription.id,
      status,
      planId: null,
      claimed: {
        userId: meta.userId,
        teamId: meta.teamId ?? null,
        addonKey: storageAddonKey,
        attemptId: null,
      },
      currentPeriodEnd,
      observedAtUtc: input.observedAtUtc,
      source: input.source,
    });
    return { outcome: "APPLIED", kind: "STORAGE_ADDON" };
  }

  const stored = await prisma.subscription.findUnique({
    where: { provider_providerSubId: { provider: STRIPE, providerSubId: subscription.id } },
    select: { userId: true, teamId: true, plan: true },
  });
  const userId = stored?.userId ?? meta.userId ?? null;
  const plan = planFromStripePriceId(stripeSubscriptionPriceId(subscription)) ?? parsePlan(meta.plan) ?? stored?.plan ?? null;
  if (!userId || !plan) return { outcome: "IGNORED", reason: "UNATTRIBUTED" };

  await syncPlanForSubscription({
    userId,
    plan,
    teamId: stored ? stored.teamId : (meta.teamId ?? null),
    provider: STRIPE,
    providerSubId: subscription.id,
    status,
    currentPeriodEnd,
    observedAtUtc: input.observedAtUtc,
    // What Stripe bills: the subscription's currency and its price's unit
    // amount — provider facts, never the display currency.
    billedCurrency: subscription.currency ? subscription.currency.toUpperCase() : null,
    billedUnitAmountCents: stripeSubscriptionUnitAmount(subscription),
    cancelAtPeriodEnd: stripeSubscriptionEnding(subscription),
    providerScheduleId: stripeSubscriptionScheduleId(subscription),
  });
  return { outcome: "APPLIED", kind: "PLAN" };
}

/**
 * One `customer.subscription.*` delivery.
 *
 * BILLING REMEDIATION (2026-10-30, AUD-02) — Stripe does not deliver in order and
 * says `created` must not be used to order events: it has whole-second resolution,
 * and two events of one Checkout can share it. So an event no later than what is
 * recorded proves nothing either way, and is not decided here: Stripe's current
 * state is read and applied instead. Refusing it could leave a paid plan on Free;
 * accepting it could resurrect a cancelled one. A read failure propagates, so the
 * delivery fails and Stripe retries it rather than the fact being lost.
 */
export async function applyStripeSubscriptionEvent(input: {
  subscription: StripeSubscriptionLike;
  eventCreatedAtUtc: Date | null;
  source: string;
}): Promise<StripeSubscriptionFactOutcome> {
  const { subscription, eventCreatedAtUtc } = input;
  const [plan, addon] = await Promise.all([
    prisma.subscription.findUnique({
      where: { provider_providerSubId: { provider: STRIPE, providerSubId: subscription.id } },
      select: { providerStateAtUtc: true },
    }),
    prisma.workspaceStorageAddon.findUnique({
      where: { externalSubscriptionId: subscription.id },
      select: { providerStateAtUtc: true },
    }),
  ]);
  const recorded = plan?.providerStateAtUtc ?? addon?.providerStateAtUtc ?? null;
  const undecided =
    !eventCreatedAtUtc ||
    parseStripeSubscriptionStatus(subscription.status) === null ||
    (recorded !== null && eventCreatedAtUtc.getTime() <= recorded.getTime());
  if (undecided && (recorded !== null || !eventCreatedAtUtc)) {
    return applyLiveStripeSubscription(subscription.id, input.source);
  }
  return applyStripeSubscriptionObject({ subscription, observedAtUtc: eventCreatedAtUtc, source: input.source });
}

/** Read one subscription live and apply it: a read is ordered by when we made it. */
export async function applyLiveStripeSubscription(
  subscriptionId: string,
  source: string,
): Promise<StripeSubscriptionFactOutcome> {
  const readAtUtc = new Date();
  const subscription = (await stripeGet(
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
  )) as StripeSubscriptionLike;
  return applyStripeSubscriptionObject({ subscription, observedAtUtc: readAtUtc, source });
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

function attemptIdFrom(value: string | null | undefined): string | null {
  return value && UUID_RE.test(value) ? value : null;
}

/** The immutable price of the credit attempt, or the catalogue for a pre-attempt session. */
async function expectedStripeCreditPrice(
  userId: string,
  attemptId: string | null,
  currency: string,
): Promise<{ amountCents: number; currency: string }> {
  if (attemptId) {
    const attempt = await prisma.billingCheckoutAttempt.findUnique({
      where: { id: attemptId },
      select: { userId: true, product: true, provider: true, amountCents: true, currency: true },
    });
    if (
      attempt &&
      attempt.userId === userId &&
      attempt.product === prismaPkg.BillingCheckoutProduct.EVIDENCE_CREDIT &&
      attempt.provider === STRIPE
    ) {
      return { amountCents: attempt.amountCents, currency: attempt.currency.toUpperCase() };
    }
  }
  const c = currency === "EUR" ? "EUR" : "USD";
  return { amountCents: getEvidenceCreditPriceCents(c), currency: c };
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
      product: "EVIDENCE_CREDIT",
      checkoutAttemptId: attemptIdFrom(meta.attemptId),
      providerResourceId: session.id,
    });
    // BILLING PAYPAL INTEGRITY (2026-09-28) — compared with the price of THIS
    // purchase (its immutable attempt), not a catalogue price that may have
    // changed while the payment settled. Only a session from before attempts
    // existed falls back to the current catalogue, and a mismatch goes to
    // review, never granted.
    const expected = await expectedStripeCreditPrice(userId, attemptIdFrom(meta.attemptId), currency);
    const priceMatches =
      (currency === "USD" || currency === "EUR") &&
      currency === expected.currency &&
      amountCents === expected.amountCents;
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
    if (!session.subscription) {
      input.log?.warn({ provider: "STRIPE", sessionId: session.id }, "stripe.storage_addon_checkout_without_subscription_ignored");
      return { product, outcome: "IGNORED", reason: "NO_SUBSCRIPTION" };
    }
    // BILLING REMEDIATION (2026-10-30, AUD-07) — no payment row here. A
    // subscription-mode session is paid by its first INVOICE, and that invoice
    // writes the payment, as it does for a plan. Writing one here too counted
    // one charge twice in history and revenue.
    // BILLING PAYPAL INTEGRITY (2026-09-28) — the ONE storage activation
    // decision, shared with the PayPal webhook, return, re-check and sweep.
    const applied = await applyStorageSubscriptionObservation({
      provider: STRIPE,
      subscriptionId: String(session.subscription),
      status: prismaPkg.SubscriptionStatus.ACTIVE,
      planId: null,
      claimed: { userId, teamId, addonKey: storageAddonKey, attemptId: null },
      currentPeriodEnd: null,
      observedAtUtc: null,
      source: "stripe.checkout.session.completed",
      externalPaymentId: session.id,
    });
    if (applied.outcome === "REFUSED" || applied.outcome === "IGNORED") {
      input.log?.warn({ provider: "STRIPE", sessionId: session.id, outcome: applied.outcome }, "stripe.storage_addon_checkout_refused");
      await recordStripeSessionAttemptOutcome({ session, userId, product: attemptProduct, status: A.FAILED, checkoutState: "PAYMENT_DECLINED" });
      return { product, outcome: "REJECTED", reason: "STORAGE_ADDON_NOT_ALLOWED" };
    }
    await recordStripeSessionAttemptOutcome({ session, userId, product: attemptProduct, status: A.COMPLETED, checkoutState: "SETTLED" });
    return { product, outcome: "APPLIED" };
  }

  if (product === "PLAN" && plan) {
    // BILLING REMEDIATION (2026-10-30, AUD-02) — a paid session is positive proof
    // the plan was bought, so it is applied from the LIVE subscription on every
    // path, the webhook included. The webhook used to mark the attempt SETTLED
    // and rely on `customer.subscription.*` alone, so an ordering loss there
    // left a paying customer on FREE with nothing left to repair it.
    if (session.subscription) {
      const subscriptionId = String(session.subscription);
      const readAtUtc = new Date();
      const sub = (await stripeGet(`/subscriptions/${encodeURIComponent(subscriptionId)}`)) as StripeSubscriptionLike;
      if (sub.id === subscriptionId && (sub.metadata?.userId ?? userId) === userId) {
        await applyStripeSubscriptionObject({
          subscription: { ...sub, metadata: { ...sub.metadata, userId, plan: sub.metadata?.plan ?? plan } },
          observedAtUtc: readAtUtc,
          source: "stripe.checkout.session.completed",
        });
      }
    }
    await recordStripeSessionAttemptOutcome({ session, userId, product: attemptProduct, status: A.COMPLETED, checkoutState: "SETTLED" });
    return { product, outcome: "APPLIED" };
  }

  return { product, outcome: "IGNORED", reason: "UNRECOGNISED_PRODUCT" };
}

// ===========================================================================
// ET-COM-03 — Stripe refunds and lost disputes
// ===========================================================================

export type StripeAdverseOutcome =
  | { outcome: "APPLIED"; product: string | null; reversed?: boolean }
  | { outcome: "IGNORED"; reason: string }
  | { outcome: "UNATTRIBUTED" };

type StripeChargeLike = {
  id?: string;
  payment_intent?: string | null;
  amount?: number;
  amount_refunded?: number;
  refunded?: boolean;
  currency?: string;
  created?: number;
};
type StripeDisputeLike = {
  id?: string;
  status?: string;
  amount?: number;
  currency?: string;
  payment_intent?: string | null;
};

const ADVERSE_PAYMENT_SELECT = {
  id: true,
  userId: true,
  product: true,
  amountCents: true,
  currency: true,
  providerPaymentId: true,
  providerResourceId: true,
} as const;

/**
 * The stored payment a Stripe charge paid for. Two shapes: a credit purchase is
 * keyed by its Checkout Session, a subscription payment by its invoice. Neither
 * is on the charge at this API version (`Charge.invoice` is gone), so Stripe is
 * asked for the link rather than an amount or a guess being used.
 */
async function findStripePaymentForIntent(paymentIntentId: string) {
  const byRef = (providerPaymentId: string) =>
    prisma.payment.findUnique({
      where: { provider_providerPaymentId: { provider: STRIPE, providerPaymentId } },
      select: ADVERSE_PAYMENT_SELECT,
    });
  const invoices = (await stripeGet(
    `/invoice_payments?payment[type]=payment_intent&payment[payment_intent]=${encodeURIComponent(paymentIntentId)}&limit=1`,
  )) as { data?: Array<{ invoice?: string }> };
  const invoiceId = invoices.data?.[0]?.invoice;
  if (invoiceId) {
    const payment = await byRef(invoiceId);
    if (payment) return payment;
  }
  const sessions = (await stripeGet(
    `/checkout/sessions?payment_intent=${encodeURIComponent(paymentIntentId)}&limit=1`,
  )) as { data?: Array<{ id?: string }> };
  const sessionId = sessions.data?.[0]?.id;
  return sessionId ? byRef(sessionId) : null;
}

function reviewProduct(product: string | null): "EVIDENCE_CREDIT" | "STORAGE_ADDON" | "PLAN" {
  return product === "EVIDENCE_CREDIT" ? "EVIDENCE_CREDIT" : product === "STORAGE_ADDON" ? "STORAGE_ADDON" : "PLAN";
}

/**
 * Refunds and disputes of any Stripe payment.
 *
 * BILLING REMEDIATION (2026-10-30, AUD-05) — this used to read credit purchases
 * only, by Checkout Session. A refunded or charged-back plan or storage invoice
 * changed nothing and told nobody, so revenue stayed overstated and no operator
 * saw it. It now mirrors PayPal:
 *
 *   * every movement is recorded on the payment (`applyPaymentAdjustment`):
 *     partial refunds add up, a redelivery is a no-op, and the row reads REFUNDED
 *     only when all of it came back;
 *   * a credit purchase gives its credit back only when fully refunded, because
 *     a credit is indivisible; a partial refund goes to review;
 *   * a plan or storage payment goes to review. Access keeps following the
 *     subscription's own state, read now in case the merchant cancelled it too.
 *
 * A dispute changes no entitlement while open. A lost one is a REVERSAL.
 */
export async function applyStripeChargeAdverseEvent(input: {
  eventType: string;
  object: unknown;
  log?: { warn: (obj: object, msg: string) => void };
}): Promise<StripeAdverseOutcome> {
  if (input.eventType === "charge.refunded") {
    const charge = (input.object ?? {}) as StripeChargeLike;
    const paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : null;
    if (!paymentIntentId || !charge.id) return { outcome: "UNATTRIBUTED" };
    const payment = await findStripePaymentForIntent(paymentIntentId);
    if (!payment) return { outcome: "UNATTRIBUTED" };
    const adjustment = await applyPaymentAdjustment({
      paymentId: payment.id,
      provider: STRIPE,
      providerAdjustmentId: `${charge.id}:refunded:${charge.amount_refunded ?? 0}`,
      kind: "REFUND",
      cumulativeCents: charge.amount_refunded ?? 0,
      currency: (charge.currency ?? payment.currency).toUpperCase(),
    });
    return settleStripeAdjustment(payment, adjustment, "REFUNDED", input.eventType);
  }

  if (input.eventType === "charge.dispute.created" || input.eventType === "charge.dispute.closed") {
    const dispute = (input.object ?? {}) as StripeDisputeLike;
    const paymentIntentId = typeof dispute.payment_intent === "string" ? dispute.payment_intent : null;
    if (!paymentIntentId || !dispute.id) return { outcome: "UNATTRIBUTED" };
    const payment = await findStripePaymentForIntent(paymentIntentId);
    if (!payment) return { outcome: "UNATTRIBUTED" };
    const lost = dispute.status === "lost";
    const won = dispute.status === "won";
    await prisma.payment.update({
      where: { id: payment.id },
      data: { disputeStatus: lost ? "LOST" : won ? "WON" : "OPEN" },
    });
    await recordBillingReviewItem({
      userId: payment.userId,
      provider: STRIPE,
      providerResourceId: payment.providerPaymentId,
      product: reviewProduct(payment.product),
      reason: "PAYMENT_DISPUTED",
      detail: { eventType: input.eventType, disputeId: dispute.id, disputeStatus: dispute.status ?? null },
    });
    if (!lost) return { outcome: "APPLIED", product: payment.product, reversed: false };
    const adjustment = await applyPaymentAdjustment({
      paymentId: payment.id,
      provider: STRIPE,
      providerAdjustmentId: `${dispute.id}:lost`,
      kind: "REVERSAL",
      amountCents: dispute.amount ?? payment.amountCents,
      currency: (dispute.currency ?? payment.currency).toUpperCase(),
    });
    return settleStripeAdjustment(payment, adjustment, "DISPUTE_LOST", input.eventType);
  }

  return { outcome: "IGNORED", reason: "UNHANDLED_EVENT" };
}

async function settleStripeAdjustment(
  payment: {
    userId: string;
    product: string | null;
    providerPaymentId: string;
    providerResourceId: string | null;
  },
  adjustment: Awaited<ReturnType<typeof applyPaymentAdjustment>>,
  kind: "REFUNDED" | "DISPUTE_LOST",
  eventType: string,
): Promise<StripeAdverseOutcome> {
  const product = reviewProduct(payment.product);

  if (payment.product === "EVIDENCE_CREDIT") {
    if (!adjustment.fullyRefunded) {
      await recordBillingReviewItem({
        userId: payment.userId,
        provider: STRIPE,
        providerResourceId: payment.providerPaymentId,
        product,
        reason: "PARTIAL_REFUND",
        detail: { eventType, refundedAmountCents: adjustment.refundedAmountCents },
      });
      return { outcome: "APPLIED", product: payment.product, reversed: false };
    }
    // The reversal and its review commit together; see the service.
    const reversal = await reverseEvidenceCreditPurchase({
      userId: payment.userId,
      provider: STRIPE,
      providerRef: payment.providerPaymentId,
      shortfallReviewDetail: { kind },
    });
    return { outcome: "APPLIED", product: payment.product, reversed: reversal.reversed };
  }

  await recordBillingReviewItem({
    userId: payment.userId,
    provider: STRIPE,
    providerResourceId: payment.providerPaymentId,
    product,
    reason: adjustment.fullyRefunded ? "SUBSCRIPTION_PAYMENT_REVERSED" : "PARTIAL_REFUND",
    refundReviewRequired: false,
    detail: { eventType, subscriptionId: payment.providerResourceId, refundedAmountCents: adjustment.refundedAmountCents },
  });
  if (payment.providerResourceId?.startsWith("sub_")) {
    // The subscription decides access: a merchant who refunds and cancels
    // sends the cancellation separately, and this applies it if it came first.
    await applyLiveStripeSubscription(payment.providerResourceId, eventType).catch(() => undefined);
  }
  return { outcome: "APPLIED", product: payment.product };
}
