/**
 * DEC-20 / RG-22 — WHEN THE SHARED LIMITER COULD NOT DECIDE.
 *
 * A `bound: "global"` limit with Redis configured and unable to answer (down,
 * cooling down, or silent past the command deadline — PRO-S1-03) refuses the
 * request without counting it anywhere (`store: "unavailable"`). That is a
 * dependency failure, not rate exhaustion: the caller made no excess attempt.
 * It answers a bounded, retryable 503 with Retry-After (the end of the store
 * cooldown); actual exhaustion stays 429. Fail-closed is unchanged — the
 * protected operation does not run, and no token or retryable client state is
 * consumed.
 *
 * Declared OPERATIONAL_WARNING so the response hook logs a warning and one
 * operational signal instead of paging critical per refused request.
 */
import type { FastifyReply } from "fastify";

import { DomainError } from "../errors.js";
import { markBoundedOutcome } from "./bounded-outcome.js";

// The existing retryable-busy code every client already renders ("try again in a
// moment"); `details.reason` tells the cause apart from the overload gate.
export const LIMITER_UNAVAILABLE_CODE = "SERVER_BUSY";

export function isLimiterUnavailable(rl: { store?: string } | null | undefined): boolean {
  return rl?.store === "unavailable";
}

export function replyLimiterUnavailable(
  reply: FastifyReply,
  rl: { resetAtMs: number },
): FastifyReply {
  const retryAfterSec = Math.min(60, Math.max(1, Math.ceil((rl.resetAtMs - Date.now()) / 1000)));
  markBoundedOutcome(reply.request, {
    code: LIMITER_UNAVAILABLE_CODE,
    reportability: "OPERATIONAL_WARNING",
    severity: "warning",
  });
  return reply
    .code(503)
    .header("Retry-After", String(retryAfterSec))
    .send({
      error: {
        code: LIMITER_UNAVAILABLE_CODE,
        message: "This is temporarily unavailable. Nothing was changed; try again in a minute.",
        details: { reason: "limiter_unavailable", retryAfterSec },
        requestId: typeof reply.request?.id === "string" ? reply.request.id : null,
      },
    });
}

/**
 * The same outcome for code that answers a boolean or a service result rather
 * than a reply: thrown as a bounded DomainError, which the central handler
 * renders as 503 + Retry-After without paging.
 */
export function limiterUnavailableError(rl: { resetAtMs: number }): DomainError {
  const retryAfterSeconds = Math.min(60, Math.max(1, Math.ceil((rl.resetAtMs - Date.now()) / 1000)));
  return new DomainError("rate limiter store unavailable", {
    httpStatus: 503,
    publicCode: LIMITER_UNAVAILABLE_CODE,
    publicMessage: "This is temporarily unavailable. Nothing was changed; try again in a minute.",
    reportability: "OPERATIONAL_WARNING",
    severity: "warning",
    metadata: { retryAfterSeconds, reason: "limiter_unavailable" },
  });
}

/** Throws {@link limiterUnavailableError} when a global bound could not be decided. */
export function assertLimiterAvailable(rl: { store?: string; resetAtMs: number }): void {
  if (isLimiterUnavailable(rl)) throw limiterUnavailableError(rl);
}
