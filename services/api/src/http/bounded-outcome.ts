/**
 * WCC-NEW-002 — WHAT A COMPLETED RESPONSE MEANS TO THE PERSON ON CALL.
 *
 * The response hook paged `severity: critical` for EVERY status >= 500. That
 * included answers the platform chose deliberately and bounded: the
 * integrations surface's 503 INTEGRATIONS_DISABLED, a payment provider that is
 * not configured in this environment, a DomainError declared
 * OPERATIONAL_WARNING. Paging on those is how an operator learns to ignore the
 * page that matters.
 *
 * A route or the central error handler MARKS a response it answered as a
 * declared bounded outcome; the hook reads the mark and decides:
 *
 *   < 400                                   → completed
 *   400–499                                 → business error (warn)
 *   500                                     → infrastructure error, ALWAYS —
 *                                             a bounded outcome never answers
 *                                             a bare 500
 *   >= 501, marked OPERATIONAL_WARNING      → warn + a warning-level
 *                                             operational SIGNAL (a config
 *                                             regression still reaches ops)
 *   >= 501, marked EXPECTED_DENIAL/SECURITY → warn only (a deliberate state)
 *   >= 501, unmarked                        → infrastructure error, critical
 *
 * Unmarked stays critical. Silence keeps meaning "something is wrong".
 */

import type { FastifyRequest } from "fastify";

import type { DomainErrorSeverity, ErrorReportability } from "../errors.js";

export type BoundedOutcome = {
  code: string;
  reportability: Exclude<ErrorReportability, "UNEXPECTED">;
  severity: DomainErrorSeverity;
};

const BOUNDED = new WeakMap<object, BoundedOutcome>();

/** Declare that this request's failure status is a bounded, chosen outcome. */
export function markBoundedOutcome(req: FastifyRequest, outcome: BoundedOutcome): void {
  BOUNDED.set(req, outcome);
}

export function readBoundedOutcome(req: FastifyRequest): BoundedOutcome | null {
  return BOUNDED.get(req) ?? null;
}

export type CompletedResponseTreatment =
  | "COMPLETED"
  | "BUSINESS_ERROR"
  | "BOUNDED_UNAVAILABLE"
  | "BOUNDED_UNAVAILABLE_SIGNAL"
  | "INFRASTRUCTURE_ERROR";

export function classifyCompletedResponse(
  statusCode: number,
  bounded: BoundedOutcome | null,
): CompletedResponseTreatment {
  if (statusCode < 400) return "COMPLETED";
  if (statusCode < 500) return "BUSINESS_ERROR";
  if (statusCode === 500 || bounded === null) return "INFRASTRUCTURE_ERROR";
  return bounded.reportability === "OPERATIONAL_WARNING"
    ? "BOUNDED_UNAVAILABLE_SIGNAL"
    : "BOUNDED_UNAVAILABLE";
}
