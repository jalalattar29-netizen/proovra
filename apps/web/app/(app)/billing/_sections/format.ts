"use client";

/**
 * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the Billing page's formatters.
 *
 * Every one of these renders a value the SERVER decided. None derives a limit,
 * a price or an entitlement, and none substitutes a zero for an absent value:
 * a meter the server could not measure says so, because "0 of 3" and "we do not
 * know" are different statements and only one of them is ever true.
 *
 * RTL: money and percentages are wrapped for bidirectional isolation by the
 * components that render them (`<bdi>`), so "€19.00" cannot reorder inside an
 * Arabic sentence. These helpers return the string; the isolation is applied at
 * the point of render, where the surrounding direction is known.
 */

import { formatUserDate } from "../../../../lib/date";
import type {
  PlanLifecycle,
  UsageMeter,
  UsageWindow,
} from "../../../../lib/api/billing-accounts";

export function formatMoney(
  amountCents: number | null | undefined,
  currency: string | null | undefined,
): string | null {
  if (typeof amountCents !== "number" || !Number.isFinite(amountCents)) {
    return null;
  }
  const safe = String(currency ?? "").trim().toUpperCase() === "EUR" ? "EUR" : "USD";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: safe,
    }).format(amountCents / 100);
  } catch {
    return `${(amountCents / 100).toFixed(2)} ${safe}`;
  }
}

/**
 * A human date in the VIEWER's timezone, or null.
 *
 * Delegates to the shared timestamp layer rather than calling
 * `Intl.DateTimeFormat` here. That layer resolves the viewer's zone and is the
 * one place the product decides how a moment is written down; a second
 * formatter on the Billing page would render a renewal date in a different
 * zone from every other date the customer sees.
 *
 * Returns `null` — never a fabricated "today" — when there is no date. A
 * credit purchase has no renewal date, and the card must render nothing rather
 * than invent one.
 */
export function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const formatted = formatUserDate(value);
  return formatted === "Not available" ? null : formatted;
}

const WINDOW_SUFFIX: Record<UsageWindow, string> = {
  // The window is part of the promise. "43 of 100" means something different
  // on a lifetime cap and a rolling 30-day cap, and the page that this replaces
  // used one shared chip for both.
  LIFETIME: "lifetime records",
  ROLLING_30_DAYS: "records in the last 30 days",
  CALENDAR_MONTH: "this month",
};

/**
 * The evidence/AI meter as one honest sentence.
 *
 * Returns `null` for a state that must NOT be rendered as a number — the caller
 * then renders the state's own copy rather than a fake ratio.
 */
export function describeMeter(meter: UsageMeter): {
  headline: string;
  detail: string | null;
  /** 0..1, or null when there is no denominator to fill. */
  ratio: number | null;
} {
  switch (meter.state) {
    case "NOT_INCLUDED":
      return { headline: "Not included", detail: null, ratio: null };
    case "CONTRACT_MANAGED":
      return {
        headline: "Contract-managed",
        detail: "Your agreement sets this allowance.",
        ratio: null,
      };
    case "UNAVAILABLE":
      // Deliberately not "0". An unreadable value is not a used-nothing value.
      return { headline: "Unavailable", detail: meter.reason, ratio: null };
    case "MEASURED": {
      const suffix = WINDOW_SUFFIX[meter.window];
      if (meter.limit === null) {
        return {
          headline: `${meter.used.toLocaleString()} ${suffix}`,
          detail: "No limit on your plan.",
          ratio: null,
        };
      }
      return {
        headline: `${meter.used.toLocaleString()} of ${meter.limit.toLocaleString()} ${suffix}`,
        detail: null,
        ratio: meter.limit > 0 ? Math.min(1, meter.used / meter.limit) : null,
      };
    }
  }
}

export type LifecyclePresentation = {
  label: string;
  tone: "verified" | "pending" | "risk" | "neutral" | "info";
  /** Explains what happens next. Null when the label says everything. */
  detail: string | null;
};

/**
 * Lifecycle → label + tone + consequence.
 *
 * Colour is never the only signal: every state carries a distinct WORD, so the
 * status is legible to a screen reader and in monochrome.
 */
export function presentLifecycle(
  lifecycle: PlanLifecycle,
  input: { periodEndUtc?: string | null; graceEndsAtUtc?: string | null } = {},
): LifecyclePresentation {
  const end = formatDate(input.periodEndUtc);
  const grace = formatDate(input.graceEndsAtUtc);

  switch (lifecycle) {
    case "ACTIVE":
      return { label: "Active", tone: "verified", detail: null };
    case "TRIALING":
      return { label: "Trial", tone: "info", detail: end ? `Trial ends ${end}.` : null };
    case "PAST_DUE":
      return {
        label: "Payment failed",
        tone: "pending",
        detail: grace
          ? `Access continues until ${grace} while we retry.`
          : "We could not take the last payment.",
      };
    case "ACTION_REQUIRED":
      return {
        label: "Action required",
        tone: "risk",
        detail: "Billing needs attention before paid features continue.",
      };
    case "CANCELING":
      return {
        label: "Canceling",
        tone: "pending",
        // The old page promised a period end while the code cancelled
        // immediately. This says the date the provider actually confirmed.
        detail: end ? `You keep access until ${end}.` : "Access continues until the end of the paid period.",
      };
    case "CANCELLED":
      return { label: "Cancelled", tone: "neutral", detail: "This subscription has ended." };
    case "INACTIVE":
      return { label: "No subscription", tone: "neutral", detail: null };
  }
}

const MODEL_COPY: Record<string, string> = {
  FREE: "Free",
  MONTHLY: "Billed monthly",
  // Not a billing cycle. A credit purchase has no renewal date, and the page
  // this replaces had no way to say that.
  CREDIT: "Pay per evidence record",
  CONTRACT: "Billed by agreement",
};

export function describeModel(model: string): string {
  return MODEL_COPY[model] ?? "";
}

/**
 * A provider or lifecycle enum as a customer-readable label.
 *
 * The neutral vocabulary is the repository's, not this file's: an ABSENT value
 * is "Not configured" and an UNMAPPED one is "Status pending". Both exist so a
 * raw ALL_CAPS enum can never reach a pixel, and reusing the established words
 * means the product has ONE way of saying "we do not have a state for this"
 * rather than one per surface.
 */
export function statusLabel(status: string): string {
  const s = String(status ?? "").trim().toUpperCase();
  if (!s) return "Not configured";
  if (s === "SUCCEEDED") return "Paid";
  if (s === "FAILED") return "Failed";
  if (s === "REFUNDED") return "Refunded";
  if (s === "PENDING") return "Pending";
  if (s === "ACTIVE") return "Active";
  if (s === "PAST_DUE") return "Payment failed";
  if (s === "CANCELED" || s === "CANCELLED") return "Cancelled";
  if (s === "EXPIRED") return "Expired";
  // An unmapped provider value is never printed raw at a customer.
  return "Status pending";
}

export function statusTone(
  status: string,
): "verified" | "pending" | "risk" | "neutral" {
  const s = String(status ?? "").trim().toUpperCase();
  if (s === "SUCCEEDED" || s === "ACTIVE") return "verified";
  if (s === "PENDING" || s === "PAST_DUE") return "pending";
  if (s === "FAILED") return "risk";
  return "neutral";
}
