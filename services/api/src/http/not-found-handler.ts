/**
 * PHASE 12 — POINT 7 CORRECTIVE PASS (2026-08-05): the canonical 404.
 *
 * Fastify's default not-found body is `{"message":"route post:/v1/... not
 * found"}` — a different shape from every other error this API emits, and one
 * that echoes the requested path back verbatim.
 *
 * It lives in its own module because two places need it: `buildServer`, and
 * any test that assembles a partial app and then asserts on the platform's
 * 404 contract. Before this, such a test was asserting on FASTIFY's default
 * while believing it was asserting on ours — which is a difference that only
 * became visible when the test environment was fixed and its server actually
 * booted.
 *
 * THIRD RE-AUDIT N-7 — the code is `ROUTE_NOT_FOUND`, not `NOT_FOUND`. Route
 * handlers answer a missing (or concealed, anti-enumeration) RECORD with
 * `NOT_FOUND`, which the clients treat as an expected business answer. An
 * unknown or removed ROUTE is a client/server contract fault the clients must
 * report to Sentry, so it needs a code no business refusal uses. No route
 * reuses this body to look like an unknown route; record-level concealment
 * keeps its own `NOT_FOUND` / `not_found` answers.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export function canonicalNotFoundHandler(
  req: FastifyRequest,
  reply: FastifyReply,
) {
  return reply.code(404).send({
    error: {
      code: "ROUTE_NOT_FOUND",
      message: "Resource not found.",
      requestId: req.id,
    },
  });
}

export function registerCanonicalNotFoundHandler(app: FastifyInstance): void {
  app.setNotFoundHandler(canonicalNotFoundHandler);
}
