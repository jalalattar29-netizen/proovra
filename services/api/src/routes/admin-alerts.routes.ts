import type { FastifyInstance } from "fastify";

import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";
import { buildPlatformAlerts } from "../services/admin/alerts.service.js";

/**
 * PROOVRA Platform Admin (item K) — Alerts Center route.
 *
 * READ-ONLY, PLATFORM-ADMIN only. Returns the current severity-ranked list of
 * alert-worthy platform signals (open incidents, recent HIGH/CRITICAL security
 * events, failed jobs / degraded queues + workers, failed reports / packages,
 * recent failed payments, SSO connection outages).
 *
 * TENANT_SCOPE_EXCEPTION: platform_admin_global
 *   This route DELIBERATELY reads across every tenant. It is gated by
 *   `requirePlatformAdmin`; no per-workspace scope is applied. The exception
 *   is intentional and mirrors admin-security.routes.ts. It surfaces NO
 *   secrets, NO raw/hashed IPs, NO tokens, and NO free-form metadata.
 *
 * No resolution workflow is modelled for platform alerts — the response is a
 * read-only point-in-time snapshot (see alerts.service.ts). Operators resolve
 * an alert at its source (resolve the incident, drain the failed job, etc.).
 */
export async function adminAlertsRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /v1/admin/alerts — current platform alert signals (read-only).
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/admin/alerts",
    { preHandler: requirePlatformAdmin },
    async (_req, reply) => {
      const result = await buildPlatformAlerts();
      return reply.code(200).send(result);
    },
  );
}

export default adminAlertsRoutes;
