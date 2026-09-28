/**
 * BILLING PAYPAL INTEGRITY (2026-09-28) — stopping a SUPERSEDED base
 * subscription at its provider.
 *
 * A person holds at most one live base plan. When a second one becomes ACTIVE
 * anyway — the classic case is a PayPal approval the buyer completed in a tab
 * they had abandoned, after buying a plan another way — the provider bills
 * both. `syncPlanForSubscription` refuses to let the newcomer become the
 * entitlement and calls this to stop it at the provider.
 *
 * "Canceled" is reported ONLY on the provider's own confirmation: PayPal's
 * subscription re-read as CANCELLED / EXPIRED, Stripe's reply as `canceled`.
 * A 422 from PayPal ("not cancellable in this state") is answered by reading
 * the subscription, because an already-cancelled subscription is the goal,
 * not an outage.
 */

import * as prismaPkg from "@prisma/client";

import { cancelPayPalSubscription, getPayPalSubscription } from "../paypal.service.js";
import { stripeRequestRaw } from "../stripe.service.js";

export type SupersededCancellation = { canceled: boolean; observedAtUtc: Date | null };

export type SupersededCanceller = (
  provider: prismaPkg.PaymentProvider,
  providerSubId: string,
) => Promise<SupersededCancellation>;

function isoDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Read a PayPal subscription and report whether it has ended. */
export async function payPalSubscriptionEnded(
  subscriptionId: string,
): Promise<SupersededCancellation | null> {
  try {
    const sub = await getPayPalSubscription(subscriptionId);
    const status = String(sub.status ?? "").toUpperCase();
    if (status === "CANCELLED" || status === "EXPIRED") {
      return {
        canceled: true,
        observedAtUtc: isoDate(sub.status_update_time ?? sub.update_time),
      };
    }
    return { canceled: false, observedAtUtc: null };
  } catch {
    return null;
  }
}

export const cancelSupersededSubscriptionAtProvider: SupersededCanceller = async (
  provider,
  providerSubId,
) => {
  if (provider === prismaPkg.PaymentProvider.PAYPAL) {
    try {
      await cancelPayPalSubscription(
        providerSubId,
        "Duplicate subscription: another PROOVRA plan is already active on this account",
      );
    } catch {
      // Refused (for example already cancelled) or unreachable: the state
      // decides, not the refusal.
    }
    return (await payPalSubscriptionEnded(providerSubId)) ?? { canceled: false, observedAtUtc: null };
  }
  if (provider === prismaPkg.PaymentProvider.STRIPE) {
    try {
      const res = await stripeRequestRaw(
        `/subscriptions/${encodeURIComponent(providerSubId)}`,
        "DELETE",
      );
      const status = String(res.status ?? "").toLowerCase();
      const canceledAt =
        typeof res.canceled_at === "number" ? new Date(res.canceled_at * 1000) : null;
      return { canceled: status === "canceled", observedAtUtc: canceledAt };
    } catch {
      return { canceled: false, observedAtUtc: null };
    }
  }
  return { canceled: false, observedAtUtc: null };
};
