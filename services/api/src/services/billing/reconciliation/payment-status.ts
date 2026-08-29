/**
 * BILLING SURFACE CORRECTION (2026-08-29) — THE payment status transition.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Six places learn what a payment is now: the Stripe webhook, the PayPal
 * webhook, the reconciliation sweep, the per-row re-check, the per-row cancel,
 * and the nightly job. Each of them held the same two rules in its head — a
 * settled payment never goes back to pending, a later fact beats an earlier
 * one — and `recordPayment` enforced neither: it wrote `status` unconditionally
 * on upsert, so a PayPal `APPROVAL_PENDING` retry arriving after the capture
 * had settled would move a SUCCEEDED row back to PENDING, and the customer's
 * history would say their paid subscription was still being processed.
 *
 * WHAT IT GUARANTEES
 * ---------------------------------------------------------------------------
 *   * IDEMPOTENT. Applying the same fact twice writes once. A webhook
 *     redelivered five times, or a customer pressing "Re-check" five times,
 *     produces one transition and four no-ops.
 *
 *   * MONOTONIC. A terminal status is never replaced by a non-terminal one.
 *     The single exception is the one real later-life transition money has:
 *     SUCCEEDED -> REFUNDED.
 *
 *   * ORDER-INSENSITIVE. When the provider's own timestamp for an observation
 *     is older than the timestamp already recorded on the row, the observation
 *     is discarded. Webhooks are not delivered in order, and a reconciliation
 *     poll is by definition looking at a moment already past.
 *
 * WHAT IT DELIBERATELY CANNOT DO
 * ---------------------------------------------------------------------------
 * Delete a payment row, or write a status from anything other than an
 * observation the provider produced. There is no "assume", no "probably" and
 * no local optimism anywhere in this file.
 */

import * as prismaPkg from "@prisma/client";

import type { ObservedState } from "./types.js";

const S = prismaPkg.PaymentStatus;

/**
 * Statuses that mean the transaction is FINISHED.
 *
 * PENDING is the only non-terminal one, which is why it is the only status a
 * row may be moved out of.
 */
export const TERMINAL_PAYMENT_STATUSES: ReadonlySet<prismaPkg.PaymentStatus> =
  new Set([
    S.SUCCEEDED,
    S.FAILED,
    S.REFUNDED,
    S.CANCELED,
    S.EXPIRED,
    // ABANDONED is terminal for the CUSTOMER — this product will not resume
    // that checkout — while remaining open to the provider proving settlement.
    // See `decidePaymentTransition`.
    S.ABANDONED,
  ]);

export function isTerminalPaymentStatus(
  status: prismaPkg.PaymentStatus,
): boolean {
  return TERMINAL_PAYMENT_STATUSES.has(status);
}

/**
 * An observed provider state as a local payment status, or null.
 *
 * `UNKNOWN` returns null and always will: an unreachable provider is not a
 * fact about a payment, and the whole point of the observation model is that
 * silence never becomes a status.
 */
export function paymentStatusFromObservedState(
  state: ObservedState,
): prismaPkg.PaymentStatus | null {
  switch (state) {
    case "SUCCEEDED":
      return S.SUCCEEDED;
    case "PENDING":
      return S.PENDING;
    case "FAILED":
      return S.FAILED;
    case "REFUNDED":
      return S.REFUNDED;
    case "CANCELED":
      return S.CANCELED;
    case "EXPIRED":
      return S.EXPIRED;
    case "UNKNOWN":
      return null;
  }
}

/**
 * ABANDONED has no observed state, deliberately.
 *
 * Every other status is something a PROVIDER told us. This one is something
 * the CUSTOMER told us — "I am not going to finish this" — and no provider
 * will ever report it back. Giving it an `ObservedState` would invite a future
 * adapter to claim it, which is precisely the lie this state exists to avoid.
 */
