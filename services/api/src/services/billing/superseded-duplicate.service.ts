/**
 * NEW-RG-02-1 (owner decision H, 2026-11-21) — when the billing sweep may keep
 * asking a provider to stop a SUPERSEDED duplicate base subscription.
 *
 * A NARROW DUPLICATE-CHARGE PREVENTION EXCEPTION, NOT A GENERAL PERMISSION
 * ---------------------------------------------------------------------------
 * The sweep's provider-side effects are held behind BILLING_AUTO_PLAN_LOWERING
 * and BILLING_AUTO_ADDON_CANCELLATION (`automatic-effects.ts`). This step is
 * the single documented exception: it keeps retrying the provider cancel of a
 * duplicate base subscription with neither switch on, because a duplicate bills
 * the customer every period for something that grants nothing. It is allowed
 * ONLY when every fact below holds; anything less is a review item and NO
 * provider mutation:
 *
 *   1. the row is conclusively a superseded duplicate: it names the retained
 *      subscription, carries a provider reference at a supported provider, and
 *      is itself a self-service base plan;
 *   2. a valid retained subscription exists for the same commercial
 *      entitlement: same account (userId), same workspace binding (teamId, both
 *      personal or the same legacy workspace), a self-service base plan, not
 *      itself superseded, locally ACTIVE and not ending;
 *   3. the provider itself confirms the retained subscription is ACTIVE and not
 *      set to stop renewing (a read, never a write);
 *   4. the provider answers for the duplicate too; if it already ended, the
 *      step only records that (no cancel call), so a retry is idempotent.
 *
 * The step never lowers an entitlement, never refunds (a refund review is
 * flagged for an operator), and never touches the retained subscription: the
 * only provider mutation reachable from here is the cancel of the duplicate's
 * own reference. The release preview (`billing-automatic-effects-preview`)
 * lists every candidate with this classification.
 */
import * as prismaPkg from "@prisma/client";

import { SELF_SERVICE_BASE_SUBSCRIPTION_PLANS } from "./base-subscription.service.js";
import { PayPalBillingReconciliationProvider } from "./reconciliation/paypal.provider.js";
import { StripeBillingReconciliationProvider } from "./reconciliation/stripe.provider.js";
import type { ObservedState } from "./reconciliation/types.js";

/** The fields of a subscription row the classification reads. */
export type SupersessionRowFacts = {
  id: string;
  userId: string;
  teamId: string | null;
  provider: prismaPkg.PaymentProvider;
  providerSubId: string;
  plan: prismaPkg.PlanType;
  status: prismaPkg.SubscriptionStatus;
  supersededBySubscriptionId: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAtUtc: Date | null;
};

export const SUPERSESSION_ROW_SELECT = {
  id: true,
  userId: true,
  teamId: true,
  provider: true,
  providerSubId: true,
  plan: true,
  status: true,
  supersededBySubscriptionId: true,
  cancelAtPeriodEnd: true,
  canceledAtUtc: true,
} as const;

/** Why a superseded row is NOT a conclusive duplicate (goes to review). */
export type SupersessionReviewReason =
  | "NOT_SUPERSEDED"
  | "DUPLICATE_HAS_NO_PROVIDER_REFERENCE"
  | "UNSUPPORTED_PROVIDER"
  | "DUPLICATE_NOT_A_BASE_PLAN"
  | "RETAINED_MISSING"
  | "RETAINED_IS_THE_DUPLICATE"
  | "RETAINED_ACCOUNT_DIFFERS"
  | "RETAINED_WORKSPACE_DIFFERS"
  | "RETAINED_NOT_A_BASE_PLAN"
  | "RETAINED_ITSELF_SUPERSEDED"
  | "RETAINED_HAS_NO_PROVIDER_REFERENCE"
  | "RETAINED_NOT_ACTIVE"
  | "RETAINED_ENDING"
  | "RETAINED_PROVIDER_FACTS_MISSING"
  | "RETAINED_NOT_ACTIVE_AT_PROVIDER"
  | "RETAINED_ENDING_AT_PROVIDER"
  | "DUPLICATE_PROVIDER_FACTS_MISSING";

export type SupersessionClassification =
  | { kind: "CONCLUSIVE"; retainedSubscriptionId: string; duplicateAlreadyEnded: boolean; observedAtUtc: Date | null }
  | { kind: "REVIEW"; reason: SupersessionReviewReason; retainedSubscriptionId: string | null };

/** What a provider READ says about one subscription. Null: it did not answer. */
export type SupersessionProviderFact = { state: ObservedState; cancelAtPeriodEnd: boolean; observedAtUtc: Date | null };
export type SupersessionProviderReader = (
  provider: prismaPkg.PaymentProvider,
  providerSubId: string,
) => Promise<SupersessionProviderFact | null>;

const SUPPORTED: ReadonlySet<prismaPkg.PaymentProvider> = new Set([
  prismaPkg.PaymentProvider.STRIPE,
  prismaPkg.PaymentProvider.PAYPAL,
]);

const isBasePlan = (plan: prismaPkg.PlanType) => SELF_SERVICE_BASE_SUBSCRIPTION_PLANS.includes(plan);

