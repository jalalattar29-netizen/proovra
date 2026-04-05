import type { FastifyInstance } from "fastify";

/**
 * LEGACY AUDIT ROUTES
 *
 * These routes were backed by the old in-memory AuditService and formed a
 * separate audit system outside the active DB-backed tamper-evident chain.
 *
 * Active audit system:
 * - writer: services/api/src/services/platform-audit-log.service.ts
 * - hash chain: services/api/src/lib/admin-audit-chain.ts
 * - admin read routes: services/api/src/routes/admin-audit.routes.ts
 *
 * This module is intentionally left as a no-op and must not be registered.
 * See server.ts where legacy auditRoutes registration has been removed.
 */
export async function auditRoutes(_app: FastifyInstance) {
  // Intentionally disabled.
}