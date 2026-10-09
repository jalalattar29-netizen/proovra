// TENANT_SCOPE_EXCEPTION: platform_admin_global -- process-wide runtime posture,
// served only through requirePlatformAdmin (OPS-026); no tenant data is read.
/**
 * Phase O1.1 — OTEL runtime health route.
 *
 *   GET /v1/runtime/otel-health
 *
 * Returns the bounded operator-safe snapshot from `getOtelStatus()`:
 *
 *   * `enabled` / `started` / `degraded`
 *   * `serviceName` / `serviceNamespace` / `environment` / `protocol`
 *   * `endpointConfigured` (boolean — NEVER the URL)
 *   * `lastBootstrapAtUtc` / `lastBootstrapOutcome` /
 *     `lastBootstrapFailureCode`
 *   * `lastExportErrorCode`
 *   * `spansCreatedCount`
 *   * `resourceAttributes` — bounded `service.name` / `service.namespace`
 *     / `deployment.environment` only.
 *
 * Hard rules:
 *   * Auth required. Same gate as `/v1/runtime/secrets-health`
 *     (active workspace member, `identity.member.read`).
 *   * NEVER returns the OTLP endpoint URL.
 *   * NEVER returns headers / Grafana token / any Authorization
 *     material.
 *   * NEVER returns process env values.
 *   * Bounded enums on every state.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";
import { getOtelStatus } from "../observability/otel.js";
import { getOtelRuntimeDiagnostics } from "../observability/otel-diagnostics.js";

export async function runtimeOtelHealthRoutes(app: FastifyInstance) {
  app.get(
    "/v1/runtime/otel-health",
    // OPS-026 — process-wide secrets/telemetry posture is PLATFORM data.
    // It is served by the platform authority alone; a workspace membership
    // (of any role) is not a ticket to it.
    { preHandler: requirePlatformAdmin },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const otel = getOtelStatus();
      // Phase O1.3 — extended runtime diagnostics for the Grafana
      // operator: OTEL package version summary, OTLP exporter kind,
      // auth-header presence + scheme + token length (NEVER the
      // token), and the Sentry skipOpenTelemetrySetup gate state.
      // All values are bounded; no env values are returned verbatim.
      const diagnostics = getOtelRuntimeDiagnostics();
      return reply.code(200).send({ otel, diagnostics });
    },
  );
}
