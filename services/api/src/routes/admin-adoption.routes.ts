import type { FastifyInstance } from "fastify";

import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";
import { computeAdoptionReport } from "../services/admin/adoption.service.js";

/**
 * Platform Control Center — Feature Usage / Adoption (item H).
 *
 * READ-ONLY aggregation. Adoption is DERIVED from real entity counts by
 * `computeAdoptionReport` — there is NO explicit adoption model and NO
 * composite / fabricated "adoption score". Each capability reports only what
 * is honestly derivable from its backing table; capabilities with no backing
 * model return `measured: false` with every metric null.
 *
 * This plugin performs ZERO writes.
 */

// TENANT_SCOPE_EXCEPTION: platform_admin_global -- every route in this plugin is
// gated by requirePlatformAdmin and reads GLOBAL cross-tenant aggregates. It is
// intentionally NOT scoped to a single tenant; the platform-admin gate IS the
// authorization boundary. No per-tenant authorizeOrFail applies here.
export async function adminAdoptionRoutes(app: FastifyInstance) {
  app.get(
    "/v1/admin/adoption",
    { preHandler: requirePlatformAdmin },
    async (_req, reply) => {
      const report = await computeAdoptionReport();
      return reply.code(200).send(report);
    }
  );
}

export default adminAdoptionRoutes;
