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
