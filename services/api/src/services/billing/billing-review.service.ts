/**
 * BILLING PAYPAL INTEGRITY (2026-09-28) — the review record for provider
 * money PROOVRA must not silently turn into (or away from) an entitlement.
 *
 * WHY
 * ---------------------------------------------------------------------------
 * Several provider facts have no safe automatic entitlement answer: a second
 * base subscription the buyer approved after abandoning it, a storage
 * subscription PayPal activated that cannot be granted, a refund of credits
 * the customer has already spent, a dispute. The audit found each of these
 * either granted "whichever wrote last" or left a billed PENDING row with no
 * trace. The rule now: the provider-side consequence PROOVRA can take safely
 * (cancelling an unwanted subscription) is taken, and the fact — including
 * whether a refund review is owed — is recorded here, durably, once per
 * (provider, resource, reason).
 *
 * This module writes review records only. It grants nothing, revokes nothing
 * and calls no provider.
 */

import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";

export type BillingReviewReason =
  /** A base subscription became ACTIVE while another base subscription was live. */
  | "DUPLICATE_BASE_SUBSCRIPTION"
  /**
   * NEW-RG-02-1 — a superseded duplicate the sweep could NOT conclusively
   * classify (ambiguous owner, no valid retained subscription, missing provider
   * facts): nothing was asked of the provider; an operator decides.
   */
  | "DUPLICATE_BASE_SUBSCRIPTION_UNCONFIRMED"
  /** A stored provider reference the provider keeps answering 404 for. */
  | "PROVIDER_REFERENCE_UNRESOLVED"
  /** The provider activated a storage subscription that cannot be granted. */
  | "STORAGE_ACTIVATION_REFUSED"
  /**
   * A second recurring add-on of the same size activated for a purchase that was
   * started before the first one went live: the customer never saw it. Not granted;
   * stopped at the provider (or held, in the sweep) and sent to refund review.
   */
  | "DUPLICATE_STORAGE_PURCHASE"
  /** A provider-active storage subscription with no local record (e.g. a deleted workspace). */
  | "STORAGE_SUBSCRIPTION_WITHOUT_RECORD"
  /** Stripe's record of a bound customer names another owner or environment. */
  | "PROVIDER_CUSTOMER_CONFLICT"
  /** The sweep would have lowered a plan to what is billed. Held until enabled. */
  | "AUTOMATIC_PLAN_LOWERING_HELD"
  /** The sweep would have cancelled an add-on at the provider. Held until enabled. */
  | "AUTOMATIC_ADDON_CANCELLATION_HELD"
  /**
   * PRO-BL1-04 / DEC-02 (2026-11-19) — a past-due add-on is beyond the 7-day
   * grace after its paid period (or its paid period is unknown). Its capacity
   * would end; held, and still counted, until automatic add-on effects are enabled.
   */
  | "AUTOMATIC_ADDON_CAPACITY_END_HELD"
  /**
   * PRO-N1-01 (review G1, 2026-11-19) — a plan or storage subscription became
   * ACTIVE at the provider for an account that has been closed (a checkout paid
   * after anonymisation). Nothing was granted or recorded as live; the provider
   * subscription must be cancelled and refunded by an operator.
   * Also (2026-11-20) a one-time evidence-credit purchase or a legacy one-time
   * storage capture that settled after the closure: nothing granted, the
   * payment is recorded and an operator reviews the refund.
   */
  | "PAYMENT_AFTER_ACCOUNT_CLOSURE"
  /** A refunded or reversed credit purchase whose credits were already consumed. */
  | "CREDIT_REFUND_AFTER_CONSUMPTION"
  /** A plan or storage payment was reversed (chargeback) or refunded. */
  | "SUBSCRIPTION_PAYMENT_REVERSED"
  /** Part of a payment was refunded; the product it bought is indivisible. */
  | "PARTIAL_REFUND"
  /** A buyer opened a dispute against a PROOVRA payment. */
  | "PAYMENT_DISPUTED"
  /** A captured amount did not match the price of the purchase attempt. */
  | "AMOUNT_MISMATCH"
  /**
   * AUDIT E-03 (2026-11-15) — a capture naming a legacy one-time storage order
   * that no durable local binding confirms (none, more than one, or one naming
   * another payer, workspace or size). Money may have moved; nothing is granted.
   */
  | "LEGACY_STORAGE_CAPTURE_UNMATCHED"
  /**
   * PRO-BL1-01 (2026-11-18) — the provider says a subscription renews although
   * a customer cancellation it confirmed was recorded. The row follows the
   * provider (it is the truth about billing), but never silently.
   */
  | "CANCELLATION_REVERSED_AT_PROVIDER"
  /**
   * PRO-BL1-04 / DEC-02 (2026-11-19) — the provider has reported a subscription
   * ACTIVE for over an hour and still reports no completed payment for it.
   * Nothing is granted on the label; the purchase stays pending and the sweep
   * keeps re-reading it. A person looks at what the provider is doing.
   */
  | "ACTIVE_WITHOUT_COMPLETED_PAYMENT"
  /**
   * PRO-BL1-04 / DEC-02 (2026-11-19) — a storage add-on is past due and no
   * paid period is recorded for it, so the 7-day grace has nothing to run
   * from. Missing payment facts are reviewed. Its capacity stops counting only
   * once automatic add-on effects are enabled (held until then).
   */
  | "STORAGE_ADDON_PAID_PERIOD_UNKNOWN";