/**
 * The local half of the rule: everything the database alone can decide. A
 * CONCLUSIVE answer here still needs the provider half (`classifySupersededDuplicate`)
 * before any provider mutation; the read-only preview reports it as
 * "conclusive locally, provider confirmation required".
 */
export function classifySupersededDuplicateLocally(
  duplicate: SupersessionRowFacts,
  retained: SupersessionRowFacts | null,
): { kind: "LOCALLY_CONCLUSIVE"; retainedSubscriptionId: string } | Extract<SupersessionClassification, { kind: "REVIEW" }> {
  const review = (reason: SupersessionReviewReason) =>
    ({ kind: "REVIEW", reason, retainedSubscriptionId: retained?.id ?? duplicate.supersededBySubscriptionId }) as const;
  if (!duplicate.supersededBySubscriptionId) return review("NOT_SUPERSEDED");
  if (!duplicate.providerSubId.trim()) return review("DUPLICATE_HAS_NO_PROVIDER_REFERENCE");
  if (!SUPPORTED.has(duplicate.provider)) return review("UNSUPPORTED_PROVIDER");
  if (!isBasePlan(duplicate.plan)) return review("DUPLICATE_NOT_A_BASE_PLAN");
  if (!retained) return review("RETAINED_MISSING");
  if (
    retained.id === duplicate.id ||
    (retained.provider === duplicate.provider && retained.providerSubId === duplicate.providerSubId)
  ) {
    return review("RETAINED_IS_THE_DUPLICATE");
  }
  if (retained.userId !== duplicate.userId) return review("RETAINED_ACCOUNT_DIFFERS");
  if ((retained.teamId ?? null) !== (duplicate.teamId ?? null)) return review("RETAINED_WORKSPACE_DIFFERS");
  if (!isBasePlan(retained.plan)) return review("RETAINED_NOT_A_BASE_PLAN");
  if (retained.supersededBySubscriptionId !== null) return review("RETAINED_ITSELF_SUPERSEDED");
  if (!retained.providerSubId.trim() || !SUPPORTED.has(retained.provider)) {
    return review("RETAINED_HAS_NO_PROVIDER_REFERENCE");
  }
  if (retained.status !== prismaPkg.SubscriptionStatus.ACTIVE) return review("RETAINED_NOT_ACTIVE");
  if (retained.cancelAtPeriodEnd || retained.canceledAtUtc !== null) return review("RETAINED_ENDING");
  return { kind: "LOCALLY_CONCLUSIVE", retainedSubscriptionId: retained.id };
}

/**
 * The whole rule: the local half, then provider READS of the retained
 * subscription and of the duplicate. Never mutates anything.
 */
export async function classifySupersededDuplicate(
  duplicate: SupersessionRowFacts,
  retained: SupersessionRowFacts | null,
  read: SupersessionProviderReader,
): Promise<SupersessionClassification> {
  const local = classifySupersededDuplicateLocally(duplicate, retained);
  if (local.kind === "REVIEW") return local;
  const review = (reason: SupersessionReviewReason): SupersessionClassification => ({
    kind: "REVIEW",
    reason,
    retainedSubscriptionId: local.retainedSubscriptionId,
  });

  const kept = await read(retained!.provider, retained!.providerSubId).catch(() => null);
  if (!kept || kept.state === "UNKNOWN") return review("RETAINED_PROVIDER_FACTS_MISSING");
  if (kept.state !== "SUCCEEDED") return review("RETAINED_NOT_ACTIVE_AT_PROVIDER");
  if (kept.cancelAtPeriodEnd) return review("RETAINED_ENDING_AT_PROVIDER");

  const dup = await read(duplicate.provider, duplicate.providerSubId).catch(() => null);
  if (!dup || dup.state === "UNKNOWN") return review("DUPLICATE_PROVIDER_FACTS_MISSING");
  const ended = dup.state === "CANCELED" || dup.state === "EXPIRED";
  return {
    kind: "CONCLUSIVE",
    retainedSubscriptionId: local.retainedSubscriptionId,
    duplicateAlreadyEnded: ended,
    observedAtUtc: ended ? dup.observedAtUtc : null,
  };
}

/** Production reads: the reconciliation adapters' single-subscription GET. */
export function defaultSupersessionProviderReader(): SupersessionProviderReader {
  const adapters: Partial<Record<prismaPkg.PaymentProvider, StripeBillingReconciliationProvider | PayPalBillingReconciliationProvider>> = {};
  return async (provider, providerSubId) => {
    if (!SUPPORTED.has(provider)) return null;
    const adapter =
      adapters[provider] ??
      (adapters[provider] =
        provider === prismaPkg.PaymentProvider.STRIPE
          ? new StripeBillingReconciliationProvider()
          : new PayPalBillingReconciliationProvider());
    const observation = await adapter.observeSubscription(providerSubId);
    return {
      state: observation.state,
      cancelAtPeriodEnd: observation.cancelAtPeriodEnd,
      observedAtUtc: observation.observedAtUtc,
    };
  };
}
