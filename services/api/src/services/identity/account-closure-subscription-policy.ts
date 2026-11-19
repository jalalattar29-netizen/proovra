/**
 * Account closure — the PURE billing decision.
 *
 * Deliberately free of Prisma and of every service import. The preflight
 * service loads the facts (`listOpenProviderRelationships`) and this module
 * judges them, so the whole matrix is testable without a database client.
 *
 * PRO-N1-01 (WS-BILL, 2026-11-18) — A RELATIONSHIP, NOT AN ENTITLEMENT.
 *
 * This used to judge each candidate subscription by the ENTITLEMENT verdict
 * (`lifecycle.paidActive`). That verdict short-circuits a FREE entitlement,
 * reads two live rows as CANCELLED and PAST_DUE beyond grace as unpaid, never
 * looked at recurring storage add-ons, and was keyed by purchaser only. Each of
 * those let closure anonymise an account while the provider could still renew
 * or retry a charge nobody could cancel any more.
 *
 * The rule now (DEC-21):
 *   - a relationship that still RENEWS blocks closure: the customer cancels it
 *     first (subscription or add-on, each named);
 *   - a relationship whose end the provider confirmed (STOPPING) does not block
 *     the request: closure is SCHEDULED and completes only after every such
 *     relationship has actually ended (`pending`). Reads and export stay
 *     available meanwhile.
 */

import type { AccountClosureBlocker } from "./account-lifecycle-preflight.service.js";

/** One open provider relationship (see open-provider-relationships.service). */
export type ClosureBillingRelationship = {
  kind: "SUBSCRIPTION" | "STORAGE_ADDON" | "CHECKOUT_ATTEMPT";
  state: "RENEWING" | "STOPPING";
  endsAtUtc: Date | null;
  /** Paid by someone else (a transferred workspace's subscription or add-on). */
  billedToOtherPayer?: boolean;
};

export type ClosureBillingPending = {
  /** Relationships whose end is confirmed but not yet reached/recorded. */
  count: number;
  /** The latest known end; null when any end date is unknown. */
  endsAtUtc: Date | null;
};

export function judgeClosureBillingRelationships(
  relationships: ReadonlyArray<ClosureBillingRelationship>,
): { blockers: AccountClosureBlocker[]; pending: ClosureBillingPending | null } {
  const blockers: AccountClosureBlocker[] = [];
  const own = (r: ClosureBillingRelationship) => r.billedToOtherPayer !== true;
  const renewingSubs = relationships.filter((r) => r.kind === "SUBSCRIPTION" && r.state === "RENEWING" && own(r));
  const renewingAddons = relationships.filter((r) => r.kind === "STORAGE_ADDON" && r.state === "RENEWING" && own(r));
  // Review G2 — billing of a workspace the closure closes that SOMEONE ELSE pays
  // (a workspace transferred to this person). "Cancel it" was a dead end: the
  // cancel route acts on the caller's own subscription only, and that is the
  // canonical authority (a subscription is cancelled by the person who pays).
  const otherPayerRenewing = relationships.filter(
    (r) => r.kind !== "CHECKOUT_ATTEMPT" && r.state === "RENEWING" && !own(r),
  );
  // Review G1 — a checkout that could still be paid after the account is gone.
  const openCheckouts = relationships.filter((r) => r.kind === "CHECKOUT_ATTEMPT");
  if (renewingSubs.length > 0) {
    blockers.push({
      code: "BILLING_SUBSCRIPTION_ACTIVE",
      message:
        "You have an active subscription. Cancel it before closing your account.",
      count: renewingSubs.length,
    });
  }
  if (renewingAddons.length > 0) {
    blockers.push({
      code: "BILLING_ADDON_ACTIVE",
      message:
        "You have a storage add-on that still renews. Cancel it in Billing before closing your account.",
      count: renewingAddons.length,
    });
  }
  if (otherPayerRenewing.length > 0) {
    blockers.push({
      code: "BILLING_WORKSPACE_PAYER_ACTIVE",
      message:
        "A workspace you own is still billed to the subscription or storage add-on of the person who owned it before you. You cannot cancel it: only the person who pays for it can, from Billing in their own account. Ask them to cancel it, or transfer the workspace to another owner, then close your account. If you cannot reach them, contact support.",
      count: otherPayerRenewing.length,
    });
  }
  if (openCheckouts.length > 0) {
    blockers.push({
      code: "BILLING_CHECKOUT_OPEN",
      message:
        "You have a checkout that is not finished. Complete it or cancel it in Billing before closing your account, so no payment can arrive after the account is closed.",
      count: openCheckouts.length,
    });
  }
  const stopping = relationships.filter((r) => r.state === "STOPPING");
  if (stopping.length === 0) return { blockers, pending: null };
  const unknownEnd = stopping.some((r) => !(r.endsAtUtc instanceof Date));
  const latest = stopping
    .map((r) => r.endsAtUtc)
    .filter((d): d is Date => d instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  return {
    blockers,
    pending: { count: stopping.length, endsAtUtc: unknownEnd ? null : latest ?? null },
  };
}

/** The consequence shown before confirming when closure must wait for billing to end. */
export function closureWaitsForBillingMessage(pending: ClosureBillingPending): string {
  return pending.endsAtUtc
    ? `Your cancelled subscription or storage add-on ends on ${pending.endsAtUtc.toISOString().slice(0, 10)}. You can request closure now: it is scheduled and completes only after that date, once the payment provider confirms the end. You keep access and can export your data until then.`
    : "Your cancelled subscription or storage add-on has not ended yet. You can request closure now: it is scheduled and completes only once the payment provider confirms the end. You keep access and can export your data until then.";
}
