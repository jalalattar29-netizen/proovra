import type { FastifyInstance } from "fastify";

import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";
import { buildExecutiveDashboard } from "../services/admin/executive.service.js";

/**
 * PROOVRA Platform Admin — Executive Dashboard route (READ-ONLY).
 *
 * A single GET that returns the honest platform KPI aggregate assembled by
 * `buildExecutiveDashboard`. It performs NO writes and touches no
 * checkout / entitlement / provisioning logic.
 *
 * HONESTY CONTRACT (delegated to the service, restated here for the
 * operator-facing contract):
 *   - Gross revenue, active/enterprise customers, leads, usage MoM,
 *     top-customers-by-usage, at-risk customers and failed operations are
 *     REAL — computed from live rows.
 *   - Growth rate %, MRR, ARR and renewal-risk $ are HONEST NULL — they are
 *     not safely derivable from the schema and are returned as
 *     `{ value: null, notMeasured: "<reason>" }`, never fabricated.
 */

// TENANT_SCOPE_EXCEPTION: platform_admin_global -- the single route in this
// plugin is gated by requirePlatformAdmin and reads GLOBAL cross-tenant
// aggregates. It is intentionally NOT scoped to a single tenant; the
// platform-admin gate IS the authorization boundary. No per-tenant
// authorizeOrFail applies here.
export async function adminExecutiveRoutes(app: FastifyInstance) {
  app.get(
    "/v1/admin/executive",
    { preHandler: requirePlatformAdmin },
    async (_req, reply) => {
      const dashboard = await buildExecutiveDashboard(new Date());
      return reply.code(200).send(dashboard);
    }
  );
}

export default adminExecutiveRoutes;
