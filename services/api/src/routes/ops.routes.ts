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
import { enforceRateLimit } from "../services/rate-limit.js";
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
  assignIncident,
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

  // 9. Phase 30.8 — sweep stale S3 multipart uploads. Tolerant of
  // S3 errors (failure count is bumped via metrics; the rest of
  // reconcile continues). Bounded to 100 rows per run.
  let multipartScanned = 0;
  let multipartAborted = 0;
  let multipartFailed = 0;
  try {
    const { reapStaleMultipartUploads } = await import(
      "../services/uploads/upload-session.service.js"
    );
    const result = await reapStaleMultipartUploads();
    multipartScanned = result.scanned;
    multipartAborted = result.aborted;
    multipartFailed = result.failed;
  } catch {
    /* best-effort — bumps already happened inside the helper */
  }
  setGauge("multipart_stale_scanned", multipartScanned);
  setGauge("multipart_stale_aborted", multipartAborted);
  setGauge("multipart_stale_failed", multipartFailed);

  // 10. Phase 32 — investigation graph reconciliation. Bounded to
  // the 10 most-recently-active teams per tick (teams whose
  // updatedAt is recent OR who have recently-finalized evidence).
  // Failures bump metric counters inside the helper; we never let
  // graph reconcile failures break the rest of reconcile.
  try {
    const recentTeams = await prisma.team.findMany({
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: { id: true },
    });
    const { reconcileTeamGraph } = await import(
      "../services/graph/graph-builder.service.js"
    );
    for (const t of recentTeams) {
      try {
        await reconcileTeamGraph(t.id);
      } catch {
        /* per-team failure — keep going */
      }
    }
  } catch {
    /* best-effort */
  }

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

  // ---------------------------------------------------------------------------
  // Phase 32.8C control plane — assignIncident
  //
  // POST /v1/ops/incidents/:id/assign
  // Body: { teamId, assigneeUserId }
  //
  // Sets the operator-owner for an incident. Permission-gated via
  // `requireOpsActorAction` (ops actor + workspace member). Audited via
  // the platform audit log inside the service.
  // ---------------------------------------------------------------------------
  const AssignBody = TeamIdOnly.extend({
    assigneeUserId: z.string().uuid(),
  });
  app.post(
    "/v1/ops/incidents/:id/assign",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsIncidentId.parse(req.params);
      const body = AssignBody.parse(req.body ?? {});
      const actor = await requireOpsActorAction(req, reply, body.teamId);
      if (!actor) return;
      // The assignee must be an actual workspace member — never assign
      // an incident to a user outside the workspace. We check the
      // TeamMember table directly (same authoritative source other
      // membership checks use).
      const member = await prisma.teamMember.findFirst({
        where: { teamId: body.teamId, userId: body.assigneeUserId },
        select: { id: true },
      });
      if (!member) {
        return reply.code(400).send({
          error: "invalid_assignee",
          message: "Assignee must be a member of this workspace.",
        });
      }
      try {
        const updated = await assignIncident({
          incidentId: id,
          teamId: body.teamId,
          assigneeUserId: body.assigneeUserId,
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

  // ---------------------------------------------------------------------------
  // Phase 32.8C FINAL-2 — Workflow Orchestration routes
  //
  //   GET   /v1/ops/workflows                     list
  //   GET   /v1/ops/workflows/:id                 single
  //   POST  /v1/ops/workflows/:id/assign          assign owner
  //   POST  /v1/ops/workflows/:id/start           transition → IN_PROGRESS
  //   POST  /v1/ops/workflows/:id/escalate        bump escalation level
  //   POST  /v1/ops/workflows/:id/mitigation      add mitigation note
  //   POST  /v1/ops/workflows/:id/resolve         transition → RESOLVED
  //   POST  /v1/ops/workflows/:id/suppress        transition → SUPPRESSED
  //   POST  /v1/ops/workflows/:id/reopen          re-open from RESOLVED/SUPPRESSED
  //   POST  /v1/ops/workflows/:id/schedule-retry  record retry intent (no execute)
  //
  //   GET   /v1/ops/causality/chains              list active chains
  //   GET   /v1/ops/causality/chains/:id          single chain
  //
  // All routes:
  //   - preHandler: requireAuth
  //   - workspace-scoped via teamId
  //   - mutating routes go through requireOpsActorAction + audit log
  // ---------------------------------------------------------------------------

  const ParamsWorkflowId = z.object({ id: z.string().uuid() });
  const TeamIdOnlyWorkflow = z.object({ teamId: z.string().uuid() });
  const AssignWorkflowBody = TeamIdOnlyWorkflow.extend({
    assigneeUserId: z.string().uuid(),
  });
  const MitigationBody = TeamIdOnlyWorkflow.extend({
    note: z.string().min(1).max(400),
  });
  const ResolveWorkflowBody = TeamIdOnlyWorkflow.extend({
    note: z.string().min(1).max(400).optional(),
  });
  const ScheduleRetryBody = TeamIdOnlyWorkflow.extend({
    nextRetryAtUtc: z.string().datetime(),
  });

  function handleWorkflowError(reply: FastifyReply, err: unknown): boolean {
    const e = err as { code?: string };
    if (e?.code === "workflow_not_found") {
      reply.code(404).send({ error: { code: "workflow_not_found" } });
      return true;
    }
    if (e?.code === "invalid_transition") {
      reply.code(409).send({ error: { code: "invalid_transition" } });
      return true;
    }
    return false;
  }

  app.get(
    "/v1/ops/workflows",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid(),
          status: z.string().min(1).max(40).optional(),
          workflowType: z.string().min(1).max(40).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        })
        .parse(req.query ?? {});
      const actor = await requireOpsActor(req, reply, q.teamId);
      if (!actor) return;
      const { listWorkflows } = await import(
        "../services/observability/workflow.service.js"
      );
      const rows = await listWorkflows({
        teamId: q.teamId,
        status: q.status,
        workflowType: q.workflowType,
        limit: q.limit,
      });
      return reply.code(200).send({ workflows: rows });
    },
  );

  app.get(
    "/v1/ops/workflows/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsWorkflowId.parse(req.params);
      const q = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const actor = await requireOpsActor(req, reply, q.teamId);
      if (!actor) return;
      const { getWorkflow } = await import(
        "../services/observability/workflow.service.js"
      );
      const row = await getWorkflow({ workflowId: id, teamId: q.teamId });
      if (!row) {
        return reply
          .code(404)
          .send({ error: { code: "workflow_not_found" } });
      }
      return reply.code(200).send({ workflow: row });
    },
  );

  app.post(
    "/v1/ops/workflows/:id/assign",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsWorkflowId.parse(req.params);
      const body = AssignWorkflowBody.parse(req.body ?? {});
      const actor = await requireOpsActorAction(req, reply, body.teamId);
      if (!actor) return;
      const member = await prisma.teamMember.findFirst({
        where: { teamId: body.teamId, userId: body.assigneeUserId },
        select: { id: true },
      });
      if (!member) {
        return reply.code(400).send({
          error: "invalid_assignee",
          message: "Assignee must be a member of this workspace.",
        });
      }
      try {
        const { assignWorkflow } = await import(
          "../services/observability/workflow.service.js"
        );
        const updated = await assignWorkflow({
          workflowId: id,
          teamId: body.teamId,
          assigneeUserId: body.assigneeUserId,
          actorUserId: actor.userId,
          ipAddress: requestIp(req),
          userAgent: requestUa(req),
        });
        return reply.code(200).send({ workflow: updated });
      } catch (err) {
        if (handleWorkflowError(reply, err)) return;
        throw err;
      }
    },
  );

  app.post(
    "/v1/ops/workflows/:id/start",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsWorkflowId.parse(req.params);
      const body = TeamIdOnlyWorkflow.parse(req.body ?? {});
      const actor = await requireOpsActorAction(req, reply, body.teamId);
      if (!actor) return;
      try {
        const { startWorkflow } = await import(
          "../services/observability/workflow.service.js"
        );
        const updated = await startWorkflow({
          workflowId: id,
          teamId: body.teamId,
          actorUserId: actor.userId,
          ipAddress: requestIp(req),
          userAgent: requestUa(req),
        });
        return reply.code(200).send({ workflow: updated });
      } catch (err) {
        if (handleWorkflowError(reply, err)) return;
        throw err;
      }
    },
  );

  app.post(
    "/v1/ops/workflows/:id/escalate",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsWorkflowId.parse(req.params);
      const body = TeamIdOnlyWorkflow.parse(req.body ?? {});
      const actor = await requireOpsActorAction(req, reply, body.teamId);
      if (!actor) return;
      try {
        const { escalateWorkflow } = await import(
          "../services/observability/workflow.service.js"
        );
        const updated = await escalateWorkflow({
          workflowId: id,
          teamId: body.teamId,
          actorUserId: actor.userId,
          ipAddress: requestIp(req),
          userAgent: requestUa(req),
        });
        return reply.code(200).send({ workflow: updated });
      } catch (err) {
        if (handleWorkflowError(reply, err)) return;
        throw err;
      }
    },
  );

  app.post(
    "/v1/ops/workflows/:id/mitigation",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsWorkflowId.parse(req.params);
      const body = MitigationBody.parse(req.body ?? {});
      const actor = await requireOpsActorAction(req, reply, body.teamId);
      if (!actor) return;
      try {
        const { addMitigation } = await import(
          "../services/observability/workflow.service.js"
        );
        const updated = await addMitigation({
          workflowId: id,
          teamId: body.teamId,
          note: body.note,
          actorUserId: actor.userId,
          ipAddress: requestIp(req),
          userAgent: requestUa(req),
        });
        return reply.code(200).send({ workflow: updated });
      } catch (err) {
        if (handleWorkflowError(reply, err)) return;
        throw err;
      }
    },
  );

  app.post(
    "/v1/ops/workflows/:id/resolve",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsWorkflowId.parse(req.params);
      const body = ResolveWorkflowBody.parse(req.body ?? {});
      const actor = await requireOpsActorAction(req, reply, body.teamId);
      if (!actor) return;
      try {
        const { resolveWorkflow } = await import(
          "../services/observability/workflow.service.js"
        );
        const updated = await resolveWorkflow({
          workflowId: id,
          teamId: body.teamId,
          note: body.note ?? null,
          actorUserId: actor.userId,
          ipAddress: requestIp(req),
          userAgent: requestUa(req),
        });
        return reply.code(200).send({ workflow: updated });
      } catch (err) {
        if (handleWorkflowError(reply, err)) return;
        throw err;
      }
    },
  );

  app.post(
    "/v1/ops/workflows/:id/suppress",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsWorkflowId.parse(req.params);
      const body = TeamIdOnlyWorkflow.parse(req.body ?? {});
      const actor = await requireOpsActorAction(req, reply, body.teamId);
      if (!actor) return;
      try {
        const { suppressWorkflow } = await import(
          "../services/observability/workflow.service.js"
        );
        const updated = await suppressWorkflow({
          workflowId: id,
          teamId: body.teamId,
          actorUserId: actor.userId,
          ipAddress: requestIp(req),
          userAgent: requestUa(req),
        });
        return reply.code(200).send({ workflow: updated });
      } catch (err) {
        if (handleWorkflowError(reply, err)) return;
        throw err;
      }
    },
  );

  app.post(
    "/v1/ops/workflows/:id/reopen",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsWorkflowId.parse(req.params);
      const body = TeamIdOnlyWorkflow.parse(req.body ?? {});
      const actor = await requireOpsActorAction(req, reply, body.teamId);
      if (!actor) return;
      try {
        const { reopenWorkflow } = await import(
          "../services/observability/workflow.service.js"
        );
        const updated = await reopenWorkflow({
          workflowId: id,
          teamId: body.teamId,
          actorUserId: actor.userId,
          ipAddress: requestIp(req),
          userAgent: requestUa(req),
        });
        return reply.code(200).send({ workflow: updated });
      } catch (err) {
        if (handleWorkflowError(reply, err)) return;
        throw err;
      }
    },
  );

  app.post(
    "/v1/ops/workflows/:id/schedule-retry",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsWorkflowId.parse(req.params);
      const body = ScheduleRetryBody.parse(req.body ?? {});
      const actor = await requireOpsActorAction(req, reply, body.teamId);
      if (!actor) return;
      try {
        const { scheduleRetry } = await import(
          "../services/observability/workflow.service.js"
        );
        const updated = await scheduleRetry({
          workflowId: id,
          teamId: body.teamId,
          nextRetryAtUtc: new Date(body.nextRetryAtUtc),
          actorUserId: actor.userId,
          ipAddress: requestIp(req),
          userAgent: requestUa(req),
        });
        return reply.code(200).send({ workflow: updated });
      } catch (err) {
        if (handleWorkflowError(reply, err)) return;
        throw err;
      }
    },
  );

  // Causality chains — read-only endpoints.

  app.get(
    "/v1/ops/causality/chains",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid(),
          limit: z.coerce.number().int().min(1).max(50).optional(),
        })
        .parse(req.query ?? {});
      const actor = await requireOpsActor(req, reply, q.teamId);
      if (!actor) return;
      const { listWorkspaceCausalityChains } = await import(
        "../services/dashboard/causality.service.js"
      );
      const chains = await listWorkspaceCausalityChains({
        teamId: q.teamId,
        limit: q.limit,
      });
      return reply.code(200).send({ chains });
    },
  );

  app.get(
    "/v1/ops/causality/chains/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = z
        .object({ id: z.string().uuid() })
        .parse(req.params);
      const q = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const actor = await requireOpsActor(req, reply, q.teamId);
      if (!actor) return;
      const chain = await prisma.operationalCausalityChain.findFirst({
        where: { id, teamId: q.teamId },
      });
      if (!chain) {
        return reply
          .code(404)
          .send({ error: { code: "chain_not_found" } });
      }
      return reply.code(200).send({ chain });
    },
  );

  // ---------------------------------------------------------------------------
  // Phase 32.8C FINAL-3 — Bulk Operational Actions
  //
  //   POST /v1/ops/bulk-actions      run a bulk action (workspace-scoped, audited)
  //   GET  /v1/ops/bulk-actions/:id  read run + items
  //
  // Every bulk action fans out to the underlying lifecycle service per
  // target — the bulk runner is NOT a permission bypass.
  // ---------------------------------------------------------------------------

  const BulkActionBody = z.object({
    teamId: z.string().uuid(),
    actionType: z.enum([
      "BULK_ASSIGN_WORKFLOWS",
      "BULK_ESCALATE_WORKFLOWS",
      "BULK_SUPPRESS_INCIDENTS",
      "BULK_RESOLVE_WORKFLOWS",
      "BULK_SCHEDULE_RETRY",
      "BULK_ACKNOWLEDGE_INCIDENTS",
      "BULK_ADD_MITIGATION",
      "BULK_DISMISS_RECOMMENDATIONS",
    ]),
    targetIds: z.array(z.string().uuid()).min(1).max(200),
    note: z.string().min(1).max(400).optional(),
    assigneeUserId: z.string().uuid().optional(),
    nextRetryAtUtc: z.string().datetime().optional(),
  });

  app.post(
    "/v1/ops/bulk-actions",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = BulkActionBody.parse(req.body ?? {});
      const actor = await requireOpsActorAction(req, reply, body.teamId);
      if (!actor) return;
      const { runBulkAction } = await import(
        "../services/dashboard/bulk-actions.service.js"
      );
      const result = await runBulkAction({
        teamId: body.teamId,
        actionType: body.actionType,
        targetIds: body.targetIds,
        note: body.note ?? null,
        assigneeUserId: body.assigneeUserId ?? null,
        nextRetryAtUtc: body.nextRetryAtUtc ?? null,
        actorUserId: actor.userId,
        ipAddress: requestIp(req),
        userAgent: requestUa(req),
      });
      return reply.code(200).send({ run: result });
    },
  );

  app.get(
    "/v1/ops/bulk-actions/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = z
        .object({ id: z.string().uuid() })
        .parse(req.params);
      const q = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const actor = await requireOpsActor(req, reply, q.teamId);
      if (!actor) return;
      const { getBulkActionRun } = await import(
        "../services/dashboard/bulk-actions.service.js"
      );
      const { run, items } = await getBulkActionRun({
        runId: id,
        teamId: q.teamId,
      });
      if (!run) {
        return reply
          .code(404)
          .send({ error: { code: "run_not_found" } });
      }
      return reply.code(200).send({ run, items });
    },
  );

  // ---------------------------------------------------------------------------
  // Phase 31.8 — Media intelligence operations actions.
  //
  // Two operator-triggered endpoints for the /ops/media-graph UI:
  //
  //   POST /v1/ops/media-intelligence/runs/:runId/retry
  //     → requeues a single failed BullMQ job onto the
  //       media-intelligence queue. Bounded auth. Idempotent: the
  //       job id is deterministic per (kind, evidenceId) so a
  //       repeat retry collapses.
  //
  //   POST /v1/ops/media-intelligence/dlq/replay
  //     → walks the queue's `failed` state and requeues up to
  //       `maxJobs` (capped at 200) entries. Never throws — returns
  //       a bounded summary the UI can render.
  //
  // Hard rules:
  //   - Both routes require Ops actor + the access-review.action
  //     permission (canonical "operator can take corrective action").
  //   - NEVER mutates job payloads or original evidence bytes.
  //   - NEVER exposes storage internals — payloads are evidenceId +
  //     kind only.
  //   - Bounded response shape — no Redis internals leak through.
  // ---------------------------------------------------------------------------

  const RetryRunParams = z.object({ runId: z.string().min(1).max(120) });
  const RetryRunBody = z.object({ teamId: z.string().uuid() }).strict();
  const ReplayDlqBody = z
    .object({
      teamId: z.string().uuid(),
      maxJobs: z.number().int().min(1).max(200).optional(),
    })
    .strict();

  app.post(
    "/v1/ops/media-intelligence/runs/:runId/retry",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { runId } = RetryRunParams.parse(req.params);
      const body = RetryRunBody.parse(req.body ?? {});
      const actor = await requireOpsActorAction(req, reply, body.teamId);
      if (!actor) return;
      const { retryMediaIntelligenceJob } = await import(
        "../queue/media-intelligence-queue.js"
      );
      const result = await retryMediaIntelligenceJob(runId);
      if (!result.ok) {
        // Bounded reason codes for the UI. NEVER surfaces stack
        // traces or Redis-side internals.
        const code = result.reason.startsWith("job_not_found")
          ? "job_not_found"
          : result.reason.startsWith("job_not_failed")
            ? "job_not_failed"
            : "queue_unavailable";
        return reply.code(code === "job_not_found" ? 404 : 503).send({
          error: { code, detail: result.reason },
        });
      }
      return reply.code(200).send({ runId, retried: true });
    },
  );

  app.post(
    "/v1/ops/media-intelligence/dlq/replay",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = ReplayDlqBody.parse(req.body ?? {});
      const actor = await requireOpsActorAction(req, reply, body.teamId);
      if (!actor) return;
      const { replayMediaIntelligenceDlq } = await import(
        "../queue/media-intelligence-queue.js"
      );
      const result = await replayMediaIntelligenceDlq({
        maxJobs: body.maxJobs,
      });
      if (!result.ok) {
        return reply.code(503).send({
          error: { code: "queue_unavailable", detail: result.reason },
        });
      }
      return reply.code(200).send({
        attempted: result.attempted,
        retried: result.retried,
        skipped: result.skipped,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Phase 30.10 — Client upload telemetry beacon.
  //
  // The browser-side MultipartUploader emits bounded lifecycle events
  // (resume / pause / cancel / retry / recovery / etc.). This endpoint
  // accepts a tiny batch of those events and bumps the corresponding
  // server-side counters so the observability dashboards see real
  // numbers when the resumable rollout is enabled.
  //
  // Hard rules:
  //   - Bounded event type catalog. Unknown types are silently
  //     dropped (no oracle for "is X a valid metric").
  //   - Bounded batch size (≤ 50 events / call).
  //   - Per-user rate limit so a misbehaving tab can't ballast the
  //     metric registry.
  //   - Team membership required — but NO permission gate beyond
  //     that. The events carry NO PII, NO storage identifiers, NO
  //     evidence-scoped context.
  // ---------------------------------------------------------------------------

  const UploadTelemetryEvent = z.object({
    type: z.enum([
      "upload_resume_total",
      "upload_pause_total",
      "upload_cancel_total",
      "upload_retry_total",
      "upload_chunk_retry_total",
      "upload_recovery_total",
      "offline_draft_created_total",
      "offline_draft_recovered_total",
      "offline_draft_conflict_total",
      "background_sync_retry_total",
      "background_sync_failed_total",
    ]),
    count: z.number().int().min(1).max(1000).optional(),
  });

  const UploadTelemetryBody = z.object({
    teamId: z.string().uuid(),
    events: z.array(UploadTelemetryEvent).min(1).max(50),
  });

  app.post(
    "/v1/ops/upload-telemetry",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      let body: z.infer<typeof UploadTelemetryBody>;
      try {
        body = UploadTelemetryBody.parse(req.body ?? {});
      } catch {
        return reply
          .code(400)
          .send({ error: { code: "invalid_payload" } });
      }
      // Anti-enumeration: a non-member of the team sees 404 the
      // same as if the team doesn't exist.
      const userId = getAuthUserId(req);
      const member = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: body.teamId, userId } },
        select: { id: true },
      });
      if (!member) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      // Per-user rate limit. 60 calls / minute is well above what
      // a healthy capture page would ever need.
      const rate = await enforceRateLimit({
        key: `ops:upload-telemetry:${userId}`,
        max: 60,
        windowSec: 60,
      });
      if (!rate.allowed) {
        reply.header(
          "retry-after",
          String(Math.max(1, Math.ceil((rate.resetAtMs - Date.now()) / 1000))),
        );
        return reply.code(429).send({ error: { code: "rate_limited" } });
      }
      for (const evt of body.events) {
        const n = evt.count ?? 1;
        for (let i = 0; i < n; i++) bump(evt.type);
      }
      return reply.code(202).send({ accepted: body.events.length });
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
