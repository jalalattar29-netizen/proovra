import { describe, expect, it } from "vitest";

import {
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
