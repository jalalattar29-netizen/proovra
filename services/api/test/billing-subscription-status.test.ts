import { describe, expect, it } from "vitest";

import {
  decideSubscriptionStatusWrite,
  decideSubscriptionTransition,
  observedStateFromSubscriptionStatus,
} from "../src/services/billing/subscription-status.js";

const T0 = new Date("2026-09-01T00:00:00.000Z");
const T1 = new Date("2026-09-01T00:00:01.000Z");

describe("subscription provider-state ordering", () => {
  it("ACTIVE ignores an older APPROVAL_PENDING/CREATED equivalent", () => {
    expect(
      decideSubscriptionTransition({
        current: "ACTIVE",
        currentObservedAtUtc: T1,
        observed: "PENDING",
        observedAtUtc: T0,
      }),
    ).toMatchObject({ apply: false, reason: "OBSERVATION_IS_OLDER" });
  });

  it("ACTIVE is not regressed to TRIALING even without timestamps", () => {
    expect(
      decideSubscriptionTransition({
        current: "ACTIVE",
        currentObservedAtUtc: null,
        observed: "PENDING",
        observedAtUtc: null,
      }),
    ).toMatchObject({ apply: false, reason: "AUTHORITATIVE_NOT_REGRESSED" });
  });

  it("CANCELED ignores an older ACTIVE event", () => {
    expect(
      decideSubscriptionTransition({
        current: "CANCELED",
        currentObservedAtUtc: T1,
        observed: "SUCCEEDED",
        observedAtUtc: T0,
      }),
    ).toMatchObject({ apply: false, reason: "OBSERVATION_IS_OLDER" });
  });

  it("CANCELED is terminal even when an ACTIVE event lacks ordering metadata", () => {
    expect(
      decideSubscriptionTransition({
        current: "CANCELED",
        currentObservedAtUtc: null,
        observed: "SUCCEEDED",
        observedAtUtc: null,
      }),
    ).toMatchObject({ apply: false, reason: "TERMINAL_NOT_REGRESSED" });
  });

  it("CANCELED can yield to newer provider-proven activation", () => {
    expect(
      decideSubscriptionTransition({
        current: "CANCELED",
        currentObservedAtUtc: T0,
        observed: "SUCCEEDED",
        observedAtUtc: T1,
      }),
    ).toEqual({ apply: true, status: "ACTIVE" });
  });

  it("equal timestamp with different status is not treated as newer", () => {
    expect(
      decideSubscriptionTransition({
        current: "ACTIVE",
        currentObservedAtUtc: T1,
        observed: "PENDING",
        observedAtUtc: T1,
      }),
    ).toMatchObject({ apply: false, reason: "OBSERVATION_IS_NOT_NEWER" });
  });

  it("webhook replay of the same status is idempotent", () => {
    expect(
      decideSubscriptionTransition({
        current: "ACTIVE",
        currentObservedAtUtc: T1,
        observed: observedStateFromSubscriptionStatus("ACTIVE"),
        observedAtUtc: T1,
      }),
    ).toMatchObject({ apply: false, reason: "ALREADY_THAT_STATUS" });
  });

  it("TRIALING advances to ACTIVE on newer provider activation", () => {
    expect(
      decideSubscriptionTransition({
        current: "TRIALING",
        currentObservedAtUtc: T0,
        observed: "SUCCEEDED",
        observedAtUtc: T1,
      }),
    ).toEqual({ apply: true, status: "ACTIVE" });
  });
});

describe("ET-COM-01 — a reconciliation stamp can never swallow a later cancellation", () => {
  // The production sequence: the reconciler agrees with Stripe at R and (pre-fix)
  // stamps providerStateAtUtc with the FUTURE current_period_end. A cancellation
  // created at C (R < C < period end) is applied at D.
  const R = new Date("2026-09-01T10:00:00Z");
  const C = new Date("2026-09-05T10:00:00Z");
  const D = new Date("2026-09-05T10:00:05Z");
  const PERIOD_END = new Date("2026-09-30T10:00:00Z");

  it("a pre-fix future stamp is not ordering information: the cancellation applies", () => {
    expect(
      decideSubscriptionStatusWrite({ current: "ACTIVE", currentObservedAtUtc: PERIOD_END, next: "CANCELED", observedAtUtc: C, now: D }),
    ).toEqual({ apply: true, status: "CANCELED" });
    expect(
      decideSubscriptionStatusWrite({ current: "ACTIVE", currentObservedAtUtc: PERIOD_END, next: "PAST_DUE", observedAtUtc: C, now: D }),
    ).toMatchObject({ apply: true });
  });

  it("a post-fix read-time stamp orders correctly: a later event applies, an earlier one is refused", () => {
    expect(
      decideSubscriptionStatusWrite({ current: "ACTIVE", currentObservedAtUtc: R, next: "CANCELED", observedAtUtc: C, now: D }),
    ).toEqual({ apply: true, status: "CANCELED" });
    expect(
      decideSubscriptionStatusWrite({ current: "ACTIVE", currentObservedAtUtc: C, next: "CANCELED", observedAtUtc: R, now: D }),
    ).toEqual({ apply: false, reason: "OBSERVATION_IS_OLDER" });
  });
});
