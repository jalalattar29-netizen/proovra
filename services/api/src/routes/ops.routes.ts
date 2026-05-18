/**
 * Phase 20 — Operational endpoints.
 *
 *   GET    /healthz                       — liveness, public, minimal
 *   GET    /readyz                        — readiness, public, minimal
 *   GET    /v1/ops/health                 — authenticated detailed health
 *   GET    /v1/ops/metrics                — authenticated metrics snapshot
 *   POST   /v1/ops/reconcile              — master reconciliation cron
 *
 * The public endpoints (`/healthz`, `/readyz`) return only
 * "ok" / "degraded" plus a tiny set of fields needed by load
 * balancers. The authenticated endpoints carry the safe feature
 * snapshot + queue counts.
 *
 * Hard invariants:
 *   - Public endpoints expose NO secret values, NO per-team data, NO
 *     env names that imply specific deployment internals beyond the
 *     binary "core ok / not ok".
 *   - Authenticated endpoints require Phase 17 `identity.member.read`.
 *     Operators inside the workspace can see configured/unconfigured;
 *     non-members get 404.
 *   - The reconcile route is protected by `INTEGRATION_CRON_SECRET`
 *     (re-using the Phase 12/18/19 convention). All sub-tasks are
 *     idempotent + bounded.
 *   - Reconcile NEVER hard-deletes. It only flips state (e.g.
 *     PENDING→EXPIRED) or counts orphans so an operator can act.
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";
import * as prismaPkg from "@prisma/client";

import { getAuthUserId } from "../auth.js";
import {
  collectStartupViolations,
  getFeatureSnapshot,
} from "../config/index.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireIntegrationCronSecret } from "../middleware/cron-secret.js";
import { evaluateMemberAccess } from "../services/identity/access-policy.service.js";
import {
  bump,
  buildPrometheusExposition,
  setGauge,
  snapshotMetrics,
} from "../services/ops/metrics.service.js";
import { evaluateAlerts } from "@proovra/shared";
import { buildObservabilityHealth } from "../services/observability/registry.js";
import { buildAlertHealth } from "../services/alerts/alert.service.js";
import {
  IncidentError,
  acknowledgeIncident,
  listIncidents,
  projectIncident,
  resolveIncident,
  suppressIncident,
} from "../services/observability/incident.service.js";
import {
  INCIDENT_CATEGORIES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
} from "@proovra/shared";
import { runSchemaValidation } from "../runtime/schema-validation.js";

const TeamIdQuery = z.object({ teamId: z.string().uuid() });

async function requireOpsActor(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<{ userId: string } | null> {
  const userId = getAuthUserId(req);
  const member = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { id: true },
  });
  if (!member) {
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  const decision = await evaluateMemberAccess({
    teamId,
    userId,
    permission: "identity.member.read",
  });
  if (!decision.allowed) {
    reply.code(403).send({
      error: {
        code: "permission_denied",
        reason: decision.reason,
        detail: decision.detail ?? null,
      },
    });
    return null;
  }
  return { userId };
}

// -----------------------------------------------------------------------------
// Reconcile sub-tasks
// -----------------------------------------------------------------------------

type ReconcileSummary = {
  stepUpChallengesExpired: number;
  trustedDevicesExpired: number;
  communicationsRetryDue: number;
  notificationsRetryDue: number;
  pendingCommunicationsCancelled: number;
  staleAccessReviewsCreated: number;
  intelligenceJobsStuck: number;
  uploadsStalled: number;
};

async function runMasterReconcile(): Promise<ReconcileSummary> {
  const now = new Date();
  const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

  // 1. Expire step-up challenges past their TTL.
  const expiredStepUps = await prisma.stepUpChallenge.updateMany({
    where: {
      status: prismaPkg.StepUpChallengeStatus.PENDING,
      expiresAtUtc: { lte: now },
    },
    data: { status: prismaPkg.StepUpChallengeStatus.EXPIRED },
  });

  // 2. Expire trusted devices past their TTL.
  const expiredDevices = await prisma.trustedDevice.updateMany({
    where: {
      status: prismaPkg.TrustedDeviceStatus.ACTIVE,
      trustedUntilUtc: { lte: now },
    },
    data: {
      status: prismaPkg.TrustedDeviceStatus.REVOKED,
      revokedAtUtc: now,
      revokedReason: "ttl_expired",
    },
  });

  // 3. Count outbound communications due for retry. We don't dispatch
  // them here (the communications process-retries route handles that)
  // — we just count for the gauge.
  const dueRetries = await prisma.communicationMessage.count({
    where: {
      status: prismaPkg.CommunicationStatus.RETRY_SCHEDULED,
      nextAttemptAtUtc: { lte: now },
    },
  });
  setGauge("communications_retry_scheduled", dueRetries);

  // 4. Count notifications due for retry.
  const dueNotifs = await prisma.notificationDelivery.count({
    where: {
      status: prismaPkg.NotificationDeliveryStatus.RETRY_SCHEDULED,
      nextAttemptAtUtc: { lte: now },
    },
  });
  setGauge("notifications_retry_scheduled", dueNotifs);

  // 5. Cancel QUEUED communications that have been stuck for >5
  // minutes with no provider attempt — safe-net for a crash mid-send
  // (we never retry them, only mark CANCELLED with reason). Bounded
  // to 100 per run to avoid a single tick from doing too much.
  const stuckPending = await prisma.communicationMessage.findMany({
    where: {
      status: prismaPkg.CommunicationStatus.QUEUED,
      createdAt: { lte: fiveMinutesAgo },
      providerMessageId: null,
    },
    select: { id: true },
    take: 100,
  });
  let cancelledStuckCount = 0;
  for (const row of stuckPending) {
    try {
      await prisma.communicationMessage.update({
        where: { id: row.id },
        data: {
          status: prismaPkg.CommunicationStatus.CANCELLED,
          errorCode: "stuck_queued_reconciled",
          errorMessage: "Queued > 5 minutes without provider correlation id.",
        },
      });
      cancelledStuckCount += 1;
    } catch {
      /* best-effort */
    }
  }

  // 6. Count intelligence jobs stuck in PROCESSING for >1 hour. We do
  // NOT auto-fail them — that's a deliberate operator decision — but
  // we expose the count.
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const stuckJobs = await prisma.evidenceIntelligenceJob.count({
    where: {
      status: prismaPkg.EvidenceIntelligenceJobStatus.PROCESSING,
      updatedAt: { lte: oneHourAgo },
    },
  });
  setGauge("intelligence_jobs_processing", stuckJobs);

  // 7. Count stalled upload sessions for the gauge. Reuses the
  // existing Phase 12 enum values; no mutation here.
  const stalledUploads = await prisma.uploadSession.count({
    where: {
      status: prismaPkg.UploadSessionStatus.UPLOADING,
      updatedAt: { lte: oneHourAgo },
    },
  });
  setGauge("stalled_uploads", stalledUploads);

  // 8. Identity health gauges — current active trusted devices + open
  // access reviews + revoked sessions total.
  const [activeDevices, openReviews, totalRevoked] = await Promise.all([
    prisma.trustedDevice.count({
      where: { status: prismaPkg.TrustedDeviceStatus.ACTIVE },
    }),
    prisma.accessReview.count({
      where: {
        status: {
          in: [
            prismaPkg.AccessReviewStatus.PENDING,
            prismaPkg.AccessReviewStatus.IN_PROGRESS,
          ],
        },
      },
    }),
    prisma.revokedSession.count(),
  ]);
  setGauge("trusted_devices_active", activeDevices);
  setGauge("open_access_reviews", openReviews);
  setGauge("revoked_sessions_total", totalRevoked);

  return {
    stepUpChallengesExpired: expiredStepUps.count,
    trustedDevicesExpired: expiredDevices.count,
    communicationsRetryDue: dueRetries,
    notificationsRetryDue: dueNotifs,
    pendingCommunicationsCancelled: cancelledStuckCount,
    staleAccessReviewsCreated: 0,
    intelligenceJobsStuck: stuckJobs,
    uploadsStalled: stalledUploads,
  };
}

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

