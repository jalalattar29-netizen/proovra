/**
 * `billing.provider_authorization` — raised and closed from EVERY observer.
 *
 * The platform condition "the payment provider refuses our credential" used to
 * be raised and closed only from a customer's per-payment Re-check / Abandon.
 * The reconciliation sweep and checkout-attempt recovery now report through
 * the same helper, which lives in its own module so they can import it
 * without a cycle through pending-payments.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { stampConditionMessage } from "@proovra/shared";

const recordIncident = vi.fn<(input: Record<string, unknown>) => Promise<unknown>>(async () => ({}));
const resolveConditionFromSourceRecovery = vi.fn<(input: Record<string, unknown>) => Promise<unknown>>(async () => ({
  resolved: true,
}));
const bump = vi.fn();

vi.mock("../src/services/observability/incident.service.js", () => ({
  recordIncident: (input: Record<string, unknown>) => recordIncident(input),
  resolveConditionFromSourceRecovery: (input: Record<string, unknown>) =>
    resolveConditionFromSourceRecovery(input),
}));
vi.mock("../src/services/ops/metrics.service.js", () => ({
  bump: (name: string) => bump(name),
}));

const signal = await import("../src/services/billing/provider-authorization-signal.service.js");
const pending = await import("../src/services/billing/pending-payments.service.js");

describe("provider-authorization signal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signal.resetProviderSignalThrottleForTests();
  });

  it("is still exported from pending-payments for existing callers", () => {
    expect(pending.recordProviderFailureSignal).toBe(signal.recordProviderFailureSignal);
    expect(pending.recordProviderObservationSuccess).toBe(signal.recordProviderObservationSuccess);
    expect(pending.providerAuthorizationFingerprint).toBe(signal.providerAuthorizationFingerprint);
  });

  it("a sweep observation refused with AUTHORIZATION_FAILED opens the PLATFORM condition", () => {
    signal.noteProviderObservation({
      provider: "STRIPE" as never,
      operation: "RECONCILE_ACCOUNT",
      observation: { state: "UNKNOWN", failure: "AUTHORIZATION_FAILED" },
      paymentId: "pay-1",
    });
    expect(bump).toHaveBeenCalledWith("billing_provider_authorization_failed_total");
    expect(recordIncident).toHaveBeenCalledTimes(1);
    const arg = recordIncident.mock.calls[0]![0];
    expect(arg).toMatchObject({
      sourceId: "billing.provider_authorization",
      teamId: null,
      platform: true,
      fingerprint: "billing-provider-auth:STRIPE",
    });
    expect(arg.message).toEqual({
      code: "ops.billing.provider_authorization",
      params: { provider: "STRIPE", operation: "RECONCILE_ACCOUNT" },
    });
    // The operation is a technical reference, never part of the sentence
    // (2026-10-14): the reader is told which provider and what it means.
    const summary = stampConditionMessage((arg as { message: { code: string; params: unknown } }).message)!.summary;
    expect(summary).toContain("Stripe");
    expect(summary).not.toMatch(/RECONCILE_ACCOUNT|STRIPE/);
    expect(resolveConditionFromSourceRecovery).not.toHaveBeenCalled();
  });

  it("an outage is counted but opens no condition", () => {
    signal.noteProviderObservation({
      provider: "PAYPAL" as never,
      operation: "RECHECK_CHECKOUT_ATTEMPT",
      observation: { state: "UNKNOWN", failure: "PROVIDER_UNAVAILABLE" },
    });
    expect(bump).toHaveBeenCalledWith("billing_provider_unavailable_total");
    expect(recordIncident).not.toHaveBeenCalled();
    expect(resolveConditionFromSourceRecovery).not.toHaveBeenCalled();
  });

  it("an answered observation closes the PLATFORM condition, throttled per provider", () => {
    signal.noteProviderObservation({
      provider: "PAYPAL" as never,
      operation: "RECONCILE_ACCOUNT",
      observation: { state: "SUCCEEDED" },
    });
    signal.noteProviderObservation({
      provider: "PAYPAL" as never,
      operation: "RECONCILE_ACCOUNT",
      observation: { state: "PENDING" },
    });
    expect(resolveConditionFromSourceRecovery).toHaveBeenCalledTimes(1);
    expect(resolveConditionFromSourceRecovery.mock.calls[0]![0]).toMatchObject({
      teamId: null,
      platform: true,
      fingerprint: "billing-provider-auth:PAYPAL",
    });
    // A different provider is not throttled by the first.
    signal.recordProviderObservationSuccess({ provider: "STRIPE" as never });
    expect(resolveConditionFromSourceRecovery).toHaveBeenCalledTimes(2);
  });

  it("a refusal clears the throttle, so the first success after it always closes", () => {
    signal.recordProviderObservationSuccess({ provider: "STRIPE" as never });
    signal.recordProviderFailureSignal({
      provider: "STRIPE" as never,
      operation: "RECONCILE_ACCOUNT",
      failure: "AUTHORIZATION_FAILED",
    });
    signal.recordProviderObservationSuccess({ provider: "STRIPE" as never });
    expect(resolveConditionFromSourceRecovery).toHaveBeenCalledTimes(2);
  });
});
