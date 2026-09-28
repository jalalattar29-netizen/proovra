/**
 * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — WHO A RENEWAL BELONGS TO.
 *
 * The defect this closes
 * ---------------------------------------------------------------------------
 * Recurring renewals were NEVER recorded, for either provider.
 *
 * Stripe: `invoice.paid` / `invoice.payment_failed` read `invoice.metadata`
 * for a `userId`. Stripe does not copy `subscription_data[metadata]` onto the
 * invoice's top-level `metadata` — that metadata lands on the SUBSCRIPTION, and
 * the invoice exposes it under `subscription_details.metadata` — so the field
 * the handler read was empty on every renewal and the `if (userId && plan)`
 * guard silently skipped the write. Payment history therefore contained the
 * first checkout and nothing else, for the life of the subscription.
 *
 * PayPal: renewals arrive as `PAYMENT.SALE.COMPLETED`, which the handler did
 * not implement at all. Only `PAYMENT.CAPTURE.COMPLETED` (the one-time order
 * path) was handled, and only when its `custom_id` said PAYG.
 *
 * The rule
 * ---------------------------------------------------------------------------
 * Ownership of a renewal is resolved from the AUTHORITATIVE STORED
 * RELATIONSHIP — the `Subscription` row this platform wrote when the checkout
 * completed — keyed by the provider's own subscription id, which every renewal
 * event carries. Nothing is guessed and nothing is derived from an email or a
 * customer name.
 *
 * If no stored subscription matches, the payment is NOT attributed. An
 * unattributable provider event is a real state — a subscription created
 * outside this platform, or one whose row was lost — and inventing an owner for
 * it would write a guess into a customer's financial history.
 */

import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";

export type ResolvedPaymentSubject =
  | {
      product: "PLAN";
      userId: string;
      /** null = the payer's PERSONAL account. */
      teamId: string | null;
      plan: prismaPkg.PlanType;
      /** The local Subscription row. */
      recordId: string;
    }
  | {
      /**
       * BILLING PAYPAL INTEGRITY (2026-09-28) — a recurring STORAGE add-on is
       * its own provider subscription and has no `subscriptions` row. Its
       * renewals were "unattributable" and never reached payment history.
       */
      product: "STORAGE_ADDON";
      userId: string;
      teamId: string | null;
      plan: null;
      /** The local workspace_storage_addons row. */
      recordId: string;
    };

/**
 * Resolve the commercial subject of a provider subscription id: a base plan
 * (`subscriptions`) or a recurring storage add-on (`workspace_storage_addons`).
 *
 * Returns `null` when this platform has no record of that subscription, which
 * the caller must treat as "do not attribute" rather than as a default.
 */
export async function resolveSubjectFromProviderSubscription(input: {
  provider: prismaPkg.PaymentProvider;
  providerSubId: string;
}): Promise<ResolvedPaymentSubject | null> {
  const trimmed = input.providerSubId.trim();
  if (!trimmed) return null;

  const row = await prisma.subscription.findUnique({
    where: {
      provider_providerSubId: {
        provider: input.provider,
        providerSubId: trimmed,
      },
    },
    select: { id: true, userId: true, teamId: true, plan: true },
  });

  if (row) {
    return {
      product: "PLAN",
      userId: row.userId,
      teamId: row.teamId ?? null,
      plan: row.plan,
      recordId: row.id,
    };
  }

  const addon = await prisma.workspaceStorageAddon.findUnique({
    where: { externalSubscriptionId: trimmed },
    select: { id: true, ownerUserId: true, teamId: true, paymentProvider: true },
  });
  if (!addon || (addon.paymentProvider && addon.paymentProvider !== input.provider)) {
    return null;
  }
  return {
    product: "STORAGE_ADDON",
    userId: addon.ownerUserId,
    teamId: addon.teamId ?? null,
    plan: null,
    recordId: addon.id,
  };
}

/**
 * Extract the Stripe subscription id from an invoice payload.
 *
 * Stripe has moved this field: older API versions expose a top-level
 * `subscription`, newer ones nest it under `parent.subscription_details`. Both
 * shapes are read, because a webhook that silently stops matching after an API
 * version bump is the same class of defect as the metadata one this replaces.
 */
export function stripeSubscriptionIdFromInvoice(invoice: {
  subscription?: unknown;
  parent?: unknown;
}): string | null {
  const direct = invoice.subscription;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  if (
    direct &&
    typeof direct === "object" &&
    typeof (direct as { id?: unknown }).id === "string"
  ) {
    return (direct as { id: string }).id.trim() || null;
  }

  const parent = invoice.parent as
    | { subscription_details?: { subscription?: unknown } }
    | undefined;
  const nested = parent?.subscription_details?.subscription;
  if (typeof nested === "string" && nested.trim()) return nested.trim();
  if (
    nested &&
    typeof nested === "object" &&
    typeof (nested as { id?: unknown }).id === "string"
  ) {
    return (nested as { id: string }).id.trim() || null;
  }

  return null;
}

/**
 * The PayPal subscription id a recurring sale belongs to.
 *
 * `PAYMENT.SALE.COMPLETED` carries `billing_agreement_id`, which for a
 * subscription IS the subscription id this platform stored at checkout.
 */
export function paypalSubscriptionIdFromSale(resource: {
  billing_agreement_id?: unknown;
}): string | null {
  const id = resource.billing_agreement_id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}
