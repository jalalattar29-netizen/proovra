import type { FastifyInstance } from "fastify";

import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";
import { buildPlatformOverview } from "../services/admin/overview.service.js";

// TENANT_SCOPE_EXCEPTION: platform_admin_global — this route is gated by
// requirePlatformAdmin and reads GLOBAL cross-tenant aggregates (the platform
// control-center overview). It is intentionally NOT scoped to a single tenant;
// the platform-admin gate IS the authorization boundary. Read-only.
export async function adminOverviewRoutes(app: FastifyInstance) {
  app.get(
    "/v1/admin/overview",
    { preHandler: requirePlatformAdmin },
    async (_request, reply) => {
      const overview = await buildPlatformOverview();
      return reply.code(200).send(overview);
    },
  );
}
