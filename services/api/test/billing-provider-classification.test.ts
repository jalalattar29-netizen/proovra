/**
 * BILLING PAYMENT LIFECYCLE — how a provider failure is CLASSIFIED, and what a
 * customer can do about each kind.
 *
 * THE DEFECT THESE PIN
 * ---------------------------------------------------------------------------
 * Every PayPal and Stripe failure was caught by a bare `catch {}` and reported
 * as PROVIDER_UNAVAILABLE — a claim about the network. Three of the four ways
 * these calls fail are not outages:
 *
 *   * 401/403 — the provider refused US. An operator problem; no amount of
 *     waiting helps, and nobody was told.
 *   * 404 — the provider has never heard of the reference we stored. Re-check
 *     will keep returning the same answer for ever.
 *   * 400/422 — a reference no endpoint accepts, typically a legacy row. Also
 *     unresolvable by waiting.
 *
 * Telling a customer "try again shortly" in those three cases sends them round
 * a loop with no exit — which is the loop the abandon action exists to break.
 */

import { describe, expect, it } from "vitest";
import * as prismaPkg from "@prisma/client";

import { PayPalHttpError } from "../src/services/paypal.service.js";
import { StripeHttpError } from "../src/services/stripe.service.js";
import {
  classifyPayPalFailure,
  isAskablePayPalReference,
  payPalFailureDiagnostics,
} from "../src/services/billing/reconciliation/paypal.provider.js";
import {
  classifyStripeFailure,
  stripeFailureDiagnostics,
} from "../src/services/billing/reconciliation/stripe.provider.js";
import { recheckOutcomeForFailure } from "../src/services/billing/pending-payments.service.js";

const payPal = (status: number, name = "SOME_ERROR") =>
  new PayPalHttpError({
    message: `PayPal GET error: ${name}`,
    status,
    providerErrorName: name,
    debugId: "debug-123",
  });

const stripe = (status: number, name = "some_error") =>
  new StripeHttpError({
    message: "Stripe error: {}",
    status,
    providerErrorName: name,
    debugId: "req_123",
  });

// ===========================================================================
// 1. Classification
// ===========================================================================

describe("a PayPal failure is classified by what it actually is", () => {
  it("treats a 5xx as an outage", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyPayPalFailure(payPal(status))).toBe("PROVIDER_UNAVAILABLE");
    }
  });

  it("treats a network or timeout error as an outage", () => {
    // A non-HTTP throw is DNS, a timeout, a reset socket — the one case where
    // "try again shortly" is real advice.
    expect(classifyPayPalFailure(new Error("ETIMEDOUT"))).toBe("PROVIDER_UNAVAILABLE");
    expect(classifyPayPalFailure(new TypeError("fetch failed"))).toBe(
      "PROVIDER_UNAVAILABLE",
    );
  });

  it("treats 401 and 403 as OUR authorization problem, not an outage", () => {
    for (const status of [401, 403]) {
      expect(classifyPayPalFailure(payPal(status, "NOT_AUTHORIZED"))).toBe(
        "AUTHORIZATION_FAILED",
      );
    }
  });

  it("treats 404 as a reference the provider has never heard of", () => {
    expect(classifyPayPalFailure(payPal(404, "RESOURCE_NOT_FOUND"))).toBe("NOT_FOUND");
  });

  it("treats 400 and 422 as a reference no endpoint accepts", () => {
    for (const status of [400, 422]) {
      expect(classifyPayPalFailure(payPal(status, "INVALID_RESOURCE_ID"))).toBe(
        "REFERENCE_INVALID",
      );
    }
  });
});

describe("a Stripe failure is classified the same way", () => {
  it("separates the four kinds", () => {
    expect(classifyStripeFailure(stripe(503))).toBe("PROVIDER_UNAVAILABLE");
    expect(classifyStripeFailure(stripe(401, "api_key_expired"))).toBe(
      "AUTHORIZATION_FAILED",
    );
    expect(classifyStripeFailure(stripe(404, "resource_missing"))).toBe("NOT_FOUND");
    expect(classifyStripeFailure(stripe(400, "parameter_invalid_string"))).toBe(
      "REFERENCE_INVALID",
    );
    expect(classifyStripeFailure(new Error("socket hang up"))).toBe(
      "PROVIDER_UNAVAILABLE",
    );
  });
});

