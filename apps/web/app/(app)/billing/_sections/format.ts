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
  EvidenceAdmission,
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
      // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — being OVER the
      // allowance is said in words, not left as an impossible-looking sum.
      //
      // "176 of 127" reads as a broken counter, and the first thing anyone
      // does with it is stop trusting the page. It is not broken: holding more
      // than your plan includes is a real and legitimate state — a customer who
      // moved down a tier keeps everything they recorded on the higher one, and
      // a grandfathered account can sit above a limit it was never subject to.
      //
      // What that state means is specific and worth saying: nothing was
      // removed, and nothing more may be added until there is room. Saying it
      // here also stops the number being read as a bill.
      if (meter.used > meter.limit) {
        const over = meter.used - meter.limit;

        // The RESOLUTION differs by what kind of allowance this is, and saying
        // the wrong one is worse than saying nothing.
        //
        // A ROLLING allowance refills: records age out of the window on their
        // own, so "wait" is a real answer and the customer needs to know that
        // is what is happening.
        //
        // A LIFETIME allowance does NOT refill. The first version of this text
        // told everyone they could "add more once you are back within the
        // allowance", which for a lifetime cap describes a mechanism the
        // product does not offer — there is no supported way to get back under
        // it, and a customer who waited would wait for ever. The honest answer
        // there is the one that actually works: move up a tier, or buy a
        // credit for the next record.
        const resolution =
          meter.window === "ROLLING_30_DAYS"
            ? "Records leave this window as they age, and capacity returns with them."
            : "This allowance does not reset. Moving up a plan, or buying an evidence credit, is what makes room for the next record.";

        // BILLING SURFACE CORRECTION (2026-08-29) — this no longer says "your
        // plan includes". On a personal LIFETIME allowance the enforced number
        // can be a grandfathered per-account limit rather than the plan's, and
        // that case is now described in full by `describeEvidenceAdmission`
        // from the server's own projection. What survives here is the ROLLING
        // window and any meter that arrives without an admission, so the
        // sentence says what is certain: the allowance in force, not whose it
        // is.
        return {
          headline: `${meter.used.toLocaleString()} ${suffix}`,
          detail: `${over.toLocaleString()} more than the ${meter.limit.toLocaleString()} allowed here. Nothing has been removed. ${resolution}`,
          ratio: 1,
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

export type EvidencePresentation = {
  /** The count, and the denominator only when there really is one. */
  headline: string;
  /** The cap explained. Null when the headline already said everything. */
  breakdown: string | null;
  /** What permits the NEXT record. Never null — there is always an answer. */
  next: string;
  tone: "neutral" | "pending";
  ratio: number | null;
  /** The offer that answers `next`, or null when no action is needed. */
  action: "BUY_CREDITS" | "SEE_PLANS" | null;
};

/**
 * The evidence allowance, said in parts.
 *
 * BILLING SURFACE CORRECTION (2026-08-29) — this replaces `describeMeter` for
 * the personal lifetime allowance, because that formatter had one number to
 * work with and three different things to say with it. It rendered:
 *
 *     176 lifetime records
 *     49 over the 127 your plan includes. Nothing has been removed.
 *     Moving up a plan, or buying an evidence credit, is what makes room
 *     for the next record.
 *
 * beside a wallet reading "0 credits available", and none of it held up:
 *
 *   * "the 127 your plan includes" — the plan includes 100. 127 is a
 *     GRANDFATHERED per-account limit that `resolveCommercialContext`
 *     substitutes for the plan cap. The page told a customer their plan was
 *     something it is not, and no plan page would ever agree with it.
 *   * "49 over" read as a debt of 49 to clear, next to an offer of one credit.
 *     Admission never compares that deficit against anything: past the
 *     allowance, EVERY further record costs exactly one credit, whether the
 *     account is one over or fifty.
 *   * "Moving up a plan ... makes room" is only half true. A bigger plan does
 *     raise the included allowance; on a grandfathered account it may not move
 *     it past where the account already is. The credit always works.
 *
 * So the parts arrive separately from the server and are stated separately
 * here. `next` is not computed in this file: it is the SAME decision
 * `resolvePersonalEvidenceAdmission` gives the enforcement gate, resolved once
 * on the server, so the sentence about the next record and the gate's answer
 * to the next record cannot disagree.
 */
export function describeEvidenceAdmission(
  a: EvidenceAdmission,
  options: { canBuyCredits: boolean; hasPlanOffer: boolean },
): EvidencePresentation {
  const held = a.recordsHeld.toLocaleString();
  const cap = a.effectiveLifetimeCap;
  const credits = a.creditsAvailable;

  const headline =
    cap === null || a.overCap
      ? `${held} lifetime records`
      : `${held} of ${cap.toLocaleString()} included lifetime records`;

  // ---- the cap, when the enforced cap is not what the plan includes -------
  const parts: string[] = [];
  if (
    a.capSource === "LEGACY_RECORD_CAP_OVERRIDE" &&
    a.planIncludedLifetime !== null &&
    cap !== null &&
    a.planIncludedLifetime !== cap
  ) {
    parts.push(
      `Your plan includes ${a.planIncludedLifetime.toLocaleString()} records. This account keeps a higher agreed limit of ${cap.toLocaleString()}.`,
    );
  }
  if (a.overCap && cap !== null) {
    const over = (a.recordsHeld - cap).toLocaleString();
    parts.push(
      a.capSource === "LEGACY_RECORD_CAP_OVERRIDE"
        ? `You hold ${over} more than that. Nothing has been removed.`
        : `That is ${over} more than the ${cap.toLocaleString()} your plan includes. Nothing has been removed.`,
    );
  }

  // ---- what permits the next record --------------------------------------
  let next: string;
  if (a.next.allowed) {
    if (a.next.funding === "PLAN") {
      next =
        a.planCapacityRemaining === null
          ? "No record limit on your plan."
          : `${a.planCapacityRemaining.toLocaleString()} more record${
              a.planCapacityRemaining === 1 ? "" : "s"
            } included.`;
    } else {
      next = `Your included records are used up. The next record uses 1 of your ${credits.toLocaleString()} credit${
        credits === 1 ? "" : "s"
      } — one credit per record.`;
    }
  } else if (a.next.reason === "CREDIT_REQUIRED_NONE_AVAILABLE") {
    next = "This account records with credits. One evidence credit covers the next record.";
  } else {
    next =
      "Your included records are used up. One evidence credit covers the next record; a larger plan raises the included allowance.";
  }

  const ratio =
    cap === null ? null : a.overCap ? 1 : cap > 0 ? Math.min(1, a.recordsHeld / cap) : null;

  // Warning, not alarm. Being at or past a lifetime allowance is a normal
  // commercial state with a normal remedy; the destructive tone belongs to
  // things that destroy something, and nothing here does.
  const tone: "neutral" | "pending" =
    !a.next.allowed || (ratio !== null && ratio >= 0.8) ? "pending" : "neutral";

  // The action is only offered when the SERVER says the offer exists.
  const needsAction = !a.next.allowed || (a.next.allowed && a.next.funding === "EVIDENCE_CREDIT");
  const action: EvidencePresentation["action"] = !needsAction
    ? null
    : options.canBuyCredits
      ? "BUY_CREDITS"
      : options.hasPlanOffer
        ? "SEE_PLANS"
        : null;

  return { headline, breakdown: parts.length > 0 ? parts.join(" ") : null, next, tone, ratio, action };
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
