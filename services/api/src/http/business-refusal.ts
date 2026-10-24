/**
 * THE TYPED BUSINESS REFUSAL — one shape for an expected "no".
 *
 * An expected refusal is a decision, not a failure: it is sent as a plain
 * reply (it never reaches the error handler, so it is never a Sentry event),
 * and it tells the caller four things a client can act on without guessing:
 *
 *   code        stable, machine-readable, SCREAMING_SNAKE_CASE
 *   message     a safe sentence a customer can read as-is
 *   state       the current state that produced the refusal, when one applies
 *   nextAction  what to do instead, when there is something to do
 *
 * `requestId` is the request's correlation id (the same value as the
 * `x-request-id` header and the audit row's `correlationId`). It is carried at
 * the top level and inside `error`, because the web client reads it from the
 * nested error and support tooling reads it from the envelope.
 */
import type { FastifyReply, FastifyRequest } from "fastify";

export type BusinessRefusal = {
  code: string;
  message: string;
  state?: string;
  nextAction?: string;
  details?: Record<string, unknown>;
};

export function sendBusinessRefusal(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  refusal: BusinessRefusal,
): FastifyReply {
  return reply.code(status).send({
    error: { ...refusal, requestId: req.id },
    requestId: req.id,
  });
}