describe("an unaskable reference is refused before the provider is called", () => {
  it("recognises a blank or whitespace reference", () => {
    // A legacy row can carry one. Calling PayPal with it produces a 404 that
    // reads as "your payment does not exist" rather than "we never recorded
    // where to look for it".
    expect(isAskablePayPalReference("")).toBe(false);
    expect(isAskablePayPalReference("   ")).toBe(false);
    expect(isAskablePayPalReference("5O190127TN364715T")).toBe(true);
  });
});

// ===========================================================================
// 2. Diagnostics carry what an operator needs and nothing more
// ===========================================================================

describe("failure diagnostics", () => {
  it("carry the provider's status, error name and correlation id", () => {
    const d = payPalFailureDiagnostics(payPal(404, "RESOURCE_NOT_FOUND"), {
      operation: "RECHECK_PAYMENT",
      referenceKind: "ORDER",
    });
    expect(d).toMatchObject({
      provider: "PAYPAL",
      operation: "RECHECK_PAYMENT",
      referenceKind: "ORDER",
      httpStatus: 404,
      providerErrorName: "RESOURCE_NOT_FOUND",
      providerDebugId: "debug-123",
      failure: "NOT_FOUND",
    });
  });

  it("carry NO token, secret, header or response body", () => {
    const diagnostics = [
      payPalFailureDiagnostics(payPal(401), {
        operation: "RECHECK_PAYMENT",
        referenceKind: "ORDER",
      }),
      stripeFailureDiagnostics(stripe(401), {
        operation: "RECHECK_PAYMENT",
        referenceKind: "SESSION",
      }),
    ];

    // The KEYS are an allowlist: a field cannot be added here without the
    // person adding it deciding, deliberately, that it is safe to log.
    for (const d of diagnostics) {
      expect(Object.keys(d).sort()).toEqual(
        [
          "failure",
          "httpStatus",
          "operation",
          "provider",
          "providerDebugId",
          "providerErrorName",
          "referenceKind",
        ].sort(),
      );
    }

    // And the VALUES carry nothing that could be a credential. The scan is
    // over values rather than the whole blob because `failure` legitimately
    // reads AUTHORIZATION_FAILED — a classification, not a header.
    const values = diagnostics
      .flatMap((d) => Object.values(d))
      .map((v) => String(v).toLowerCase());
    for (const value of values) {
      for (const forbidden of ["bearer", "secret", "cookie", "access_token", "client_id"]) {
        expect(value).not.toContain(forbidden);
      }
    }
  });

  it("say nothing when the throw was not an HTTP failure", () => {
    const d = payPalFailureDiagnostics(new Error("ECONNRESET"), {
      operation: "ABANDON_PAYMENT",
      referenceKind: "ORDER",
    });
    // A status we do not have is null, never a substituted zero.
    expect(d.httpStatus).toBeNull();
    expect(d.providerErrorName).toBeNull();
    expect(d.failure).toBe("PROVIDER_UNAVAILABLE");
  });
});

// ===========================================================================
// 3. What the customer is told
// ===========================================================================

describe("the re-check outcome for each failure", () => {
  it("distinguishes all four, and defaults safely", () => {
    expect(recheckOutcomeForFailure("PROVIDER_UNAVAILABLE")).toBe("PROVIDER_UNAVAILABLE");
    expect(recheckOutcomeForFailure("NOT_FOUND")).toBe("PROVIDER_REFERENCE_NOT_FOUND");
    expect(recheckOutcomeForFailure("REFERENCE_INVALID")).toBe(
      "PROVIDER_REFERENCE_INVALID",
    );
    expect(recheckOutcomeForFailure("AUTHORIZATION_FAILED")).toBe(
      "PROVIDER_AUTHORIZATION_FAILED",
    );

    // A failure this version does not model, and the absence of one, both land
    // on the only safe default: it changes nothing and claims nothing.
    expect(recheckOutcomeForFailure("PROVIDER_MALFORMED")).toBe("PROVIDER_UNAVAILABLE");
    expect(recheckOutcomeForFailure(undefined)).toBe("PROVIDER_UNAVAILABLE");
  });
});

// ===========================================================================
// 4. The provider enum is still what the domain reasons in
// ===========================================================================

describe("providers", () => {
  it("has exactly the two this classification covers", () => {
    expect(Object.values(prismaPkg.PaymentProvider).sort()).toEqual([
      "PAYPAL",
      "STRIPE",
    ]);
  });
});
