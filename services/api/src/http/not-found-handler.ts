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
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export function canonicalNotFoundHandler(
  req: FastifyRequest,
  reply: FastifyReply,
) {
  return reply.code(404).send({
    error: {
      code: "NOT_FOUND",
      message: "Resource not found.",
      requestId: req.id,
    },
  });
}

export function registerCanonicalNotFoundHandler(app: FastifyInstance): void {
  app.setNotFoundHandler(canonicalNotFoundHandler);
}
