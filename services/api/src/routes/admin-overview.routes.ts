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
    async (request, reply) => {
      // ADM-024 — a metric whose query threw is reported as ERROR to the
      // operator and logged with its technical cause HERE. The browser sees an
      // information-free sentence; the stack stays server-side.
      const overview = await buildPlatformOverview((err, label) => {
        request.log.error({ err, metric: label }, "admin.overview.metric_failed");
      });
      return reply.code(200).send(overview);
    },
  );
}
