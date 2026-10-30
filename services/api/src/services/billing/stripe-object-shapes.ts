/**
 * BILLING REMEDIATION (2026-10-30, AUD-14a) — reading a Stripe object whichever
 * API version serialized it.
 *
 * Requests declare `STRIPE_API_VERSION`, but a webhook is serialized by its
 * ENDPOINT's version, which code cannot set. So one payload may carry the period
 * end on the subscription (before 2025-03-31.basil) and the next on its items.
 * These readers accept both; a field absent from both reads as null, and a null
 * is "not stated here", never "erase what is recorded".
 */

export type StripeSubscriptionItemLike = {
  id?: string;
  current_period_end?: number | null;
  quantity?: number | null;
  price?: {
    id?: string;
    unit_amount?: number | null;
    currency?: string;
  } | null;
};

export type StripeSubscriptionLike = {
  id: string;
  status?: string;
  currency?: string;
  current_period_end?: number | null;
  cancel_at_period_end?: boolean | null;
  cancel_at?: number | null;
  canceled_at?: number | null;
  /** The schedule managing this subscription: an id, or the expanded object. */
  schedule?: string | { id?: string } | null;
  items?: { data?: StripeSubscriptionItemLike[] };
  metadata?: Record<string, string | undefined> | null;
};

function unixDate(value: unknown): Date | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000) : null;
}

/** The one subscription item PROOVRA sells on a subscription. */
export function stripeSubscriptionItem(sub: StripeSubscriptionLike): StripeSubscriptionItemLike | null {
  return sub.items?.data?.[0] ?? null;
}

export function stripeSubscriptionPeriodEnd(sub: StripeSubscriptionLike): Date | null {
  return unixDate(stripeSubscriptionItem(sub)?.current_period_end) ?? unixDate(sub.current_period_end);
}

export function stripeSubscriptionPriceId(sub: StripeSubscriptionLike): string | null {
  const id = stripeSubscriptionItem(sub)?.price?.id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

export function stripeSubscriptionUnitAmount(sub: StripeSubscriptionLike): number | null {
  const amount = stripeSubscriptionItem(sub)?.price?.unit_amount;
  return typeof amount === "number" ? amount : null;
}

export function stripeSubscriptionScheduleId(sub: StripeSubscriptionLike): string | null {
  const schedule = sub.schedule;
  if (typeof schedule === "string") return schedule.trim() || null;
  return typeof schedule?.id === "string" ? schedule.id.trim() || null : null;
}

/**
 * Whether Stripe will end this subscription on its own. The Dashboard may
 * schedule the end through `cancel_at` rather than the flag, and both stop
 * renewal, so both count.
 */
export function stripeSubscriptionEnding(sub: StripeSubscriptionLike): boolean {
  return sub.cancel_at_period_end === true || typeof sub.cancel_at === "number";
}

/** The metadata Stripe copied from the subscription onto an invoice. */
export function stripeInvoiceSubscriptionMetadata(invoice: {
  parent?: unknown;
  subscription_details?: unknown;
}): Record<string, string | undefined> {
  const asRecord = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  const details =
    asRecord(asRecord(invoice.parent)?.["subscription_details"]) ?? asRecord(invoice.subscription_details);
  return (asRecord(details?.["metadata"]) as Record<string, string | undefined> | null) ?? {};
}