export const CUSTOMER_DECLARED_PAYMENT_STATUSES: ReadonlySet<prismaPkg.PaymentStatus> =
  new Set([S.ABANDONED]);

/**
 * A local payment status as the observation it corresponds to.
 *
 * Exists so the WEBHOOK path can use the same transition rules as the polling
 * path. A webhook has already decided what the payment is; expressing that as
 * an observation means both routes into the row go through
 * `decidePaymentTransition` and neither can regress it.
 */
export function observedStateFromPaymentStatus(
  status: prismaPkg.PaymentStatus,
): ObservedState {
  switch (status) {
    case S.ABANDONED:
      // Not a provider fact. Expressed as "we know nothing new", so a webhook
      // path that re-states it cannot overwrite anything.
      return "UNKNOWN";
    case S.SUCCEEDED:
      return "SUCCEEDED";
    case S.PENDING:
      return "PENDING";
    case S.FAILED:
      return "FAILED";
    case S.REFUNDED:
      return "REFUNDED";
    case S.CANCELED:
      return "CANCELED";
    case S.EXPIRED:
      return "EXPIRED";
  }
}

export type PaymentTransitionInput = {
  current: prismaPkg.PaymentStatus;
  /** The provider's own timestamp for the state already recorded, if any. */
  currentObservedAtUtc: Date | null;
  observed: ObservedState;
  /** The provider's own timestamp for the observation being applied. */
  observedAtUtc: Date | null;
};

export type PaymentTransition =
  | { apply: true; status: prismaPkg.PaymentStatus }
  | {
      apply: false;
      reason:
        | "NOTHING_LEARNED"
        | "ALREADY_THAT_STATUS"
        | "TERMINAL_NOT_REGRESSED"
        | "OBSERVATION_IS_OLDER";
    };

/**
 * Decide whether an observation may be written, and as what.
 *
 * Pure. The caller does the writing, so this can be exercised exhaustively
 * without a database and cannot be bypassed by a caller that "just needs to
 * set the status this once".
 */
export function decidePaymentTransition(
  input: PaymentTransitionInput,
): PaymentTransition {
  const next = paymentStatusFromObservedState(input.observed);
  if (next === null) return { apply: false, reason: "NOTHING_LEARNED" };
  if (next === input.current) {
    return { apply: false, reason: "ALREADY_THAT_STATUS" };
  }

  // Ordering first: an older fact may not overwrite a newer one whatever it
  // says. A missing timestamp on either side means "no ordering information",
  // and the remaining rules decide.
  if (
    input.observedAtUtc &&
    input.currentObservedAtUtc &&
    input.observedAtUtc.getTime() < input.currentObservedAtUtc.getTime()
  ) {
    return { apply: false, reason: "OBSERVATION_IS_OLDER" };
  }

  if (isTerminalPaymentStatus(input.current)) {
    // The one transition a finished payment genuinely has. Everything else —
    // a late PENDING, a re-observed CANCELED over a SUCCEEDED, a FAILED after
    // settlement — is a stale or contradictory fact, and the recorded one
    // stands.
    if (input.current === S.SUCCEEDED && next === S.REFUNDED) {
      return { apply: true, status: next };
    }

    /*
     * ABANDONED yields to money that actually moved.
     *
     * It records the CUSTOMER's intention not to finish a checkout, taken only
     * after a reconciliation found no capture and no authorization. That is a
     * statement about a person, and a person can be overtaken by events: if
     * the provider later proves the payment settled — a capture that was in
     * flight, a webhook that arrived late — the settlement is a fact and the
     * intention is not. Anything OTHER than settlement leaves it alone, so a
     * later PENDING or FAILED cannot reopen a row the customer has walked away
     * from.
     */
    if (input.current === S.ABANDONED && next === S.SUCCEEDED) {
      return { apply: true, status: next };
    }

    return { apply: false, reason: "TERMINAL_NOT_REGRESSED" };
  }

  return { apply: true, status: next };
}
