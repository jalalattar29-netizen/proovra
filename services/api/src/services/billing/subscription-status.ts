import * as prismaPkg from "@prisma/client";

import type { ObservedState } from "./reconciliation/types.js";

const S = prismaPkg.SubscriptionStatus;

export type SubscriptionTransitionInput = {
  current: prismaPkg.SubscriptionStatus;
  currentObservedAtUtc: Date | null;
  observed: ObservedState;
  observedAtUtc: Date | null;
};

export type SubscriptionTransition =
  | { apply: true; status: prismaPkg.SubscriptionStatus }
  | {
      apply: false;
      reason:
        | "NOTHING_LEARNED"
        | "ALREADY_THAT_STATUS"
        | "OBSERVATION_IS_OLDER"
        | "OBSERVATION_IS_NOT_NEWER"
        | "TERMINAL_NOT_REGRESSED"
        | "AUTHORITATIVE_NOT_REGRESSED";
    };

export function subscriptionStatusFromObservedState(
  state: ObservedState,
): prismaPkg.SubscriptionStatus | null {
  switch (state) {
    case "SUCCEEDED":
      return S.ACTIVE;
    case "PENDING":
      return S.TRIALING;
    case "FAILED":
    case "CANCELED":
    case "EXPIRED":
      return S.CANCELED;
    case "REFUNDED":
    case "UNKNOWN":
      return null;
  }
}

export function observedStateFromSubscriptionStatus(
  status: prismaPkg.SubscriptionStatus,
): ObservedState {
  switch (status) {
    case S.ACTIVE:
      return "SUCCEEDED";
    case S.TRIALING:
      return "PENDING";
    case S.PAST_DUE:
      return "FAILED";
    case S.CANCELED:
      return "CANCELED";
  }
}

/**
 * BILLING PAYPAL INTEGRITY (2026-09-28) — THE status-write decision for
 * `upsertSubscription`, on the statuses themselves.
 *
 * `decideSubscriptionTransition` (below) reasons over OBSERVED states, where a
 * PAST_DUE write maps to FAILED and FAILED maps back to CANCELED. A PAST_DUE
 * arriving for a CANCELED row therefore looked like "ALREADY_THAT_STATUS",
 * skipped the ordering check, and was written — reopening a terminated
 * subscription as live. This decision compares real statuses:
 *
 *   * an observation OLDER than the recorded provider time never writes;
 *   * CANCELED is reopened only by ACTIVE, and only with a provider time that
 *     is newer than the recorded one (or when no provider time was ever
 *     recorded — a LOCAL abandonment writes none, see
 *     `terminalizePendingPlanCheckout`); PAST_DUE and TRIALING never reopen it;
 *   * TRIALING never demotes ACTIVE or PAST_DUE.
 *
 * `apply: true` with the same status means "refresh the other fields".
 */
export function decideSubscriptionStatusWrite(input: {
  current: prismaPkg.SubscriptionStatus;
  currentObservedAtUtc: Date | null;
  next: prismaPkg.SubscriptionStatus;
  observedAtUtc: Date | null;
}): SubscriptionTransition {
  const { current, next } = input;
  const incoming = input.observedAtUtc?.getTime() ?? null;
  const recorded = input.currentObservedAtUtc?.getTime() ?? null;

  if (incoming !== null && recorded !== null && incoming < recorded) {
    return { apply: false, reason: "OBSERVATION_IS_OLDER" };
  }
  if (next === current) return { apply: true, status: next };
  if (incoming !== null && recorded !== null && incoming === recorded) {
    return { apply: false, reason: "OBSERVATION_IS_NOT_NEWER" };
  }

  if (current === S.CANCELED) {
    if (next === S.ACTIVE && incoming !== null && (recorded === null || incoming > recorded)) {
      return { apply: true, status: next };
    }
    return { apply: false, reason: "TERMINAL_NOT_REGRESSED" };
  }

  if (next === S.TRIALING && (current === S.ACTIVE || current === S.PAST_DUE)) {
    return { apply: false, reason: "AUTHORITATIVE_NOT_REGRESSED" };
  }

  return { apply: true, status: next };
}

export function decideSubscriptionTransition(
  input: SubscriptionTransitionInput,
): SubscriptionTransition {
  const next = subscriptionStatusFromObservedState(input.observed);
  if (!next) return { apply: false, reason: "NOTHING_LEARNED" };
  if (next === input.current) {
    return { apply: false, reason: "ALREADY_THAT_STATUS" };
  }

  if (input.observedAtUtc && input.currentObservedAtUtc) {
    const incoming = input.observedAtUtc.getTime();
    const recorded = input.currentObservedAtUtc.getTime();
    if (incoming < recorded) {
      return { apply: false, reason: "OBSERVATION_IS_OLDER" };
    }
    if (incoming === recorded) {
      return { apply: false, reason: "OBSERVATION_IS_NOT_NEWER" };
    }
  }

  if (input.current === S.CANCELED) {
    if (
      next === S.ACTIVE &&
      input.observedAtUtc &&
      input.currentObservedAtUtc &&
      input.observedAtUtc.getTime() > input.currentObservedAtUtc.getTime()
    ) {
      return { apply: true, status: next };
    }
    return { apply: false, reason: "TERMINAL_NOT_REGRESSED" };
  }

  if (
    next === S.TRIALING &&
    (input.current === S.ACTIVE || input.current === S.PAST_DUE)
  ) {
    return { apply: false, reason: "AUTHORITATIVE_NOT_REGRESSED" };
  }

  return { apply: true, status: next };
}
