import type { FastifyInstance } from "fastify";

import { createErrorResponse, ErrorCode } from "../errors.js";
import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";
import { buildPlatformHealth } from "../services/admin/platform-health.service.js";

/**
 * PROOVRA Platform Admin — Platform Health & Service Status endpoint.
 *
 * READ-ONLY aggregation that CONNECTS existing mature health services
 * (runtime-readiness, signer-health, queue-inventory, observability
 * registry, redaction provider probes, readiness posture) plus a small
 * set of operational Prisma reads for the live "Now" panel. It touches
 * NO health logic — every value is a real probe result or an honest
 * unknown / not_connected / null.
 *
 * HONESTY CONTRACT:
 *   - Providers without a live probe (OpenAI, Twilio, Resend, live
 *     Stripe/PayPal API, live TSA/OTS) render `unknown` — never a
 *     fabricated `healthy`.
 *   - No secrets, keys, tokens, connection strings, or raw provider
 *     errors are returned. Uptime is never fabricated.
 */

// TENANT_SCOPE_EXCEPTION: platform_admin_global -- this route is gated by
// requirePlatformAdmin and reads GLOBAL cross-tenant platform health. It is
// intentionally NOT scoped to a single tenant; the platform-admin gate IS the
// authorization boundary. No per-tenant authorizeOrFail applies here.
export async function adminPlatformHealthRoutes(app: FastifyInstance) {
  app.get(
    "/v1/admin/platform-health",
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      try {
        const health = await buildPlatformHealth();
        return reply.code(200).send(health);
      } catch {
        return reply
          .code(500)
          .send(
            createErrorResponse(
              ErrorCode.INTERNAL_SERVER_ERROR,
              req.id,
              undefined,
              "Could not assemble platform health.",
            ),
          );
      }
    },
  );
}

export default adminPlatformHealthRoutes;
