/**
 * BILLING ACTIVITY (2026-09-28) — what "Re-check purchases and billing" and
 * "Check status" say.
 *
 * The defect: a 401, a 404, an attempt PayPal never confirmed, or an outage
 * was reported as "Your provider is still settling a payment" / "a billing
 * item is still pending". These tests pin that "pending" is said ONLY for a
 * provider-confirmed open approval, and that the account-wide message says how
 * many items were checked, what changed and what still needs the customer.
 */

import { describe, expect, it } from "vitest";

import {
  describeAttemptRecheck,
  describeReconciliation,
  safePayPalResumeUrl,
} from "../../app/(app)/billing/_sections/billingMessages";
import type {
  CheckoutAttemptResult,
  ReconciliationResult,
} from "../../lib/api/billing-accounts";

function attempt(outcome: CheckoutAttemptResult["outcome"], over: Partial<CheckoutAttemptResult> = {}): CheckoutAttemptResult {
  return {
    attemptId: "a",
    product: "STORAGE",
    createdAtUtc: "2026-09-26T09:46:37.000Z",
    provider: "PAYPAL",
    providerBound: true,
    previousStatus: "PENDING",
    currentStatus: "PENDING",
    outcome,
    locallyAbandoned: false,
    ...over,
  };
}

function summary(over: Partial<NonNullable<ReconciliationResult["summary"]>>): ReconciliationResult {
  return {
    outcome: "ACTION_REQUIRED",
    summary: {
      checked: 0,
      creditsRestored: 0,
      paymentsRecorded: 0,
      subscriptionsUpdated: 0,
      pending: 0,
      actionRequired: 0,
      unavailable: 0,
      discrepancies: 0,
      attemptsUpdated: 0,
      attempts: [],
      ...over,
    },
  };
}

describe("account re-check message", () => {
  it("two 404 storage attempts (the production incident) are NOT called pending or settling", () => {
    const n = describeReconciliation(
      summary({
        checked: 2,
        actionRequired: 2,
        attempts: [attempt("PROVIDER_REFERENCE_NOT_FOUND"), attempt("PROVIDER_REFERENCE_NOT_FOUND")],
      }),
    );
    expect(n.message).toContain("Checked 2 items");
    expect(n.message).toContain("2 purchases could not be confirmed by the provider");
    expect(n.message).not.toMatch(/settling|pending|waiting for your approval/i);
    expect(n.message).toContain("Nothing was charged");
  });

  it("401, unbound and malformed are 'could not be confirmed', and an outage is 'could not be reached'", () => {
    const n = describeReconciliation(
      summary({
        checked: 4,
        actionRequired: 3,
        unavailable: 1,
        attempts: [
          attempt("PROVIDER_AUTHORIZATION_FAILED"),
          attempt("NOT_PROVIDER_BOUND", { providerBound: false }),
          attempt("PROVIDER_MALFORMED"),
          attempt("PROVIDER_UNAVAILABLE"),
        ],
      }),
    );
    expect(n.message).toContain("3 purchases could not be confirmed");
    expect(n.message).toContain("could not be reached for 1 item");
    expect(n.message).not.toMatch(/settling|pending/i);
  });

  it("only a provider-confirmed open approval is described as waiting", () => {
    const n = describeReconciliation(
      summary({ checked: 1, pending: 1, attempts: [attempt("STILL_PENDING")] }),
    );
    expect(n.message).toContain("1 purchase is still waiting for your approval at PayPal");
  });

  it("a change is reported as a change, with the credit count", () => {
    const n = describeReconciliation(
      summary({ checked: 3, creditsRestored: 1, paymentsRecorded: 1, attemptsUpdated: 1, attempts: [attempt("UPDATED")] }),
    );
    expect(n.message).toContain("3 records were updated");
    expect(n.message).toContain("1 evidence credit was added");
    expect(n.tone).toBe("success");
  });

  it("abandoned attempts the provider no longer knows are not reported as needing action", () => {
    const n = describeReconciliation(
      summary({
        checked: 2,
        attempts: [
          attempt("PROVIDER_REFERENCE_NOT_FOUND", { locallyAbandoned: true, currentStatus: "ABANDONED" }),
          attempt("PROVIDER_REFERENCE_NOT_FOUND", { locallyAbandoned: true, currentStatus: "ABANDONED" }),
        ],
      }),
    );
    expect(n.message).toContain("Everything on this account already matches");
    expect(n.message).not.toContain("could not be confirmed");
  });

  it("an all-outage run is an error, and says nothing was changed", () => {
    const n = describeReconciliation(summary({ checked: 2, unavailable: 2, attempts: [attempt("PROVIDER_UNAVAILABLE"), attempt("PROVIDER_UNAVAILABLE")] }));
    expect(n.tone).toBe("error");
    expect(n.message).toContain("left unchanged");
  });
});

describe("one attempt's Check status message", () => {
  it.each([
    ["PROVIDER_REFERENCE_NOT_FOUND", /no record of this checkout/],
    ["NOT_PROVIDER_BOUND", /never confirmed this checkout was created/],
    ["PROVIDER_UNAVAILABLE", /could not be reached.*unknown/],
    ["PROVIDER_AUTHORIZATION_FAILED", /could not confirm/],
    ["PROVIDER_MALFORMED", /could not confirm/],
  ] as const)("%s is described truthfully, never as settling/pending", (outcome, text) => {
    const n = describeAttemptRecheck(attempt(outcome));
    expect(n.message).toMatch(text);
    expect(n.message).not.toMatch(/settling|pending/i);
  });

  it("an open approval offers to continue only with a resume link", () => {
    expect(describeAttemptRecheck(attempt("STILL_PENDING", { resumeUrl: "https://www.paypal.com/x" })).message).toMatch(/continue at PayPal/);
    expect(describeAttemptRecheck(attempt("STILL_PENDING")).message).not.toMatch(/continue at PayPal/);
  });
});

describe("resume links", () => {
  it("only PayPal's own HTTPS pages are followed", () => {
    expect(safePayPalResumeUrl("https://www.paypal.com/webapps/billing/subscriptions?ba_token=X")).not.toBeNull();
    expect(safePayPalResumeUrl("https://www.sandbox.paypal.com/checkoutnow?token=X")).not.toBeNull();
    expect(safePayPalResumeUrl("http://www.paypal.com/x")).toBeNull();
    expect(safePayPalResumeUrl("https://paypal.com.evil.example/x")).toBeNull();
    expect(safePayPalResumeUrl("javascript:alert(1)")).toBeNull();
    expect(safePayPalResumeUrl(null)).toBeNull();
  });
});
