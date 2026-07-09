/**
 * Platform Control Center P1 — Evidence Pipeline Health console API.
 *
 *   GET /v1/admin/evidence-health — platform-wide, READ-ONLY.
 *
 * Gated by `requirePlatformAdmin`. Returns a snapshot of the evidence
 * pipeline (uploads → evidence → reports → packages → preservation)
 * built ENTIRELY from real DB counts + the existing queue-inventory
 * projection. Absent signals are `null` ("Not measured" / "Not
 * connected"), NEVER a fabricated healthy 0.
 *
 * Hard rules honoured here:
 *   - No hashing / signing / custody / report / package generation.
 *     This route counts. It does not touch evidence core logic.
 *   - No evidence CONTENTS are exposed: no bytes, storage keys,
 *     signatures, fingerprints, titles, GPS, private notes. Only
 *     aggregate counts + operational status rollups.
 *   - The queue numbers reuse queue-inventory.service.ts — this route
 *     does not open its own Redis connection.
 *
 * Registration: the owner wires this into server.ts + routeRegistry
 * (`platform.evidence_ops` → /admin/evidence-ops).
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { createErrorResponse, ErrorCode } from "../errors.js";
import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";
import { buildEvidenceHealthSnapshot } from "../services/operations/evidence-health.service.js";

const querySchema = z.object({
  windowHours: z.coerce.number().int().min(1).max(24 * 30).optional(),
});

// TENANT_SCOPE_EXCEPTION: platform_admin_global -- every route in this plugin is
// gated by requirePlatformAdmin and reads GLOBAL cross-tenant aggregates. It is
// intentionally NOT scoped to a single tenant; the platform-admin gate IS the
// authorization boundary. No per-tenant authorizeOrFail applies here.
export async function adminEvidenceOpsRoutes(app: FastifyInstance) {
  app.get(
    "/v1/admin/evidence-health",
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const parsed = querySchema.safeParse(req.query ?? {});
      if (!parsed.success) {
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            req.id,
            { reason: parsed.error.message },
            "Invalid evidence-health query",
          ),
        );
      }

      const snapshot = await buildEvidenceHealthSnapshot({
        windowHours: parsed.data.windowHours,
      });

      return reply.code(200).send({ snapshot });
    },
  );
}