export async function opsRoutes(app: FastifyInstance) {
  // /healthz — liveness. Public. Returns 200 unless the process is
  // dead. Does NOT check the database; that's `/readyz`. Operators /
  // load balancers should use this for "is the process up".
  app.get("/healthz", async (_req, reply) => {
    return reply.code(200).send({ status: "ok" });
  });

  // /readyz — readiness. Public. Returns 200 if the database is
  // reachable AND no critical-in-production config violations exist.
  // Operators / orchestrators should use this for "should new traffic
  // be sent to this instance".
  app.get("/readyz", async (_req, reply) => {
    const violations = collectStartupViolations();
    if (violations.length > 0 && process.env.NODE_ENV === "production") {
      return reply.code(503).send({
        status: "degraded",
        reason: "production_config_violations",
      });
    }
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      return reply.code(503).send({ status: "degraded", reason: "db_unreachable" });
    }
    return reply.code(200).send({ status: "ok" });
  });

  // /v1/ops/health — authenticated detailed health for the operator UI.
  // Includes the safe feature snapshot, startup-violation summary, and
  // a metrics snapshot. NEVER includes secret values or per-team data.
  app.get(
    "/v1/ops/health",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = TeamIdQuery.parse(req.query ?? {});
      const actor = await requireOpsActor(req, reply, q.teamId);
      if (!actor) return;
      let dbOk = true;
      try {
        await prisma.$queryRaw`SELECT 1`;
      } catch {
        dbOk = false;
      }
      // Phase 21 — extend health with observability + alert provider
      // status + open-incident counts. Operator UI consumes this to
      // render the "system at a glance" panel.
      const [openTotal, openHigh, openCritical] = await Promise.all([
        prisma.operationalIncident
          .count({
            where: {
              teamId: q.teamId,
              status: {
                in: [
                  prismaPkg.IncidentStatus.OPEN,
                  prismaPkg.IncidentStatus.ACKNOWLEDGED,
                ],
              },
            },
          })
          .catch(() => 0),
        prisma.operationalIncident
          .count({
            where: {
              teamId: q.teamId,
              status: prismaPkg.IncidentStatus.OPEN,
              severity: prismaPkg.IncidentSeverity.HIGH,
            },
          })
          .catch(() => 0),
        prisma.operationalIncident
          .count({
            where: {
              teamId: q.teamId,
              status: prismaPkg.IncidentStatus.OPEN,
              severity: prismaPkg.IncidentSeverity.CRITICAL,
            },
          })
          .catch(() => 0),
      ]);
      return reply.code(200).send({
        ok: dbOk,
        database: dbOk ? "up" : "down",
        snapshot: getFeatureSnapshot(),
        violations: collectStartupViolations(),
        observability: buildObservabilityHealth(),
        alerts: buildAlertHealth(),
        incidents: {
          openTotal,
          openHigh,
          openCritical,
        },
      });
    },
  );

  // /v1/ops/metrics — authenticated metrics snapshot. Same auth gate
  // as /v1/ops/health. Returns the in-process counter + gauge values.
  app.get(
    "/v1/ops/metrics",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = TeamIdQuery.parse(req.query ?? {});
      const actor = await requireOpsActor(req, reply, q.teamId);
      if (!actor) return;
      return reply.code(200).send({ metrics: snapshotMetrics() });
    },
  );

  // Phase Y — Prometheus exposition endpoint.
  //
  // Public path conventionally consumed by a scraper inside the
  // trusted cluster network. Optionally gated by a shared bearer
  // token (`METRICS_SCRAPE_TOKEN`) — when set, callers must pass
  // `Authorization: Bearer <token>` or the endpoint returns 401.
  // When the env is not set, the endpoint is open (typical k8s
  // deployment where /metrics is network-firewalled). This matches
  // the existing /healthz + /readyz public-endpoint pattern.
  //
  // Returns Prometheus exposition format with `text/plain;
  // version=0.0.4` content type. Includes the entire COUNTER_NAMES +
  // GAUGE_NAMES catalog plus a process uptime gauge.
  app.get("/metrics", async (req: FastifyRequest, reply: FastifyReply) => {
    const requiredToken = process.env.METRICS_SCRAPE_TOKEN?.trim();
    if (requiredToken) {
      const auth = req.headers.authorization ?? "";
      const m = /^Bearer\s+(.+)$/i.exec(auth);
      const presented = m?.[1]?.trim();
      if (!presented || presented !== requiredToken) {
        return reply.code(401).send({ error: "unauthorized" });
      }
    }
    const body = buildPrometheusExposition();
    return reply
      .code(200)
      .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
      .header("cache-control", "no-store")
      .send(body);
  });

  // Phase Y — Alert evaluation endpoint.
  //
  // Reads the current metrics snapshot and runs it against the shared
  // OPERATIONAL_ALERT_THRESHOLDS catalog. Returns the alerts that are
  // currently firing. Authenticated; the operator dashboard polls
  // this to render the alert ribbon. Updates two gauges so a scraper
  // can also tell at a glance how many alerts are open.
  app.get(
    "/v1/ops/alerts",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = TeamIdQuery.parse(req.query ?? {});
      const actor = await requireOpsActor(req, reply, q.teamId);
      if (!actor) return;
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

  // GET /admin/runtime/schema-status — runtime schema drift probe.
  //
  // Inspects the live database against the runtime's expected-schema
  // catalog (`services/api/src/runtime/schema-validation.ts`) and
  // returns a per-subsystem health rollup plus the specific missing
  // objects. Used by:
  //   - operator dashboards to render a drift banner before P2022
  //     traffic hits the engines,
  //   - smoke probes during a deploy to confirm migrations applied,
  //   - the Sentry-tagged on-call to verify which subsystems are
  //     degraded without inspecting the DB by hand.
  //
  // Authenticated like the other /v1/ops/* operator endpoints — same
  // teamId/identity.member.read gate. Returns a snapshot, never
  // mutates. Safe to poll.
  app.get(
    "/admin/runtime/schema-status",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = TeamIdQuery.parse(req.query ?? {});
      const actor = await requireOpsActor(req, reply, q.teamId);
      if (!actor) return;
      const report = await runSchemaValidation();
      // Project a JSON-safe shape. Failures are flattened into
      // `kind|name` rows so the dashboard can render them as a list.
      const failures = report.failures.map((f) => {
        const t = f.target;
        const label =
          t.kind === "column"
            ? `${t.table}.${t.column}`
            : t.kind === "enum_value"
              ? `${t.enumName}.${t.value}`
              : t.kind === "index"
                ? `${t.table}.${t.indexName}`
                : (t as { name: string }).name;
        return {
          kind: t.kind,
          name: label,
          severity: t.severity,
          subsystem: t.subsystem,
          outcome: f.outcome,
          detail: f.detail ?? null,
        };
      });
      return reply.code(200).send({
        status: report.status,
        ranAtUtc: report.ranAtUtc,
        durationMs: report.durationMs,
        checked: report.checked,
        driftFingerprint: report.driftFingerprint,
        subsystems: report.subsystems,
        failures,
      });
    },
  );

  // POST /v1/ops/reconcile — master reconcile. Protected by the
  // INTEGRATION_CRON_SECRET (re-using the cron secret already used by
  // Phase 12 reliability, Phase 18 communications, and Phase 19
  // identity-security). Idempotent; bounded; returns a summary.
  app.post(
    "/v1/ops/reconcile",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ok = await requireIntegrationCronSecret(req, reply);
      if (!ok) return;
      const summary = await runMasterReconcile();
      return reply.code(200).send({ summary });
    },
  );

  // ---------------------------------------------------------------------------
  // Phase 21 — Incident management
  //
  // GET    /v1/ops/incidents             — list with filters
  // POST   /v1/ops/incidents/:id/ack     — acknowledge
  // POST   /v1/ops/incidents/:id/resolve — resolve + optional note
  // POST   /v1/ops/incidents/:id/suppress — suppress dedup re-fires
  //
  // All session-auth + identity.access_review.action gate (mutations)
  // or identity.member.read (read). Anti-enumeration 404 for non-members.
  // ---------------------------------------------------------------------------

  app.get(
    "/v1/ops/incidents",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid(),
          status: z
            .enum(INCIDENT_STATUSES as unknown as [string, ...string[]])
            .optional(),
          severity: z
            .enum(INCIDENT_SEVERITIES as unknown as [string, ...string[]])
            .optional(),
          category: z
            .enum(INCIDENT_CATEGORIES as unknown as [string, ...string[]])
            .optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        })
        .parse(req.query ?? {});
      const actor = await requireOpsActor(req, reply, q.teamId);
      if (!actor) return;
      const rows = await listIncidents({
        teamId: q.teamId,
        status: q.status as never,
        severity: q.severity as never,
        category: q.category as never,
        limit: q.limit,
      });
      return reply
        .code(200)
        .send({ incidents: rows.map(projectIncident) });
    },
  );

  const ParamsIncidentId = z.object({ id: z.string().uuid() });
  const TeamIdOnly = z.object({ teamId: z.string().uuid() });
  const ResolveBody = TeamIdOnly.extend({
    resolutionNote: z.string().min(1).max(400).optional(),
  });

  function handleIncidentError(reply: FastifyReply, err: unknown): boolean {
    if (err instanceof IncidentError) {
      const status =
        err.code === "incident_not_found"
          ? 404
          : err.code === "invalid_fingerprint"
            ? 400
            : 409;
      reply.code(status).send({ error: { code: err.code } });
      return true;
    }
    return false;
  }

  app.post(
    "/v1/ops/incidents/:id/ack",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsIncidentId.parse(req.params);
      const body = TeamIdOnly.parse(req.body ?? {});
      const actor = await requireOpsActorAction(req, reply, body.teamId);
      if (!actor) return;
      try {
        const updated = await acknowledgeIncident({
          incidentId: id,
          teamId: body.teamId,
          actorUserId: actor.userId,
          ipAddress: requestIp(req),
          userAgent: requestUa(req),
        });
        return reply.code(200).send({ incident: projectIncident(updated) });
      } catch (err) {
        if (handleIncidentError(reply, err)) return;
        throw err;
      }
    },
  );

  app.post(
    "/v1/ops/incidents/:id/resolve",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsIncidentId.parse(req.params);
      const body = ResolveBody.parse(req.body ?? {});
      const actor = await requireOpsActorAction(req, reply, body.teamId);
      if (!actor) return;
      try {
        const updated = await resolveIncident({
          incidentId: id,
          teamId: body.teamId,
          actorUserId: actor.userId,
          resolutionNote: body.resolutionNote ?? null,
          ipAddress: requestIp(req),
          userAgent: requestUa(req),
        });
        return reply.code(200).send({ incident: projectIncident(updated) });
      } catch (err) {
        if (handleIncidentError(reply, err)) return;
        throw err;
      }
    },
  );

  app.post(
    "/v1/ops/incidents/:id/suppress",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsIncidentId.parse(req.params);
      const body = TeamIdOnly.parse(req.body ?? {});
      const actor = await requireOpsActorAction(req, reply, body.teamId);
      if (!actor) return;
      try {
        const updated = await suppressIncident({
          incidentId: id,
          teamId: body.teamId,
          actorUserId: actor.userId,
          ipAddress: requestIp(req),
          userAgent: requestUa(req),
        });
        return reply.code(200).send({ incident: projectIncident(updated) });
      } catch (err) {
        if (handleIncidentError(reply, err)) return;
        throw err;
      }
    },
  );
}

function requestIp(req: FastifyRequest): string | null {
  const raw = (req.ip ?? "").trim();
  return raw.length > 0 ? raw : null;
}
function requestUa(req: FastifyRequest): string | null {
  const raw = req.headers["user-agent"];
  if (typeof raw !== "string") return null;
  return raw.trim().slice(0, 512) || null;
}

/**
 * Stricter variant of requireOpsActor for incident mutations: requires
 * the access-review.action permission (the canonical Phase 17
 * "operator can take corrective action" gate).
 */
async function requireOpsActorAction(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<{ userId: string } | null> {
  // Local import — avoids re-running the file-level imports against
  // the action-flavor of requireOpsActor.
  const { evaluateMemberAccess } = await import(
    "../services/identity/access-policy.service.js"
  );
  const userId = getAuthUserId(req);
  const member = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { id: true },
  });
  if (!member) {
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  const decision = await evaluateMemberAccess({
    teamId,
    userId,
    permission: "identity.access_review.action",
  });
  if (!decision.allowed) {
    reply.code(403).send({
      error: {
        code: "permission_denied",
        reason: decision.reason,
        detail: decision.detail ?? null,
      },
    });
    return null;
  }
  return { userId };
}
