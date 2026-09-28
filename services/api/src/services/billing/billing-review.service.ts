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
  /** The provider activated a storage subscription that cannot be granted. */
  | "STORAGE_ACTIVATION_REFUSED"
  /** A provider-active storage subscription with no local record (e.g. a deleted workspace). */
  | "STORAGE_SUBSCRIPTION_WITHOUT_RECORD"
  /** A refunded or reversed credit purchase whose credits were already consumed. */
  | "CREDIT_REFUND_AFTER_CONSUMPTION"
  /** A plan or storage payment was reversed (chargeback) or refunded. */
  | "SUBSCRIPTION_PAYMENT_REVERSED"
  /** Part of a payment was refunded; the product it bought is indivisible. */
  | "PARTIAL_REFUND"
  /** A buyer opened a dispute against a PROOVRA payment. */
  | "PAYMENT_DISPUTED"
  /** A captured amount did not match the price of the purchase attempt. */
  | "AMOUNT_MISMATCH";

export type BillingReviewProduct = "PLAN" | "STORAGE_ADDON" | "EVIDENCE_CREDIT";

export type BillingProviderAction = "NONE" | "CANCELED_AT_PROVIDER" | "CANCEL_FAILED";

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
}): Promise<void> {
  const providerAction = input.providerAction ?? "NONE";
  const existing = await prisma.billingReviewItem.findUnique({
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
    await prisma.billingReviewItem
      .create({
        data: {
          userId: input.userId,
          provider: input.provider,
          providerResourceId: input.providerResourceId,
          product: input.product,
          reason: input.reason,
          providerAction,
          refundReviewRequired: input.refundReviewRequired === true,
          detail,
        },
      })
      .catch(async (err: unknown) => {
        // A concurrent delivery created it first: fall through to the update.
        if ((err as { code?: string }).code !== "P2002") throw err;
        await recordBillingReviewItem(input);
      });
    return;
  }
  const stronger =
    existing.providerAction !== "CANCELED_AT_PROVIDER" && providerAction !== "NONE";
  await prisma.billingReviewItem.update({
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
