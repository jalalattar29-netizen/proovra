/**
 * Phase 8 — Enterprise Production Readiness posture route (SCOPE F / I / J).
 *
 *   GET /v1/operations/readiness   — PLATFORM-ADMIN only.
 *
 * TENANT_SCOPE_EXCEPTION: platform_admin_global — this route is gated to
 * platform administrators and returns only platform-wide configuration
 * posture (booleans/modes/labels). It carries NO per-tenant/customer data,
 * so it is intentionally not workspace-scoped.
 *
 * Returns a TRUTHFUL posture rollup computed from real platform
 * configuration and existing operational services. NO secrets, key
 * material, bucket names, ARNs, or IAM details — only booleans,
 * bounded modes, provider labels, day counts, and timestamps.
 *
 * Honesty is paramount (see readiness-posture.service.ts): backup /
 * DR posture is reported strictly from verified config. Where a value
 * cannot be proven the service returns an honest assumption label
 * ("managed_platform_assumed") or null + reason. This route asserts
 * NO SOC2 / ISO / uptime SLA / penetration-test claims.
 *
 * Every access emits a platform audit event.
 *
 * This file is a NEW Fastify plugin. It is intentionally NOT
 * self-registered — the shared wiring owner registers it in
 * server.ts and adds the routeRegistry / pillar / tiers entries for
 * `operations.readiness` (/operations/readiness, INTERNAL /
 * platform-admin).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";
import { appendPlatformAuditLog } from "../services/platform-audit-log.service.js";
import { computeReadinessPosture } from "../services/operations/readiness-posture.service.js";

function readUserAgent(req: {
  headers: Record<string, string | string[] | undefined>;
}): string | undefined {
  const value = req.headers["user-agent"];
  return Array.isArray(value) ? value[0] : value;
}

export async function operationsReadinessRoutes(app: FastifyInstance) {
  app.get(
    "/v1/operations/readiness",
    { preHandler: requirePlatformAdmin },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const posture = await computeReadinessPosture();

      // Emit a platform audit event on every access. Fire-and-forget
      // (never blocks the read) — bounded, operator-safe metadata only
      // (no secrets, no key material). Mirrors the audit pattern used
      // by admin-audit.routes.ts.
      void appendPlatformAuditLog({
        userId: req.user?.sub ?? null,
        action: "operations.readiness.viewed",
        category: "operations_readiness_access",
        severity: "info",
        source: "api_operations_readiness",
        outcome: "success",
        resourceType: "operations_readiness",
        resourceId: null,
        requestId: req.id,
        metadata: {
          objectLockEnabled: posture.backup.objectLockEnabled,
          databaseBackup: posture.backup.databaseBackup,
          signerProvider: posture.keys.signerProvider,
          runtimeStatus: posture.resiliency.runtimeReadinessSummary.status,
          schemaStatus: posture.resiliency.schemaDriftSummary.status,
        },
        ipAddress: (req as { ip?: string }).ip,
        userAgent: readUserAgent(req),
      }).catch(() => {
        /* audit is best-effort; never fail the read */
      });

      return reply.code(200).send({ posture });
    },
  );
}
