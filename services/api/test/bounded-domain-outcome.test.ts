/**
 * BATCH C — THE BOUNDED-DOMAIN-ERROR CONVENTION.
 *
 * Two halves, both pinned here:
 *
 *   1. the builders in errors.ts return DomainErrors with the status,
 *      reportability and severity the convention promises — so a rejected
 *      input, a not-found, a conflict and an unconfigured provider cannot be
 *      mistaken for a crash by the central handler;
 *   2. the response hook's decision (http/bounded-outcome.ts) pages critical
 *      ONLY for faults: an unmarked >= 500, and any bare 500 whatever the
 *      mark. A declared OPERATIONAL_WARNING still reaches ops as a signal.
 *
 * The live proof that the three audited defects now answer 4xx/503 with no
 * critical alert is bounded-domain-errors.integration.test.ts.
 */
import { describe, expect, it } from "vitest";

import {
  conflictRefusal,
  classifyReportability,
  DomainError,
  inputRefusal,
  notFoundRefusal,
  providerUnavailable,
} from "../src/errors.js";
import {
  classifyCompletedResponse,
  type BoundedOutcome,
} from "../src/http/bounded-outcome.js";
import {
  PAYMENTS_UNAVAILABLE_CODE,
  paymentsUnavailable,
} from "../src/services/billing/payments-unavailable.js";

describe("the builders", () => {
  it("inputRefusal is a 400 expected denial, never paged", () => {
    const e = inputRefusal({ code: "X_INVALID", message: "Fix X.", developerMessage: "x was bad" });
    expect(e).toBeInstanceOf(DomainError);
    expect(e).toMatchObject({
      httpStatus: 400, publicCode: "X_INVALID", publicMessage: "Fix X.",
      reportability: "EXPECTED_DENIAL", severity: "info", message: "x was bad",
    });
    expect(classifyReportability(e)).toBe("EXPECTED_DENIAL");
  });

  it("conflictRefusal is a 409 and notFoundRefusal a 404 with a generic default body", () => {
    expect(conflictRefusal({ code: "C", message: "m" })).toMatchObject({ httpStatus: 409, reportability: "EXPECTED_DENIAL" });
    expect(notFoundRefusal()).toMatchObject({ httpStatus: 404, publicCode: "NOT_FOUND", publicMessage: "Not found." });
  });

  it("providerUnavailable is a 503 operational warning that keeps the setting OFF the wire", () => {
    const e = providerUnavailable({
      code: "P_UNAVAILABLE", message: "Try later.", provider: "p", reason: "not_configured", setting: "P_SECRET",
    });
    expect(e).toMatchObject({ httpStatus: 503, reportability: "OPERATIONAL_WARNING", severity: "warning" });
    expect(e.publicMessage).not.toContain("P_SECRET");
    expect(e.metadata).toEqual({ provider: "p", reason: "not_configured", setting: "P_SECRET" });
  });

  it("paymentsUnavailable names no secret to the customer and says nothing was charged", () => {
    for (const provider of ["stripe", "paypal"] as const) {
      const e = paymentsUnavailable(provider, "STRIPE_SECRET_KEY");
      expect(e.publicCode).toBe(PAYMENTS_UNAVAILABLE_CODE);
      expect(e.httpStatus).toBe(503);
      expect(e.publicMessage).not.toMatch(/STRIPE|PAYPAL|secret|key/i);
      expect(e.publicMessage).toMatch(/nothing was charged/i);
      expect(e.metadata.provider).toBe(provider);
    }
  });
});

describe("what a completed response means to the person on call", () => {
  const expected: BoundedOutcome = { code: "INTEGRATIONS_DISABLED", reportability: "EXPECTED_DENIAL", severity: "warning" };
  const regression: BoundedOutcome = { code: "PAYMENTS_UNAVAILABLE", reportability: "OPERATIONAL_WARNING", severity: "warning" };

  it("success and 4xx are not incidents", () => {
    expect(classifyCompletedResponse(200, null)).toBe("COMPLETED");
    expect(classifyCompletedResponse(400, null)).toBe("BUSINESS_ERROR");
    expect(classifyCompletedResponse(409, regression)).toBe("BUSINESS_ERROR");
  });

  it("an UNMARKED 5xx stays a critical infrastructure error — silence means something is wrong", () => {
    expect(classifyCompletedResponse(503, null)).toBe("INFRASTRUCTURE_ERROR");
    expect(classifyCompletedResponse(502, null)).toBe("INFRASTRUCTURE_ERROR");
  });

  it("a bare 500 is ALWAYS infrastructure, whatever a caller marked", () => {
    expect(classifyCompletedResponse(500, expected)).toBe("INFRASTRUCTURE_ERROR");
    expect(classifyCompletedResponse(500, regression)).toBe("INFRASTRUCTURE_ERROR");
  });

  it("a declared deliberate state is logged, not paged; a regression still signals", () => {
    expect(classifyCompletedResponse(503, expected)).toBe("BOUNDED_UNAVAILABLE");
    expect(classifyCompletedResponse(503, regression)).toBe("BOUNDED_UNAVAILABLE_SIGNAL");
  });
});
