/**
 * Wave 5 — Internal service-to-service auth.
 *
 * Modeled on cron-secret.ts. Guards routes that are intended ONLY
 * for in-cluster service callers (notably the worker callback path
 * `POST /v1/internal/media-intelligence/extract`) — never reachable
 * from an authenticated end-user session.
 *
 * Rules:
 *
 *   1. Header `X-Internal-Service-Token` must be present and match
 *      `process.env.INTERNAL_SERVICE_TOKEN` (>= 16 chars).
 *      Constant-time comparison via HMAC + `timingSafeEqual`.
 *
 *   2. Secret NOT configured:
 *        - In production → 503 CONFIGURATION_ERROR (fail-closed).
 *        - In non-production → 401 (no admin fallback; this surface
 *          is never legitimately user-driven).
 *
 *   3. The token is NEVER logged. Rejection logs include only the
 *      reason code (missing / mismatch) — never the provided value.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";

export const INTERNAL_SERVICE_TOKEN_HEADER = "x-internal-service-token";
const INTERNAL_SERVICE_TOKEN_ENV = "INTERNAL_SERVICE_TOKEN";

function readSecret(): string | null {
  const v = process.env[INTERNAL_SERVICE_TOKEN_ENV];
  return v && v.trim().length >= 16 ? v.trim() : null;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    const ah = createHmac("sha256", "proovra-internal-svc").update(a).digest();
    const bh = createHmac("sha256", "proovra-internal-svc").update(b).digest();
    return timingSafeEqual(ah, bh);
  } catch {
    return false;
  }
}

function readHeader(req: FastifyRequest, name: string): string | null {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0]?.trim() ?? null;
  if (typeof raw === "string") return raw.trim();
  return null;
}

/**
 * Pre-handler guard. Returns `true` if the request is authorized.
 * On rejection, sends the bounded error response and returns `false`.
 */
export async function requireInternalServiceAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const expected = readSecret();
  const provided = readHeader(req, INTERNAL_SERVICE_TOKEN_HEADER);

  if (!expected) {
    if (isProduction()) {
      reply.code(503).send({
        error: {
          code: "CONFIGURATION_ERROR",
          message: `Internal service token (${INTERNAL_SERVICE_TOKEN_ENV}) is required in production.`,
        },
      });
      return false;
    }
    reply.code(401).send({
      error: {
        code: "UNAUTHORIZED",
        message: "Internal service token not configured.",
      },
    });
    return false;
  }

  if (!provided || !constantTimeEqual(expected, provided)) {
    reply.code(401).send({
      error: {
        code: "UNAUTHORIZED",
        message: "Invalid internal service credential.",
      },
    });
    return false;
  }

  return true;
}