export type BillingReviewProduct = "PLAN" | "STORAGE_ADDON" | "EVIDENCE_CREDIT";

export type BillingProviderAction = "NONE" | "CANCELED_AT_PROVIDER" | "CANCEL_FAILED";

/** How long a provider's ACTIVE may lack a completed payment before a person is asked to look. */
export const UNPROVEN_PAYMENT_REVIEW_AFTER_MS = 60 * 60 * 1000;

/**
 * PRO-BL1-04 / DEC-02 — an ACTIVE provider subscription with no completed
 * payment is never granted on the label. The webhook that announces ACTIVE
 * commonly arrives moments before the payment's own event, so nothing is
 * recorded then; once the provider's ACTIVE is over an hour old the item is
 * recorded (idempotent), from whichever path next reads it (re-check, sweep).
 */
export async function noteActiveWithoutCompletedPayment(input: {
  userId: string;
  provider: prismaPkg.PaymentProvider;
  providerResourceId: string;
  product: BillingReviewProduct;
  observedAtUtc: Date | null;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  if (!input.observedAtUtc || now.getTime() - input.observedAtUtc.getTime() < UNPROVEN_PAYMENT_REVIEW_AFTER_MS) {
    return false;
  }
  await recordBillingReviewItem({
    userId: input.userId,
    provider: input.provider,
    providerResourceId: input.providerResourceId,
    product: input.product,
    reason: "ACTIVE_WITHOUT_COMPLETED_PAYMENT",
    providerAction: "NONE",
    detail: { providerActiveSinceUtc: input.observedAtUtc.toISOString(), granted: false },
  });
  return true;
}

/**
 * Record (or update) ONE review item. Idempotent on
 * (provider, providerResourceId, reason): a redelivered webhook or a second
 * re-check updates the same row, never a second one. A later, stronger
 * provider action (CANCELED_AT_PROVIDER after CANCEL_FAILED) replaces a
 * weaker one; `refundReviewRequired` only ever becomes true.
 */
export async function recordBillingReviewItem(input: {
  userId: string;
  provider: prismaPkg.PaymentProvider;
  providerResourceId: string;
  product: BillingReviewProduct;
  reason: BillingReviewReason;
  providerAction?: BillingProviderAction;
  refundReviewRequired?: boolean;
  detail?: Record<string, string | number | boolean | null>;
}, client: Pick<prismaPkg.Prisma.TransactionClient, "billingReviewItem"> = prisma): Promise<void> {
  const providerAction = input.providerAction ?? "NONE";
  const existing = await client.billingReviewItem.findUnique({
    where: {
      provider_providerResourceId_reason: {
        provider: input.provider,
        providerResourceId: input.providerResourceId,
        reason: input.reason,
      },
    },
    select: { id: true, providerAction: true, refundReviewRequired: true, detail: true },
  });
  const detail = (input.detail ?? {}) as prismaPkg.Prisma.InputJsonObject;
  if (!existing) {
    /*
     * AUD-0017 (TXP-020) — the insert runs on the caller's client like every
     * other leg here. It used the module client, so inside a caller's
     * transaction (the credit-reversal webhook holds FOR UPDATE on the
     * entitlement) it asked the pool for a second connection, and the review
     * item committed even when that transaction rolled back. `skipDuplicates`
     * instead of catching P2002: a unique violation would abort the caller's
     * transaction. A concurrent delivery that created it first falls through
     * to the update, on the same client.
     */
    const { count } = await client.billingReviewItem.createMany({
      data: [
        {
          userId: input.userId,
          provider: input.provider,
          providerResourceId: input.providerResourceId,
          product: input.product,
          reason: input.reason,
          providerAction,
          refundReviewRequired: input.refundReviewRequired === true,
          detail,
        },
      ],
      skipDuplicates: true,
    });
    if (count === 0) await recordBillingReviewItem(input, client);
    return;
  }
  const stronger =
    existing.providerAction !== "CANCELED_AT_PROVIDER" && providerAction !== "NONE";
  await client.billingReviewItem.update({
    where: { id: existing.id },
    data: {
      ...(stronger ? { providerAction } : {}),
      refundReviewRequired: existing.refundReviewRequired || input.refundReviewRequired === true,
      detail: {
        ...((existing.detail && typeof existing.detail === "object" && !Array.isArray(existing.detail)
          ? existing.detail
          : {}) as Record<string, unknown>),
        ...detail,
      } as prismaPkg.Prisma.InputJsonObject,
    },
  });
}

/** Open review items on one payer's account, for the Billing banner. */
export async function countOpenBillingReviewItems(userId: string): Promise<{
  open: number;
  refundReview: number;
  providerStillBilling: number;
}> {
  const rows = await prisma.billingReviewItem.findMany({
    where: { userId, status: "OPEN" },
    select: { refundReviewRequired: true, providerAction: true },
  });
  return {
    open: rows.length,
    refundReview: rows.filter((r) => r.refundReviewRequired).length,
    providerStillBilling: rows.filter((r) => r.providerAction === "CANCEL_FAILED").length,
  };
}
