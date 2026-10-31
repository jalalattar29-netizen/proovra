/**
 * BILLING ACCEPTANCE (2026-10-31) — what the sweep may do without a person.
 *
 * Reconciliation exists to make local state match the provider, and most of that
 * is harmless. Two results are not: lowering what a customer can use, and asking a
 * provider to stop something they pay for. Approving a deployment is not approval
 * of those for records that already exist, so both are held until an operator has
 * read the preview (`billing-automatic-effects-preview`) and turned them on.
 *
 * A hold changes nothing for the customer and raises a review item, so what is
 * held is visible rather than silent. It covers the SWEEP only: a provider webhook
 * still lands a provider's own fact, and a customer's own cancellation, an agreed
 * downgrade and an ended grant still record their obligations.
 */
import { PLAN_RANK } from "@proovra/shared-billing";

export function automaticPlanLoweringEnabled(): boolean {
  return process.env.BILLING_AUTO_PLAN_LOWERING === "on";
}

export function automaticAddonCancellationEnabled(): boolean {
  return process.env.BILLING_AUTO_ADDON_CANCELLATION === "on";
}

export function lowersPlan(from: string, to: string): boolean {
  const before = PLAN_RANK[from as keyof typeof PLAN_RANK];
  const after = PLAN_RANK[to as keyof typeof PLAN_RANK];
  return before !== undefined && after !== undefined && after < before;
}
