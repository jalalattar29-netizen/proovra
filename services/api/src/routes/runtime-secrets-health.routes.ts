// TENANT_SCOPE_EXCEPTION: platform_admin_global -- process-wide runtime posture,
// served only through requirePlatformAdmin (OPS-026); no tenant data is read.
/**
 * Phase P2.0 — AWS Secrets Manager health route.
 *
 *   GET /v1/runtime/secrets-health
 *
 * Returns the operator-safe health snapshot:
 *
 *   * `awsEnabled` / `awsConnected` / `cacheLoaded` / `degraded`
 *   * `fallbackMode`: "aws_primary" | "env_only" | "env_fallback_after_failure"
 *   * `lastRefreshAtUtc` / `lastErrorCode`
 *   * `cachedKeyCount` (NEVER key names, NEVER values)
 *   * Per-migrated-secret presence audit: name + source + present.
 *     Source is one of "aws" | "env" | "missing". NO values.
 *
 * Hard rules:
 *   * Auth required. Same gate as other `/v1/ops/*` (active member,
 *     identity.member.read permission). The route refuses to surface
 *     ANY state to anonymous callers.
 *   * NO secret values returned.
 *   * NO AWS error stacks returned. The bounded `lastErrorCode`
 *     enum is the only error surface.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";
import { getSecretsHealth } from "../config/secrets-manager.js";
import { getMigratedSecretsAudit } from "../config/runtime-secrets.js";
import { getOtelStatus } from "../observability/otel.js";

export async function runtimeSecretsHealthRoutes(app: FastifyInstance) {
  app.get(
    "/v1/runtime/secrets-health",
    // OPS-026 — process-wide secrets/telemetry posture is PLATFORM data.
    // It is served by the platform authority alone; a workspace membership
    // (of any role) is not a ticket to it.
    { preHandler: requirePlatformAdmin },
    async (req: FastifyRequest, reply: FastifyReply) => {

      const health = getSecretsHealth();
      const audit = getMigratedSecretsAudit();
      // Phase P2.0B — include OTEL status snapshot. Operator-safe:
      // service name + namespace + environment + a boolean
      // `endpointConfigured`. The endpoint URL and headers (Grafana
      // token) are NEVER returned.
      const otel = getOtelStatus();
      return reply.code(200).send({
        health,
        migrated: audit,
        otel,
      });
    },
  );
}
