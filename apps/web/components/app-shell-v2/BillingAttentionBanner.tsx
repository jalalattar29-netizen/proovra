"use client";

/**
 * PRO-N1-13 (WS-BILL, 2026-11-18) — one shell banner when the person's OWN
 * paid plan needs attention: a failed payment in its grace window, grace
 * over, a lapsed plan, or a cancellation with its end date. It links to
 * Billing, where the payment can be fixed or the plan restarted.
 *
 * Reads only `envelope.account.billingSignal`, which the API projects from
 * the canonical lifecycle verdict for the requester's own account (never
 * another payer's). An API that predates the field sends nothing and this
 * renders nothing.
 */

import Link from "next/link";

import { usePlatformContext } from "../../lib/platform-context";
import type { AccountBillingSignal } from "../../lib/platform-context/types";
import { formatUserDateTime } from "../../lib/date";
import { ProovraBanner } from "../feedback/ProovraBanner";

export function billingAttentionCopy(signal: AccountBillingSignal): {
  severity: "warning" | "info";
  title: string;
  body: string;
} {
  switch (signal.state) {
    case "PAST_DUE":
      return {
        severity: "warning",
        title: "Payment overdue",
        body: signal.graceEndsAtUtc
          ? `We could not take your last payment. Your paid plan continues until ${formatUserDateTime(signal.graceEndsAtUtc)} while the payment is retried; update your payment details in Billing to keep it.`
          : "We could not take your last payment. Update your payment details in Billing to keep your paid plan.",
      };
    case "PAST_DUE_EXPIRED":
      return {
        severity: "warning",
        title: "Paid plan paused: payment overdue",
        body: "Your last payment was not received and the grace period has ended, so paid actions are paused. Your records stay readable. Open Billing to settle the payment.",
      };
    case "LAPSED":
      return {
        severity: "warning",
        title: "Paid plan needs attention",
        body: "Your paid plan is no longer active, so paid actions are paused. Your records stay readable. Open Billing to see what happened and what you can do.",
      };
    case "CANCELLING":
      return {
        severity: "info",
        title: "Your plan is set to end",
        body: signal.endsAtUtc
          ? `Your subscription was cancelled and ends on ${formatUserDateTime(signal.endsAtUtc)}. You can restart it in Billing before then.`
          : "Your subscription was cancelled and ends at the end of the paid period. You can restart it in Billing before then.",
      };
  }
}

export function BillingAttentionBanner() {
  const ctx = usePlatformContext();
  const signal = ctx.envelope?.account?.billingSignal ?? null;
  if (!signal) return null;
  const copy = billingAttentionCopy(signal);
  return (
    <div data-billing-attention-banner data-billing-state={signal.state}>
      <ProovraBanner severity={copy.severity} title={copy.title}>
        {copy.body}{" "}
        <Link href="/billing" style={{ fontWeight: 600, textDecoration: "underline" }}>
          Open Billing
        </Link>
      </ProovraBanner>
    </div>
  );
}
