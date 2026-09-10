/**
 * PV-DEFECT-003 — AN UNCONFIGURED PAYMENT PROVIDER IS A BOUNDED STATE.
 *
 * A missing Stripe or PayPal setting used to reach `requireSecret` / `must()`
 * as a bare `Error("Required secret \"STRIPE_SECRET_KEY\" is not configured.")`.
 * The central handler could only read that as a crash: every checkout
 * answered 500 INTERNAL_SERVER_ERROR and paged critical, where the
 * integrations surface already answers the same class of condition with a
 * bounded 503.
 *
 * In Production the settings are present, so the finding is the SHAPE: a new
 * region, a rotated key or a misconfigured deploy turned every checkout into
 * a critical 500. Now it is `503 PAYMENTS_UNAVAILABLE`:
 *
 *   - the customer is told payments are unavailable, that nothing was charged
 *     (true — the failure precedes any provider call) and what to do next;
 *   - no secret NAME and no value reaches the client; the missing setting's
 *     name goes to the operator's log only, through the error's metadata;
 *   - the response hook raises a warning-level operational signal, because
 *     in an environment that should take payments this IS a regression — but
 *     it is not a crash and does not page as one.
 */

import { providerUnavailable, type DomainError } from "../../errors.js";

export const PAYMENTS_UNAVAILABLE_CODE = "PAYMENTS_UNAVAILABLE";

export const PAYMENTS_UNAVAILABLE_MESSAGE =
  "Payments are temporarily unavailable, and nothing was charged. Please try again later, or contact support if this continues.";

export function paymentsUnavailable(
  provider: "stripe" | "paypal",
  setting: string,
  reason: "not_configured" | "plan_not_configured" = "not_configured",
): DomainError {
  return providerUnavailable({
    code: PAYMENTS_UNAVAILABLE_CODE,
    message: PAYMENTS_UNAVAILABLE_MESSAGE,
    provider,
    reason,
    setting,
    developerMessage: `${provider} is not configured: ${setting} is missing`,
  });
}
