/**
 * BILLING PAYPAL INTEGRITY (2026-09-28) — THE storage add-on rules, stated
 * once: which SKU an account may buy, and which SKU depends on a paid plan.
 *
 * WHY ONE MODULE
 * ---------------------------------------------------------------------------
 * Three places answered these questions three ways. The checkout route read
 * the plan by hand (and refused the TEAM catalogue it offered), the webhook
 * checked a workspace's `billingPlan`, and reconciliation checked nothing — so
 * the same PayPal activation was refused by one path and granted by another.
 * Dependency had no rule at all: ANY cancelled subscription row on the account
 * (an abandoned PayPal approval, a plan cancelled before resubscribing) made
 * EVERY live add-on "dependent" and cancelled it at the provider.
 *
 * THE RULES
 * ---------------------------------------------------------------------------
 *   * An account may buy a SKU iff it is in the offer catalogue for its plan
 *     (`storageAddonOffersForPlan`) — the SAME list the page shows. Only the
 *     personal account buys; a workspace (`teamId`) is not a self-service
 *     subject.
 *   * A SKU a FREE account may buy does not depend on any plan: cancelling a
 *     plan must not take away storage a Free account is entitled to hold.
 *   * Any other SKU (the TEAM catalogue) requires a live paid plan that offers
 *     it. It depends on the base subscription recorded at activation.
 */

import * as prismaPkg from "@prisma/client";

import { storageAddonOffersForPlan } from "../workspace-usage.service.js";

/** Whether a Free account's catalogue contains this SKU. */
export function storageAddonFreeEligible(key: prismaPkg.StorageAddonKey): boolean {
  return storageAddonOffersForPlan(prismaPkg.PlanType.FREE).some((offer) => offer.key === key);
}

/** A SKU that only a paid plan offers, and therefore depends on one. */
export function storageAddonRequiresPaidPlan(key: prismaPkg.StorageAddonKey): boolean {
  return !storageAddonFreeEligible(key);
}

/** May an account on `plan` hold (buy or activate) this SKU? */
export function storageAddonEligibleForPlan(
  plan: prismaPkg.PlanType,
  key: prismaPkg.StorageAddonKey,
): boolean {
  return storageAddonOffersForPlan(plan).some((offer) => offer.key === key);
}

/** The facts about a base subscription the dependency rule reads. */
export type DependencyBase = {
  id: string;
  teamId: string | null;
  status: prismaPkg.SubscriptionStatus;
  plan: prismaPkg.PlanType;
  activatedAtUtc: Date | null;
  currentPeriodEnd: Date | null;
  locallyTerminatedAtUtc: Date | null;
};

/**
 * Did this base subscription ever carry a paid entitlement?
 *
 * A checkout that never activated (a TRIALING row later abandoned or expired)
 * carried nothing, so its cancellation cannot oblige anything. Rows written
 * before `activatedAtUtc` existed are judged by the provider period they
 * recorded; a local abandonment never counts.
 */
export function baseCarriedEntitlement(base: DependencyBase): boolean {
  if (base.activatedAtUtc) return true;
  if (base.locallyTerminatedAtUtc) return false;
  return base.currentPeriodEnd !== null;
}

/**
 * The base subscription whose END obliges this add-on to be cancelled, or
 * null when it owes nothing.
 *
 *   * a SKU a Free account may hold is never owed;
 *   * a live paid plan that still offers the SKU satisfies it — nothing owed;
 *   * otherwise the ended base it was recorded against at activation, or, for
 *     a legacy row with no recorded dependency, an ended base that carried a
 *     paid entitlement for the same subject.
 */
export function owedDependentCancellationTrigger(input: {
  addon: {
    addonKey: prismaPkg.StorageAddonKey;
    teamId: string | null;
    dependsOnSubscriptionId: string | null;
  };
  /** A live, NOT-ending base plan of the subject, if one exists. */
  satisfyingBase: { id: string; plan: prismaPkg.PlanType } | null;
  /** Bases of the subject that have ended or are scheduled to end. */
  endedBases: DependencyBase[];
}): DependencyBase | null {
  const { addon } = input;
  if (!storageAddonRequiresPaidPlan(addon.addonKey)) return null;
  if (
    input.satisfyingBase &&
    storageAddonEligibleForPlan(input.satisfyingBase.plan, addon.addonKey)
  ) {
    return null;
  }
  if (addon.dependsOnSubscriptionId) {
    return input.endedBases.find((b) => b.id === addon.dependsOnSubscriptionId) ?? null;
  }
  // A legacy row with no recorded dependency: an ended base that carried a
  // paid entitlement for the same subject AND whose plan offered this SKU —
  // a cancelled plan that never sold it cannot be what it depended on.
  return (
    input.endedBases.find(
      (b) =>
        baseCarriedEntitlement(b) &&
        storageAddonEligibleForPlan(b.plan, addon.addonKey) &&
        (addon.teamId === null ? b.teamId === null : b.teamId === addon.teamId),
    ) ?? null
  );
}
