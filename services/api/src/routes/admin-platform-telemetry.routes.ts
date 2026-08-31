/**
 * PLATFORM RUNTIME TELEMETRY — the platform-admin-only projection.
 *
 * THE DEFECT THIS FILE CLOSES
 * ---------------------------------------------------------------------------
 * `GET /v1/ops/metrics` and `GET /v1/ops/alerts` authorized the caller with
 * `requireOpsActor(req, reply, teamId)` — which correctly proves ACTIVE
 * membership of the named workspace and `identity.member.read` — and then
 * returned `snapshotMetrics()`, the entire PROCESS-GLOBAL counter and gauge
 * registry, with no tenant filtering of any kind.
 *
 * The workspace id was an authorization TICKET, never a FILTER. So any member
 * of any workspace — a FREE personal-space user included — could read the whole
 * platform's runtime telemetry: `operational_incidents_open` across every
 * tenant, `secrets_fallback_total`, `authorize_allowed_total`, queue and worker
 * state. The observability screenshot proves the values were global: the page
 * rendered `operational_incidents_open 76` while the workspace it claimed to
 * describe had two.
 *
 * `/v1/ops/alerts` was worse than a read: it called `setGauge` and `bump` on
 * the shared registry, so any tenant could perturb the numbers every other
 * tenant and the platform dashboards were reading.
 *
 * WHY A SEPARATE ROUTE RATHER THAN A FLAG
 * ---------------------------------------------------------------------------
 * A query parameter that widens scope is the same defect with a different
 * spelling — the next caller finds it and the boundary is gone again. Global
 * telemetry gets its own path under the admin namespace, gated by the canonical
 * platform-admin middleware, and the workspace surface gets a projection that
 * physically cannot reach the process registry
 * (`workspace-operations.routes.ts`).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";
import {
  bump,
  setGauge,
  snapshotMetrics,
} from "@proovra/shared-runtime";
import { evaluateAlerts } from "@proovra/shared";

export async function adminPlatformTelemetryRoutes(
  app: FastifyInstance,
): Promise<void> {
  /**
   * GET /v1/admin/platform/metrics — the process-global registry.
   *
   * TENANT_SCOPE_EXCEPTION: platform_admin_global. This is deliberately not
   * workspace-scoped; it is the runtime of the API process itself, and the
   * platform gate IS the authorization boundary.
   */
  app.get(
    "/v1/admin/platform/metrics",
    { preHandler: requirePlatformAdmin },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const snap = snapshotMetrics();
      return reply.code(200).send({
        scope: "PLATFORM",
        metrics: snap,
        // Counters are monotonic SINCE PROCESS START and reset on restart.
        // Saying so here means a reader never has to infer it from a small
        // number, which is how "7m uptime, all counters low" got read as
        // "quiet platform" instead of "recently deployed".
        uptimeSeconds: snap.uptimeSeconds,
        countersResetOnRestart: true,
        sampledAtUtc: new Date().toISOString(),
      });
    },
  );

  /**
   * GET /v1/admin/platform/alerts — alert evaluation over the global registry.
   *
   * TENANT_SCOPE_EXCEPTION: platform_admin_global.
   *
   * This is the ONLY caller permitted to write the alert gauges. When any
   * workspace member could reach the old endpoint, every tenant poll rewrote
   * `observability_alerts_firing` for everyone.
   */
  app.get(
    "/v1/admin/platform/alerts",
    { preHandler: requirePlatformAdmin },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const snap = snapshotMetrics();
      const merged: Record<string, number | undefined> = {
        ...snap.counters,
        ...snap.gauges,
      };
      const firing = evaluateAlerts(merged);
      const critical = firing.filter((a) => a.severity === "CRITICAL").length;
      setGauge("observability_alerts_firing", firing.length);
      setGauge("observability_alerts_firing_critical", critical);
      bump("observability_alert_evaluations_total");
      return reply.code(200).send({
        scope: "PLATFORM",
        firing,
        counts: {
          total: firing.length,
          critical,
          high: firing.filter((a) => a.severity === "HIGH").length,
          warning: firing.filter((a) => a.severity === "WARNING").length,
        },
        evaluatedAtUtc: new Date().toISOString(),
      });
    },
  );
}

export default adminPlatformTelemetryRoutes;
