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
import { buildOperationsSummary } from "../services/operations/operations-summary.service.js";
import { ensureWorkspaceOperationsFresh } from "../services/operations/operations-reconciliation.service.js";
import { checkWriterSchemaContract } from "../services/operations/operations-writer-readiness.js";
import {
  isAssignableOperator,
  listAssignableOperators,
} from "../services/operations/assignable-operators.service.js";
import { requireAuth } from "../middleware/auth.js";
import {
  cronSecretMatches,
  readCronSecretFromEnvs,
  requireIntegrationCronSecret,
} from "../middleware/cron-secret.js";
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
  actionById,
  resolveRemediations,
  type RemediationPermission,
} from "../services/operations/remediation-registry.js";
import { executeRemediation } from "../services/operations/remediation-executor.js";
import {
  projectConditionGroups,
  totalConditions,
} from "../services/operations/operations-grouping.service.js";
import {
  listGroupAffectedRecords,
  AFFECTED_PAGE_DEFAULT,
  AFFECTED_PAGE_MAX,
  GROUPED_SCAN_LIMIT,
} from "../services/operations/operations-group-drilldown.service.js";
import { decodeConditionMetric } from "@proovra/shared-runtime";
import { emitTenantAudit } from "../services/audit/tenant-audit.service.js";
import {
  createOperationsSavedView,
  deleteOperationsSavedView,
  listOperationsSavedViews,
  updateOperationsSavedView,
} from "../services/operations/saved-views.service.js";
import {
  loadSlaCycles,
  projectIncidentSla,
  SLA_ATTENTION_POSTURES,
  SLA_POSTURES,
} from "../services/operations/incident-sla.js";
import {
  IncidentError,
  acknowledgeIncident,
  assignIncident,
  getIncidentDetail,
  listIncidents,
  projectIncident,
  resolveIncident,
  suppressIncident,
} from "../services/observability/incident.service.js";
import {
  INCIDENT_CATEGORIES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  OperationsSavedViewFilterSchema,
} from "@proovra/shared";
import { runSchemaValidation } from "../runtime/schema-validation.js";
// PHASE 12 — VERTICAL B. Server authority for Command Center workflow
// actions: availability projection, persisted-record workspace binding,
// optimistic concurrency, and durable idempotency.
import {
  WORKFLOW_ACTIONS_REQUIRING_STEP_UP,
  assertWorkflowVersion,
  bindWorkflowWorkspace,
  findWorkflowActionReplay,
  projectWorkflowForPublic,
  recordWorkflowActionIdempotency,
  resolveWorkflowActionCapability,
  stateReasonFor,
  type BoundWorkflow,
  type WorkflowActionKey,
} from "../services/observability/workflow-actions.service.js";
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";

const TeamIdQuery = z.object({ teamId: z.string().uuid() });

/**
 * ATTENTION ARCHITECTURE PHASE 4B (2026-08-22) — canonical Operations gate.
 *
 * THE DEFECT THIS REPLACES (D29)
 * ------------------------------
 * Reads were gated on `identity.member.read` and mutations on
 * `identity.access_review.action`. Neither describes Operations. The second is
 * the permission that decides whether somebody keeps their access to a
 * workspace, and using it to acknowledge a failed report both over-grants
 * (every incident triager could adjudicate access reviews) and obscures
 * (nothing named Operations answered "who may run Operations here?").
 *
 * `operations.view` / `.acknowledge` / `.assign` / `.resolve` / `.suppress`
 * are now the authority, granted by the canonical role matrix in
 * `packages/shared/src/permissions.ts` and resolved through the same
 * `evaluateMemberAccess` every other gate uses — so member lifecycle
 * (suspension, revocation, access expiry, parent-organization state) applies
 * here exactly as it does everywhere else.
 *
 * NOT INCLUDED: retry. Re-running a report or re-anchoring a record stays
 * authorized by the domain that owns it. Operations links to those actions and
 * does not acquire the right to perform them.
 */
async function requireOpsCapability(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
  permission:
    | "operations.view"
    | "operations.acknowledge"
    | "operations.assign"
    | "operations.resolve"
    | "operations.suppress",
): Promise<{ userId: string } | null> {
  const userId = getAuthUserId(req);
  const member = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { id: true },
  });
  // Anti-enumeration: a non-member is told the workspace does not exist
  // rather than that they lack permission on it.
  if (!member) {
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  const decision = await evaluateMemberAccess({ teamId, userId, permission });
  if (!decision.allowed) {
    reply.code(403).send({
      error: {
        code: "permission_denied",
        reason: decision.reason,
        detail: decision.detail ?? null,
        // Name the capability that was missing. An operator who cannot
        // acknowledge an incident should not have to guess which permission
        // they need, and "access_review" was actively misleading.
        requiredPermission: permission,
      },
    });
    return null;
  }
  return { userId };
}

/**
 * PHASE 4B — a DOMAIN action reached through the Operations surface.
 *
 * Re-running a media-intelligence job, re-anchoring a record, re-sending a
 * message: Operations SHOWS these and links to them, and the authority to
 * perform them stays with the domain that owns the work. This helper exists as
 * a separate function from `requireOpsCapability` so the boundary is visible
 * at the call site — reading `requireDomainActionOnOpsSurface(…,
 * "intelligence.run")` says exactly what is being asserted, where a widened
 * `requireOpsCapability` would have quietly let a domain permission look like
 * an operational one.
 *
 * This is why there is no `operations.retry`: it would be the generic
 * permission this split exists to avoid.
 */
async function requireDomainActionOnOpsSurface(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
  permission: "intelligence.run",
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
  const decision = await evaluateMemberAccess({ teamId, userId, permission });
  if (!decision.allowed) {
    reply.code(403).send({
      error: {
        code: "permission_denied",
        reason: decision.reason,
        detail: decision.detail ?? null,
        requiredPermission: permission,
      },
    });
    return null;
  }
  return { userId };
}

/** READ the workspace's shared operational state. */
async function requireOpsActor(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<{ userId: string } | null> {
  return requireOpsCapability(req, reply, teamId, "operations.view");
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
  /**
   * PHASE 13 §4 — upload SESSION rows flipped to EXPIRED on this tick. Distinct
   * from `uploadsStalled`, which counts evidence stuck mid-upload: this is the
   * session state machine's own terminal transition.
   */
  uploadSessionsExpired: number;
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
  // PHASE 13 §4 (2026-08-17) — the DATABASE half of the same sweep.
  //
  // `reapStaleMultipartUploads` releases the S3-side parts of abandoned uploads
  // and has run on this tick since Phase 30.8. `reapStaleUploadSessions` is its
  // sibling in the same module and was armed by nothing, so an abandoned upload
  // had its storage released while its `evidence_upload_sessions` row went on
  // claiming INITIATED/UPLOADING/VERIFYING past its own `expires_at_utc` — with
  // no terminal state, forever. Both halves now run on the same tick, in that
  // order: release the bytes, then close the row.
  //
  // Bounded (200 rows per call) and independently failure-isolated, like every
  // other step here — a reaper failure must not stop the rest of reconcile.
  let uploadSessionsExpired = 0;
  try {
    const { reapStaleMultipartUploads, reapStaleUploadSessions } = await import(
      "../services/uploads/upload-session.service.js"
    );
    const result = await reapStaleMultipartUploads();
    multipartScanned = result.scanned;
    multipartAborted = result.aborted;
    multipartFailed = result.failed;
    const reaped = await reapStaleUploadSessions();
    uploadSessionsExpired = reaped.reaped;
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
    uploadSessionsExpired,
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
  // reachable AND no critical-in-production config violations exist
  // AND the required runtime schema is present. Operators /
  // orchestrators should use this for "should new traffic be sent to
  // this instance".
  app.get("/readyz", async (req, reply) => {
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
    // Required-schema gate — migrations must be applied before this
    // instance reports ready. `notification_schedule_settings`
    // (migration 20270916000000_operations_center_history_and_schedule)
    // is the canary: the notification-preferences routes and the digest
    // scheduler fail without it. The `SELECT 1` above already
    // succeeded, so a throw here means the table is missing (Prisma
    // P2021 / Postgres 42P01) — i.e. `pnpm prisma:migrate` has not been
    // run against this database yet. Fail readiness, NEVER the process:
    // startup schema validation registers these objects at `important`
    // severity (see runtime/schema-validation.ts) so the api still
    // boots and an operator can exec in to apply the migration.
    try {
      await prisma.$queryRaw`SELECT 1 FROM "notification_schedule_settings" LIMIT 1`;
    } catch {
      return reply.code(503).send({
        status: "degraded",
        reason: "required_schema_missing",
      });
    }
    // THE OPERATIONS WRITER CONTRACT.
    //
    // The canary above proves one table exists. It cannot prove that the
    // writer's tables have every COLUMN this image's Prisma model declares,
    // and that gap is not theoretical: a production workspace reported six
    // failed Operations sources and zero recorded conditions while `/readyz`
    // answered ok, `SELECT 1` answered ok and the canary table was present.
    // An image that cannot record an operational condition is not ready to
    // receive traffic, and saying so here is what stops it claiming otherwise.
    //
    // Bounded reason only. The detail goes to the operator's logs, never to a
    // load balancer's response body.
    const writerContract = await checkWriterSchemaContract();
    if (!writerContract.ok) {
      req.log?.error(
        { writerContract: writerContract.detail },
        "operations writer schema contract unsatisfied",
      );
      return reply.code(503).send({
        status: "degraded",
        reason: "operations_writer_schema_mismatch",
      });
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
  //
  // Phase O Stage 3 (Sentry NODE-W repair):
  //   - Operators previously hit ZodError when calling this endpoint
  //     without a `teamId` query param (the operator dashboard never
  //     adds one; it relies on the user's current workspace). The
  //     ZodError leaked through the central error handler as a 500
  //     and was captured by Sentry. We now resolve the teamId from
  //     the canonical workspace context (`user.currentWorkspaceId`,
  //     the same pattern used by intelligence-platform.routes.ts,
  //     product-and-lifecycle.routes.ts, and trust-and-governance.
  //     routes.ts) BEFORE running Zod against the resolved object.
  //   - If the user has no active workspace, return a bounded 400
  //     instead of a ZodError 500. Anti-enumeration is preserved —
  //     `requireOpsActor` still 404s non-members of the resolved team.
  app.get(
    "/v1/ops/metrics",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const rawQuery = (req.query ?? {}) as { teamId?: string };
      let resolvedTeamId = rawQuery.teamId;
      if (!resolvedTeamId) {
        const userId = getAuthUserId(req);
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { currentWorkspaceId: true },
        });
        if (!user?.currentWorkspaceId) {
          return reply.code(400).send({
            error: {
              code: "WORKSPACE_CONTEXT_REQUIRED",
              message:
                "Select a workspace to view operational metrics.",
              requestId: req.id,
            },
          });
        }
        resolvedTeamId = user.currentWorkspaceId;
      }
      // Zod parse runs AFTER context resolution, on the resolved
      // object — never on raw input that might lack teamId. Failure
      // here means the resolved teamId is not a UUID (a real data
      // integrity issue), which deserves a bounded 400.
      const parsed = TeamIdQuery.safeParse({ teamId: resolvedTeamId });
      if (!parsed.success) {
        return reply.code(400).send({
          error: {
            code: "INVALID_QUERY",
            message: "Workspace context invalid.",
            requestId: req.id,
          },
        });
      }
      const q = parsed.data;
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
    // PHASE1-004 (2026-08-16) — a fifth machine-secret comparison, found by
    // searching for siblings of FINAL-003.
    //
    // This compared the scrape token with a raw `!==` on the presented string:
    // non-constant-time, and with no minimum length, so a two-character
    // METRICS_SCRAPE_TOKEN was honoured here while the canonical authority
    // refuses anything under sixteen.
    //
    // THE ORDER OF THE TWO CHECKS BELOW MATTERS, and getting it wrong would be
    // worse than the defect. `readCronSecretFromEnvs` returns null BOTH when
    // the variable is unset and when it is set but too short. Feeding that
    // straight into the existing `if (requiredToken)` shape would mean a
    // too-short token took the "no token configured" branch — and this endpoint
    // serves the Prometheus exposition unauthenticated on that branch. A
    // weak-secret defect would have become an open-metrics defect. So presence
    // is established from the raw variable first, and a token that is present
    // but unusable fails CLOSED with 503 rather than falling through.
    const rawToken = process.env.METRICS_SCRAPE_TOKEN?.trim() ?? "";
    if (rawToken.length > 0) {
      const requiredToken = readCronSecretFromEnvs(["METRICS_SCRAPE_TOKEN"]);
      if (requiredToken === null) {
        return reply
          .code(503)
          .send({ error: { code: "METRICS_SCRAPE_TOKEN_TOO_WEAK" } });
      }
      const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
      if (!cronSecretMatches(requiredToken, m?.[1])) {
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
  // All session-auth + the CANONICAL Operations permissions: operations.view
  // to read, and operations.{acknowledge,resolve,suppress,assign} per
  // mutation. Anti-enumeration 404 for non-members.
  // ---------------------------------------------------------------------------

  /**
   * ATTENTION ARCHITECTURE PHASE 4C (2026-08-22) — THE canonical workspace
   * Operations summary.
   *
   * ONE authority for "how much unresolved shared work does this workspace
   * have?". Home consumes this; Home does not compute it. Before this
   * endpoint, Home derived workspace health from `GET /v1/me/inbox` through
   * `buildOperationalQueue()` — one person's notification feed reported as the
   * workspace's state, so archiving a notification changed the dashboard.
   *
   * ==========================================================================
   * WHO MAY READ THIS, AND WHY IT IS NOT THE WORKBENCH GATE
   * ==========================================================================
   * CLOSURE PASS (2026-08-22). Two DIFFERENT questions are gated by two
   * different things, and conflating them would have cost Personal Free users
   * sight of their own records' integrity:
   *
   *   "may I SEE my workspace's own health?"
   *        -> the `operations.view` PERMISSION, resolved by
   *           `evaluateMemberAccess` from the canonical ROLE floor. Every
   *           ACTIVE member of a workspace holds it, including the sole owner
   *           of a Personal Free space. Their evidence is their own data, and
   *           a count of their own failing records is not somebody else's
   *           secret.
   *
   *   "may I ENTER the Operations workbench?"
   *        -> the `OPERATIONS_VIEW` CAPABILITY, derived from whether the
   *           workspace can PRODUCE operational conditions (its package
   *           includes a condition-producing feature, or more than one
   *           operator shares it). That gates the ROUTE, in
   *           `apps/web/lib/navigation/routeRegistry.ts`.
   *
   * So a Personal Free owner reads this endpoint and gets an honest summary of
   * their own workspace — which is what Home renders — and still has no
   * workbench, because there is no shared triage to do in a space with one
   * operator and no condition-producing package.
   *
   * The alternative would have been to grant Free `OPERATIONS_VIEW` to make
   * Home work, which would have handed them a workbench to solve a reporting
   * problem. `attention-arch-closure-free-visibility.test.ts` pins both halves.
   *
   * Membership lifecycle still applies in full: `evaluateMemberAccess` refuses
   * a suspended, revoked or expired member, and a non-member gets the
   * anti-enumeration 404.
   */
  app.get(
    "/v1/ops/summary",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const actor = await requireOpsActor(req, reply, q.teamId);
      if (!actor) return;

      // THIS GET IS SIDE-EFFECT FREE, AND THAT IS A CORRECTION.
      //
      // It used to call `ensureWorkspaceOperationsFresh` before reading, so
      // every page load, every poll and every browser tab could start a
      // reconciliation. Three things were wrong with that:
      //
      //   * A GET that mutates cannot be retried, cached or replayed safely,
      //     and "Check again" in the browser was therefore indistinguishable
      //     from a plain refetch — pressing it re-ran the same read and, by
      //     accident, sometimes a run.
      //   * The trigger was invisible. Nothing in the response said whether
      //     this request had started work, so a workspace could be reconciling
      //     because somebody opened a tab, and nothing recorded that.
      //   * It made the read's latency and failure modes depend on the
      //     writer's, which is how a broken writer became a broken page.
      //
      // Reconciliation now has ONE explicit entry point for a person —
      // `POST /v1/ops/workspace-reconcile` below — plus the scheduler. This
      // handler reads what is known and says so honestly, including
      // `NEVER_RUN`, which the client answers by asking for a run.
      const summary = await buildOperationsSummary({
        workspaceId: q.teamId,
        viewerUserId: actor.userId,
      });
      // ======================================================================
      // WHY A COUNT OF OPERATORS TRAVELS WITH THE SUMMARY
      // ======================================================================
      // The workbench has to decide whether OWNERSHIP is a meaningful axis in
      // this workspace: whether to render "Assigned to me" / "Unassigned"
      // cards and an owner filter at all. In a space with one operator those
      // controls partition work between a person and themselves.
      //
      // The obvious client-side signal is the caller's own OPERATIONS_ASSIGN
      // capability, and it is wrong. A VIEWER in a shared Team workspace holds
      // no assign capability and absolutely should still be able to filter by
      // owner — "who is on this?" is the question they are there to answer.
      // Branching on the workspace KIND instead would be a plan-shaped branch
      // in the UI, which this program has spent a phase removing.
      //
      // So the server answers the workspace-shape question directly, from the
      // SAME resolver that decides who may be assigned. It is a COUNT and
      // never the identities: eligibility to see how many operators exist is
      // not eligibility to enumerate them, and the picker route stays gated on
      // `operations.assign`.
      const operatorCount = (await listAssignableOperators({ teamId: q.teamId }))
        .length;
      return reply.code(200).send({
        summary,
        workspace: { operatorCount },
      });
    },
  );

  /**
   * POST /v1/ops/workspace-reconcile — ask for a fresh picture, explicitly.
   *
   * WHY IT IS A MUTATION AND NOT A QUERY PARAMETER ON THE GET
   * -------------------------------------------------------------------------
   * Starting a multi-source discovery sweep is work. It takes a durable lock,
   * writes incident rows and records a run. That is a mutation whatever verb
   * carries it, and pretending otherwise is what let a page load start one
   * invisibly.
   *
   * IDEMPOTENCY IS THE LOCK, NOT A HEADER
   * -------------------------------------------------------------------------
   * The durable per-workspace lock in `@proovra/shared-runtime` is the
   * idempotency key. A second caller during a live run gets
   * `alreadyRunning` — which is not an error, it is the honest answer to
   * "please reconcile": it IS being reconciled. So a double-click, a retry and
   * fifty operators pressing the button at once produce ONE run, and none of
   * them is told something false.
   *
   * AUTHORIZATION is the same `operations.view` floor as the read. Asking the
   * system to look again at a workspace you may already look at is not a
   * larger authority than looking — it creates no incident that was not
   * already true, exposes nothing new, and is bounded by the lock. It is
   * deliberately NOT gated on `operations.assign` or a remediation
   * permission: a viewer who can see a stale picture and cannot ask for a
   * fresh one is being shown something they know is wrong with no way to
   * correct it.
   */
  app.post(
    "/v1/ops/workspace-reconcile",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({ teamId: z.string().uuid() })
        .parse((req.body ?? req.query ?? {}) as unknown);
      const actor = await requireOpsActor(req, reply, body.teamId);
      if (!actor) return;

      // An image that cannot RECORD a condition must not be asked to look for
      // one: the sweep would find the same conditions, fail the same writes
      // and produce a second identical PARTIAL run. Refuse before doing the
      // work, and say that retrying is not the remedy.
      const contract = await checkWriterSchemaContract();
      if (!contract.ok) {
        req.log?.error(
          { writerContract: contract.detail, workspaceId: body.teamId },
          "refusing workspace reconcile: writer schema contract unsatisfied",
        );
        return reply.code(503).send({
          started: false,
          alreadyRunning: false,
          // Bounded and closed-vocabulary. The client renders a
          // non-retryable state from this; it never sees the detail.
          refusedReason: "schema_mismatch",
          retryable: false,
        });
      }

      const outcome = await ensureWorkspaceOperationsFresh({
        workspaceId: body.teamId,
      });
      return reply.code(202).send({
        started: outcome.refreshing,
        alreadyRunning: outcome.refreshing && outcome.run?.readiness === "RUNNING",
        refusedReason: outcome.refreshBlockedReason,
        retryable: outcome.refreshBlockedReason == null,
        readiness: outcome.run?.readiness ?? "NEVER_RUN",
      });
    },
  );

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
          /**
           * Ownership. "me" is resolved to the CALLER below rather than
           * accepted as a magic id, so a caller cannot pass "me" and have it
           * mean somebody else, and the service layer never learns who is
           * asking.
           */
          owner: z
            .union([
              z.literal("any"),
              z.literal("me"),
              z.literal("unassigned"),
              z.string().uuid(),
            ])
            .optional(),
          /**
           * ONE posture from the closed SLA vocabulary.
           *
           * Enumerated against `SLA_POSTURES` rather than a free string, so
           * a filter can never ask for a state the projection cannot produce
           * — which would return an empty queue that looks like good news.
           */
          sla: z
            .enum(SLA_POSTURES as unknown as [string, ...string[]])
            .optional(),
          /** Free text over title + safe summary. Bounded. */
          q: z.string().trim().max(120).optional(),
          sort: z
            .enum(["recent", "severity", "oldest", "occurrences"])
            .optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
          // PHASE 2.7 — keyset cursor. Opaque to the client; echoed back
          // verbatim from `nextCursor` on the previous page.
          cursor: z.string().uuid().optional(),
        })
        .parse(req.query ?? {});
      const actor = await requireOpsActor(req, reply, q.teamId);
      if (!actor) return;
      const owner =
        q.owner === undefined || q.owner === "any"
          ? ({ kind: "ANY" } as const)
          : q.owner === "unassigned"
            ? ({ kind: "UNASSIGNED" } as const)
            : q.owner === "me"
              ? ({ kind: "USER", userId: actor.userId } as const)
              : ({ kind: "USER", userId: q.owner } as const);
      const slaNowForFilter = new Date();
      const page = await listIncidents({
        teamId: q.teamId,
        sla: q.sla ?? null,
        now: slaNowForFilter,
        status: q.status as never,
        severity: q.severity as never,
        category: q.category as never,
        owner,
        q: q.q,
        sort: q.sort,
        limit: q.limit,
        cursor: q.cursor ?? null,
      });
      // ONE cycle read per page, and ONE clock. A read per row would issue a
      // query per condition, and a fresh `new Date()` per row would measure
      // the first and last rows of a long page against different presents.
      const slaCycles = await loadSlaCycles({
        teamId: q.teamId,
        incidentIds: page.incidents.map((i) => i.id),
      });
      const slaNow = slaNowForFilter;
      const projectedRows = page.incidents.map((row) =>
        withSla(projectIncident(row), slaCycles, slaNow),
      );
      /**
       * THE FILTER AND THE BADGE AGREE, BY CONSTRUCTION.
       *
       * The database predicate selects a SUPERSET for postures whose exact
       * definition is not expressible in one WHERE clause (AT_RISK needs the
       * per-cycle lead time). Narrowing here with the SAME projection the
       * badge uses is what keeps the filtered list from containing a row
       * whose badge says something else — the alternative, a second copy of
       * the rule in SQL, is precisely the divergence this closure removed.
       *
       * Deliberately a narrowing and never a widening: the predicate never
       * under-selects, so nothing is hidden by this step.
       */
      const rows = q.sla
        ? projectedRows.filter((r) => r.sla.posture === q.sla)
        : projectedRows;
      return reply.code(200).send({
        incidents: rows,
        /**
         * THE SLA VOCABULARY THIS PAGE SPEAKS.
         *
         * The closed set of postures and the subset the SERVER classes as
         * needing attention, sent with the rows so the browser emphasises
         * what the server decided rather than repeating the decision. There
         * are deliberately no HOURS here: hours belong to an individual
         * condition's recorded promise, and a page-level number would invite
         * a client to recompute a deadline from it.
         */
        sla: {
          postures: [...SLA_POSTURES],
          attentionPostures: [...SLA_ATTENTION_POSTURES],
        },
        pagination: {
          nextCursor: page.nextCursor,
          returned: rows.length,
        },
        // PHASE 2.2 / 2.3 — say whether this read reached the end.
        //
        // `complete: false` means rows exist beyond this page, so NOTHING may
        // conclude "no such incident" or "all clear" from this response. The
        // flag travels with the data rather than being inferred from
        // `nextCursor != null` at each call site, because that inference is
        // exactly the kind a surface gets wrong once and then reports a
        // confident zero forever.
        completeness: {
          complete: page.complete,
          mayAssertAllClear: page.complete,
        },
      });
    },
  );


  // ==========================================================================
  // THE GROUPED QUEUE, AND THE DRILL-DOWN UNDERNEATH IT
  // ==========================================================================
  //
  // `projectConditionGroups` has existed and been conserved-by-test for a
  // release, and NOTHING SERVED IT. No route returned groups and no surface
  // rendered them, so a workspace with five thousand per-record integrity
  // conditions got five thousand top-level rows — a queue nobody can triage,
  // and the exact flood the grouping was written to prevent.
  //
  // These two routes expose the projection that already existed. They add no
  // second grouping engine: the first calls `projectConditionGroups`, and the
  // second pages the members of one group it produced.

  const GroupsQuery = z.object({
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
    owner: z
      .union([
        z.literal("any"),
        z.literal("me"),
        z.literal("unassigned"),
        z.string().uuid(),
      ])
      .optional(),
    sla: z.enum(SLA_POSTURES as unknown as [string, ...string[]]).optional(),
    q: z.string().trim().max(120).optional(),
  });

  /**
   * GET /v1/ops/incident-groups — the queue, collapsed by source.
   *
   * The SAME filters the flat list accepts, applied to the SAME rows, before
   * the SAME projection groups them. A group is not a different set of
   * conditions; it is the set the operator asked for, presented once per
   * source instead of once per record.
   *
   * BOUNDED BY CONSTRUCTION. The read is capped, the response carries one row
   * per source rather than one per condition, and each group's inline
   * `affectedSample` is a handful — the members are paged by the drill-down
   * below. There is no request shape that returns five thousand records.
   */
  app.get(
    "/v1/ops/incident-groups",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = GroupsQuery.parse(req.query ?? {});
      const actor = await requireOpsActor(req, reply, q.teamId);
      if (!actor) return;

      const owner =
        q.owner === undefined || q.owner === "any"
          ? ({ kind: "ANY" } as const)
          : q.owner === "unassigned"
            ? ({ kind: "UNASSIGNED" } as const)
            : q.owner === "me"
              ? ({ kind: "USER", userId: actor.userId } as const)
              : ({ kind: "USER", userId: q.owner } as const);

      const now = new Date();
      // The grouping is a PRESENTATION over the conditions the filters
      // selected, so it reads them through the same service the flat list
      // does — one authority, one scope, one set of filters.
      const page = await listIncidents({
        teamId: q.teamId,
        sla: q.sla ?? null,
        now,
        status: q.status as never,
        severity: q.severity as never,
        category: q.category as never,
        owner,
        q: q.q,
        limit: GROUPED_SCAN_LIMIT,
        cursor: null,
      });

      const groups = projectConditionGroups(
        page.incidents.map((row) => ({
          id: row.id,
          category: row.category as never,
          fingerprint: row.fingerprint,
          severity: row.severity,
          status: row.status,
          title: row.title,
          safeSummary: row.safeSummary,
          firstSeenAtUtc: row.firstSeenAtUtc,
          lastSeenAtUtc: row.lastSeenAtUtc,
          occurrenceCount: row.occurrenceCount,
          relatedEvidenceId: row.relatedEvidenceId,
          assignedOperatorUserId: row.assignedOperatorUserId,
          sourceId: row.sourceId,
          // THE WHOLE SNAPSHOT. Only the value used to travel, so the group
          // had a number and no unit and no threshold — and rendered every
          // one of them as "affected records".
          metric: decodeConditionMetric(row.metricSnapshot),
        })),
      );

      return reply.code(200).send({
        groups,
        /**
         * THE TWO HEADLINE TOTALS, COMPUTED SERVER-SIDE.
         *
         * The page header used to read "38 conditions" while showing five
         * groups, because it was counting the FLAT list's rows regardless of
         * which surface was on screen. Both numbers are true and they answer
         * different questions, so both are sent and the header says which is
         * which: "5 groups · 38 conditions".
         *
         * Sent rather than derived in the browser so the header cannot
         * disagree with the list it sits above — the conservation property
         * below is a statement about THESE numbers.
         */
        totals: {
          groups: groups.length,
          conditions: totalConditions(groups),
        },
        /**
         * CONSERVATION, stated in the response.
         *
         * The sum of every group's `conditionCount` is the number of rows this
         * read returned. A surface that showed groups and a total that did not
         * add up would be two numbers nobody could reconcile.
         */
        conservation: {
          conditions: page.incidents.length,
          grouped: totalConditions(groups),
        },
        /**
         * `complete: false` means the bounded read did not reach the end, so
         * the GROUPS are a floor and nothing may conclude "all clear" from
         * them. Carried with the data rather than inferred at each call site.
         */
        completeness: {
          complete: page.complete,
          mayAssertAllClear: page.complete,
        },
        sla: {
          postures: [...SLA_POSTURES],
          attentionPostures: [...SLA_ATTENTION_POSTURES],
        },
      });
    },
  );

  /**
   * GET /v1/ops/incident-groups/:groupKey/affected — the members, paged.
   *
   * The drill-down. A group says "TSA timestamping failed for 5,000 records";
   * this is how an operator reaches record 4,312 without the queue having
   * rendered all five thousand.
   *
   * ANTI-ENUMERATION. The group key is not a resource id — it is the source id
   * every member declares — so a caller cannot probe for groups that exist in
   * another workspace: the query is scoped to THEIR workspace first and the
   * key is a filter within it. An unknown key and another tenant's key are the
   * same empty page.
   *
   * KEYSET PAGINATION on `(firstSeenAtUtc, id)`, which is total: two rows can
   * share an instant and cannot share an id, so a page boundary can never
   * repeat or skip a record.
   */
  const AffectedQuery = z.object({
    teamId: z.string().uuid(),
    status: z
      .enum(INCIDENT_STATUSES as unknown as [string, ...string[]])
      .optional(),
    severity: z
      .enum(INCIDENT_SEVERITIES as unknown as [string, ...string[]])
      .optional(),
    limit: z.coerce.number().int().min(1).max(AFFECTED_PAGE_MAX).optional(),
    cursor: z.string().uuid().optional(),
  });

  app.get(
    "/v1/ops/incident-groups/:groupKey/affected",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { groupKey } = z
        .object({ groupKey: z.string().min(1).max(120) })
        .parse(req.params);
      const q = AffectedQuery.parse(req.query ?? {});
      const actor = await requireOpsActor(req, reply, q.teamId);
      if (!actor) return;

      const limit = q.limit ?? AFFECTED_PAGE_DEFAULT;
      const rows = await listGroupAffectedRecords({
        teamId: q.teamId,
        sourceId: groupKey,
        status: q.status ?? null,
        severity: q.severity ?? null,
        limit,
        cursor: q.cursor ?? null,
      });

      return reply.code(200).send({
        groupKey,
        records: rows.records,
        pagination: { nextCursor: rows.nextCursor, returned: rows.records.length },
        completeness: { complete: rows.nextCursor === null },
      });
    },
  );

  const ParamsIncidentId = z.object({ id: z.string().uuid() });

  /**
   * GET /v1/ops/incidents/:id — ONE condition, with its history.
   *
   * The read behind the workbench inspector. It exists because
   * `OperationalIncidentEvent` was written by six code paths and read by none:
   * the console could say a condition was ACKNOWLEDGED and not by whom, or
   * when, or how many times it had re-fired since — so an operator deciding
   * whether to pick something up had to ask a colleague.
   *
   * Gated on `operations.view` exactly like the list, through the same
   * `requireOpsActor`. There is no separate "detail" permission: a caller who
   * may see that a condition exists may see what happened to it, and inventing
   * a second gate here would be a place for the two to drift apart.
   *
   * Anti-enumeration: an id belonging to ANOTHER workspace is indistinguishable
   * from an id that does not exist. Both are 404, and the tenant predicate is
   * in the query rather than in a comparison after the read.
   */
  app.get(
    "/v1/ops/incidents/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsIncidentId.parse(req.params);
      const q = z.object({ teamId: z.string().uuid() }).parse(req.query ?? {});
      const actor = await requireOpsActor(req, reply, q.teamId);
      if (!actor) return;
      const detail = await getIncidentDetail({
        incidentId: id,
        teamId: q.teamId,
      });
      if (!detail) {
        return reply.code(404).send({ error: { code: "incident_not_found" } });
      }

      /**
       * WHAT THIS CALLER MAY DO ABOUT THIS CONDITION.
       *
       * Resolved SERVER-side, per incident, per caller. The browser renders
       * what comes back and has no input that would let it reconstruct
       * eligibility from a label, a severity or a plan name — which is the
       * only way a client-side action gate stays honest.
       *
       * Every predicate below is a real authorization question asked of the
       * canonical authority, not a cached guess:
       *   - may this operator take THIS action?      evaluateMemberAccess
       *   - may they open the deep link's target?    evaluateMemberAccess
       *   - may this workspace mutate at all?        the same lifecycle gate
       *     `requireOpsCapability` already applied to reach this line.
       */
      const permissionCache = new Map<string, boolean>();
      const allows = async (permission: string): Promise<boolean> => {
        const cached = permissionCache.get(permission);
        if (cached !== undefined) return cached;
        const decision = await evaluateMemberAccess({
          teamId: q.teamId,
          userId: actor.userId,
          permission: permission as never,
        }).catch(() => ({ allowed: false }) as { allowed: boolean });
        permissionCache.set(permission, decision.allowed === true);
        return decision.allowed === true;
      };

      // Resolve the small closed set of permissions the registry can ask for,
      // once, before the pure resolver runs.
      for (const permission of [
        // The DOMAIN permissions the registry's actions require. Operations
        // permissions are NOT in this list: a remediation is a domain action
        // and this route does not confer the right to perform one.
        "evidence.publish_verify",
        "evidence.generate_report",
        "evidence.read",
        "integration.webhook.manage",
        "governance.policy.read",
        "audit.read",
      ]) {
        await allows(permission);
      }

      const remediation = resolveRemediations(
        { category: detail.category, fingerprint: detail.fingerprint },
        {
          can: (permission: RemediationPermission) =>
            permissionCache.get(permission) === true,
          hasPermission: (permission: string) =>
            permissionCache.get(permission) === true,
          // Reaching this line already required an ACTIVE member of a live
          // workspace; `requireOpsActor` refuses a suspended or revoked one.
          workspaceCanMutate: true,
          incidentStatus: detail.status,
        },
      );

      // The drawer reads the SAME posture the row does, from the same helper
      // and the same persisted cycle.
      const detailCycles = await loadSlaCycles({
        teamId: q.teamId,
        incidentIds: [detail.id],
      });
      return reply.code(200).send({
        incident: withSla(detail, detailCycles, new Date()),
        remediation,
      });
    },
  );

  const TeamIdOnly = z.object({ teamId: z.string().uuid() });
  const ResolveBody = TeamIdOnly.extend({
    resolutionNote: z.string().min(1).max(400).optional(),
  });

  function handleIncidentError(reply: FastifyReply, err: unknown): boolean {
    if (err instanceof IncidentError) {
      // Every source-contract refusal is a 409 like any other refused
      // transition: the request was well formed and the current state of the
      // resource is what refuses it.
      //
      //   CONDITION_STILL_ACTIVE             the source says it is still true
      //   CONDITION_ACTIVITY_UNKNOWN         the source could not be read
      //   CONDITION_NOT_DIRECTLY_RESOLVABLE  nobody may close this one
      //
      // Three codes and not one, because they are three different facts and
      // the operator is owed the difference — "we could not check" must never
      // be presented as "it is still broken". Named explicitly rather than
      // left to the fallback so the mapping is a decision on the record.
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

  /**
   * POST /v1/ops/incidents/:id/remediate
   *
   * Executes ONE registered remediation against the domain authority that owns
   * the work. This route owns no queue, no job id and no artifact lifecycle —
   * it authorizes, then dispatches.
   *
   * 202 for accepted asynchronous work, because that is what happened: the
   * request was accepted and the work is queued. A 200 would invite the caller
   * to read it as completion, and asynchronous work reporting itself complete
   * is the most misleading thing an operations surface can do.
   *
   * The permission is the ACTION's, not a blanket "may remediate": resuming
   * anchoring and regenerating a signed artifact are different decisions, and
   * a single gate over both would let the smaller authority perform the
   * larger action.
   */
  app.post(
    "/v1/ops/incidents/:id/remediate",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsIncidentId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          actionId: z.string().min(1).max(64),
        })
        .parse(req.body ?? {});

      const action = actionById(body.actionId);
      if (!action) {
        // An unregistered action id is refused before any workspace lookup, so
        // probing for action names reveals nothing about the workspace.
        return reply
          .code(400)
          .send({ error: { code: "unknown_remediation_action" } });
      }

      /**
       * TWO GATES, AND BOTH ARE NECESSARY.
       *
       *   1. `operations.view` — be an operator in THIS workspace at all.
       *      This is what refuses a suspended workspace, a wrong-workspace
       *      context and a platform admin with no membership, and it is what
       *      resolves the actor identity everything below is attributed to.
       *
       *   2. the ACTION's own DOMAIN permission — hold the right to perform
       *      the underlying work. `packages/shared/src/permissions.ts` states
       *      this as a rule: re-anchoring a record and retrying a report are
       *      domain actions, and "Operations may link to it; it does not
       *      acquire the right to perform it."
       *
       * Requiring only the first would make Operations a second authority
       * over every domain it displays. Requiring only the second would let
       * somebody with an evidence right act inside a workspace they are not
       * an operator of.
       */
      const actor = await requireOpsCapability(
        req,
        reply,
        body.teamId,
        "operations.view",
      );
      if (!actor) return;

      const domainAllowed = await evaluateMemberAccess({
        teamId: body.teamId,
        userId: actor.userId,
        permission: action.permission as never,
      })
        .then((d) => d.allowed === true)
        .catch(() => false);
      if (!domainAllowed) {
        // 403, not 404: the caller legitimately reached this route and this
        // condition. What they lack is the domain right, and saying so is not
        // a disclosure — they can already see the condition.
        return reply
          .code(403)
          .send({ error: { code: "remediation_not_permitted" } });
      }

      const result = await executeRemediation({
        incidentId: id,
        teamId: body.teamId,
        actionId: action.actionId,
        actorUserId: actor.userId,
        ipAddress: requestIp(req),
        userAgent: requestUa(req),
      });

      const status =
        result.result === "QUEUED"
          ? 202
          : result.result === "REFUSED"
            ? 403
            : result.result === "NOT_ELIGIBLE"
              ? 409
              : result.result === "QUEUE_UNAVAILABLE"
                ? 503
                : 200;

      return reply.code(status).send({ remediation: result });
    },
  );

  app.post(
    "/v1/ops/incidents/:id/ack",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsIncidentId.parse(req.params);
      const body = TeamIdOnly.parse(req.body ?? {});
      const actor = await requireOpsCapability(req, reply, body.teamId, "operations.acknowledge");
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
      const actor = await requireOpsCapability(req, reply, body.teamId, "operations.resolve");
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
      const actor = await requireOpsCapability(req, reply, body.teamId, "operations.suppress");
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
  // `requireOpsCapability` (ops permission + workspace member). Audited via
  // the platform audit log inside the service.
  // ---------------------------------------------------------------------------
  /**
   * CLOSURE PASS (2026-08-22) — THE ELIGIBLE-ASSIGNEE PICKER.
   *
   * The console had no way to discover who could be assigned, so the feature
   * was unreachable even though the capability and the write path existed.
   * This returns exactly the set the mutation below will accept: ACTIVE
   * members of THIS workspace, with unexpired access, who hold the
   * operational-action tier.
   *
   * Gated on `operations.assign` — the ability to see who you could hand work
   * to is the same decision as the ability to hand it to them.
   */
  app.get(
    "/v1/ops/assignable-operators",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z.object({ teamId: z.string().uuid() }).parse(req.query ?? {});
      const actor = await requireOpsCapability(
        req,
        reply,
        q.teamId,
        "operations.assign",
      );
      if (!actor) return;
      const operators = await listAssignableOperators({ teamId: q.teamId });
      return reply.code(200).send({
        operators,
        // The caller's own id, so the UI can offer "assign to me" without a
        // second round trip or a client-side guess about who it is.
        selfUserId: actor.userId,
      });
    },
  );

  const AssignBody = TeamIdOnly.extend({
    /**
     * NULL means UNASSIGN. Modelled as a nullable field on the same route
     * rather than a separate endpoint, because assign / reassign / unassign
     * are one transition on one column: splitting them would give the same
     * state change two authorization paths to keep in step.
     */
    assigneeUserId: z.string().uuid().nullable(),
  });
  app.post(
    "/v1/ops/incidents/:id/assign",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsIncidentId.parse(req.params);
      const body = AssignBody.parse(req.body ?? {});
      const actor = await requireOpsCapability(req, reply, body.teamId, "operations.assign");
      if (!actor) return;
      // CLOSURE PASS (2026-08-22) — ELIGIBILITY, not mere membership.
      //
      // This was `teamMember.findFirst({ teamId, userId })` with NO status
      // predicate, so a SUSPENDED or REVOKED member — or one whose temporary
      // access had expired — was assignable. The condition then looks owned
      // and is not, which is worse than unassigned: an unassigned condition
      // is visibly waiting, and one assigned to a departed colleague is
      // invisibly stuck.
      //
      // The check now runs the SAME resolver that powers the picker, so the
      // set the operator is shown and the set the server accepts cannot
      // drift. Cross-workspace assignment is refused by construction: the
      // resolver is scoped to `teamId`.
      if (body.assigneeUserId !== null) {
        const eligible = await isAssignableOperator({
          teamId: body.teamId,
          userId: body.assigneeUserId,
        });
        if (!eligible) {
          return reply.code(400).send({
            error: "invalid_assignee",
            message:
              "Assignee must be an active member of this workspace who can act on operational work.",
          });
        }
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
  //   - mutating routes go through requireOpsCapability + audit log
  // ---------------------------------------------------------------------------

  const ParamsWorkflowId = z.object({ id: z.string().uuid() });
  // PHASE 12 — VERTICAL B. Every workflow mutation body now carries two
  // optional control fields on top of the workspace claim:
  //   * expectedVersion  — the `updatedAtUtc` the operator's board was
  //                        rendered from. A mismatch is a 409 with ZERO
  //                        mutation (stale board).
  //   * idempotencyKey   — durable dedup token. A retry with the same
  //                        key replays instead of re-applying.
  const TeamIdOnlyWorkflow = z.object({
    teamId: z.string().uuid(),
    expectedVersion: z.string().min(1).max(64).optional(),
    idempotencyKey: z.string().min(8).max(120).optional(),
  });
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

  // ---------------------------------------------------------------------------
  // PHASE 12 — VERTICAL B. Shared workflow-mutation composer.
  //
  // Every lifecycle route funnels through this one function AFTER its own
  // `requireOpsCapability` gate, so the composition order is identical
  // for all eight actions:
  //
  //   persisted-record workspace binding (done by the caller)
  //     → capability gate (done by the caller)
  //     → state-machine precondition
  //     → expectedVersion / stale-state rejection
  //     → durable idempotency replay
  //     → target-bound step-up for sensitive actions
  //     → ONE state writer (workflow.service.ts)
  //     → idempotency marker + server projection refresh
  //
  // Nothing succeeds before the state writer confirms. The response is
  // ALWAYS the freshly-read server projection, never an echo of the
  // request.
  // ---------------------------------------------------------------------------
  async function runWorkflowAction(input: {
    req: FastifyRequest;
    reply: FastifyReply;
    bound: BoundWorkflow;
    actorUserId: string;
    action: WorkflowActionKey;
    expectedVersion?: string;
    idempotencyKey?: string;
    apply: () => Promise<prismaPkg.OperationalWorkflow>;
  }) {
    const { req, reply, bound, action } = input;
    const teamId = bound.teamId;

    // 1. State-machine precondition. Rejecting here keeps the operator's
    //    board honest instead of letting the writer silently no-op.
    const stateReason = stateReasonFor(action, bound.workflow.status);
    if (stateReason) {
      return reply.code(409).send({
        error: {
          code: "invalid_transition",
          reason: stateReason,
          currentStatus: bound.workflow.status,
        },
      });
    }

    // 2. Optimistic concurrency.
    const version = assertWorkflowVersion(bound.workflow, input.expectedVersion);
    if (!version.ok) {
      return reply.code(409).send({
        error: {
          code: "stale_workflow_state",
          currentVersion: version.currentVersion,
          currentStatus: version.currentStatus,
        },
      });
    }

    const canAct = await resolveWorkflowActionCapability({
      teamId,
      userId: input.actorUserId,
    });

    // 3. Durable idempotency replay — returns the CURRENT server state
    //    without re-applying.
    if (input.idempotencyKey) {
      const replay = await findWorkflowActionReplay({
        workflowId: bound.workflow.id,
        teamId,
        action,
        idempotencyKey: input.idempotencyKey,
      });
      if (replay) {
        const current =
          (await prisma.operationalWorkflow.findFirst({
            where: { id: bound.workflow.id, teamId },
          })) ?? bound.workflow;
        return reply.code(200).send({
          workflow: projectWorkflowForPublic(current, canAct),
          applied: false,
          idempotentReplay: true,
          replayedAtUtc: replay.recordedAtUtc,
        });
      }
    }

    // 4. Target-bound step-up for the sensitive closures.
    if (WORKFLOW_ACTIONS_REQUIRING_STEP_UP.has(action)) {
      const stepUp = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId,
        userId: input.actorUserId,
        purpose: "REVIEWER_OPS_ESCALATION_RESOLVE",
        resourceKind: "operational_workflow",
        resourceId: bound.workflow.id,
      });
      if (stepUp.sent) return;
    }

    // 5. ONE state writer.
    let updated: prismaPkg.OperationalWorkflow;
    try {
      updated = await input.apply();
    } catch (err) {
      if (handleWorkflowError(reply, err)) return;
      throw err;
    }

    // 6. Durable provenance for the idempotency key.
    if (input.idempotencyKey) {
      await recordWorkflowActionIdempotency({
        workflowId: updated.id,
        teamId,
        action,
        idempotencyKey: input.idempotencyKey,
        actorUserId: input.actorUserId,
        resultingStatus: updated.status,
      });
    }

    return reply.code(200).send({
      workflow: projectWorkflowForPublic(updated, canAct),
      applied: true,
      idempotentReplay: false,
    });
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
      // PHASE 12 — VERTICAL B. Action availability is resolved SERVER-side
      // once per request and stamped onto every row. The browser renders
      // this projection; it never derives availability from a role string.
      const canAct = await resolveWorkflowActionCapability({
        teamId: q.teamId,
        userId: actor.userId,
      });
      return reply.code(200).send({
        workflows: rows.map((r) => projectWorkflowForPublic(r, canAct)),
        canAct,
        denialReason: canAct ? null : "CAPABILITY_REQUIRED",
      });
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
      const canAct = await resolveWorkflowActionCapability({
        teamId: q.teamId,
        userId: actor.userId,
      });
      // Bounded operator history for the detail drawer. Never projects
      // `metadataJson` (it carries generator + idempotency internals).
      const history = await prisma.operationalWorkflowEvent
        .findMany({
          where: { workflowId: row.id, teamId: q.teamId },
          orderBy: { occurredAtUtc: "desc" },
          take: 50,
          select: {
            id: true,
            eventType: true,
            actorUserId: true,
            fromStatus: true,
            toStatus: true,
            summary: true,
            occurredAtUtc: true,
          },
        })
        .catch(() => []);
      return reply.code(200).send({
        workflow: projectWorkflowForPublic(row, canAct),
        canAct,
        denialReason: canAct ? null : "CAPABILITY_REQUIRED",
        history: history.map((h) => ({
          id: h.id,
          eventType: h.eventType,
          actorUserId: h.actorUserId,
          fromStatus: h.fromStatus,
          toStatus: h.toStatus,
          summary: h.summary,
          occurredAtUtc: h.occurredAtUtc.toISOString(),
        })),
      });
    },
  );

  app.post(
    "/v1/ops/workflows/:id/assign",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsWorkflowId.parse(req.params);
      const body = AssignWorkflowBody.parse(req.body ?? {});
      // PHASE 12 — VERTICAL B. The workspace is derived from the
      // PERSISTED workflow row. A client-declared teamId that does not
      // own the row resolves to the same 404 a non-existent workflow
      // resolves to (anti-enumeration), so `body.teamId` below is proven
      // equal to the persisted `workflow.teamId` before it gates anything.
      const bound = await bindWorkflowWorkspace({
        workflowId: id,
        declaredTeamId: body.teamId,
      });
      if (!bound) {
        return reply.code(404).send({ error: { code: "workflow_not_found" } });
      }
      const actor = await requireOpsCapability(req, reply, body.teamId, "operations.assign");
      if (!actor) return;
      const member = await prisma.teamMember.findFirst({
        where: { teamId: bound.teamId, userId: body.assigneeUserId },
        select: { id: true },
      });
      if (!member) {
        return reply.code(400).send({
          error: "invalid_assignee",
          message: "Assignee must be a member of this workspace.",
        });
      }
      return runWorkflowAction({
        req,
        reply,
        bound,
        actorUserId: actor.userId,
        action: "assign",
        expectedVersion: body.expectedVersion,
        idempotencyKey: body.idempotencyKey,
        apply: async () => {
          const { assignWorkflow } = await import(
            "../services/observability/workflow.service.js"
          );
          return assignWorkflow({
            workflowId: id,
            teamId: bound.teamId,
            assigneeUserId: body.assigneeUserId,
            actorUserId: actor.userId,
            ipAddress: requestIp(req),
            userAgent: requestUa(req),
          });
        },
      });
    },
  );

  app.post(
    "/v1/ops/workflows/:id/start",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsWorkflowId.parse(req.params);
      const body = TeamIdOnlyWorkflow.parse(req.body ?? {});
      const bound = await bindWorkflowWorkspace({
        workflowId: id,
        declaredTeamId: body.teamId,
      });
      if (!bound) {
        return reply.code(404).send({ error: { code: "workflow_not_found" } });
      }
      const actor = await requireOpsCapability(req, reply, body.teamId, "operations.acknowledge");
      if (!actor) return;
      return runWorkflowAction({
        req,
        reply,
        bound,
        actorUserId: actor.userId,
        action: "start",
        expectedVersion: body.expectedVersion,
        idempotencyKey: body.idempotencyKey,
        apply: async () => {
          const { startWorkflow } = await import(
            "../services/observability/workflow.service.js"
          );
          return startWorkflow({
            workflowId: id,
            teamId: bound.teamId,
            actorUserId: actor.userId,
            ipAddress: requestIp(req),
            userAgent: requestUa(req),
          });
        },
      });
    },
  );

  app.post(
    "/v1/ops/workflows/:id/escalate",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsWorkflowId.parse(req.params);
      const body = TeamIdOnlyWorkflow.parse(req.body ?? {});
      const bound = await bindWorkflowWorkspace({
        workflowId: id,
        declaredTeamId: body.teamId,
      });
      if (!bound) {
        return reply.code(404).send({ error: { code: "workflow_not_found" } });
      }
      const actor = await requireOpsCapability(req, reply, body.teamId, "operations.assign");
      if (!actor) return;
      return runWorkflowAction({
        req,
        reply,
        bound,
        actorUserId: actor.userId,
        action: "escalate",
        expectedVersion: body.expectedVersion,
        idempotencyKey: body.idempotencyKey,
        apply: async () => {
          const { escalateWorkflow } = await import(
            "../services/observability/workflow.service.js"
          );
          return escalateWorkflow({
            workflowId: id,
            teamId: bound.teamId,
            actorUserId: actor.userId,
            ipAddress: requestIp(req),
            userAgent: requestUa(req),
          });
        },
      });
    },
  );

  app.post(
    "/v1/ops/workflows/:id/mitigation",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsWorkflowId.parse(req.params);
      const body = MitigationBody.parse(req.body ?? {});
      const bound = await bindWorkflowWorkspace({
        workflowId: id,
        declaredTeamId: body.teamId,
      });
      if (!bound) {
        return reply.code(404).send({ error: { code: "workflow_not_found" } });
      }
      const actor = await requireOpsCapability(req, reply, body.teamId, "operations.acknowledge");
      if (!actor) return;
      return runWorkflowAction({
        req,
        reply,
        bound,
        actorUserId: actor.userId,
        action: "mitigation",
        expectedVersion: body.expectedVersion,
        idempotencyKey: body.idempotencyKey,
        apply: async () => {
          const { addMitigation } = await import(
            "../services/observability/workflow.service.js"
          );
          return addMitigation({
            workflowId: id,
            teamId: bound.teamId,
            note: body.note,
            actorUserId: actor.userId,
            ipAddress: requestIp(req),
            userAgent: requestUa(req),
          });
        },
      });
    },
  );

  app.post(
    "/v1/ops/workflows/:id/resolve",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsWorkflowId.parse(req.params);
      const body = ResolveWorkflowBody.parse(req.body ?? {});
      const bound = await bindWorkflowWorkspace({
        workflowId: id,
        declaredTeamId: body.teamId,
      });
      if (!bound) {
        return reply.code(404).send({ error: { code: "workflow_not_found" } });
      }
      const actor = await requireOpsCapability(req, reply, body.teamId, "operations.resolve");
      if (!actor) return;
      return runWorkflowAction({
        req,
        reply,
        bound,
        actorUserId: actor.userId,
        action: "resolve",
        expectedVersion: body.expectedVersion,
        idempotencyKey: body.idempotencyKey,
        apply: async () => {
          const { resolveWorkflow } = await import(
            "../services/observability/workflow.service.js"
          );
          return resolveWorkflow({
            workflowId: id,
            teamId: bound.teamId,
            note: body.note ?? null,
            actorUserId: actor.userId,
            ipAddress: requestIp(req),
            userAgent: requestUa(req),
          });
        },
      });
    },
  );

  app.post(
    "/v1/ops/workflows/:id/suppress",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsWorkflowId.parse(req.params);
      const body = TeamIdOnlyWorkflow.parse(req.body ?? {});
      const bound = await bindWorkflowWorkspace({
        workflowId: id,
        declaredTeamId: body.teamId,
      });
      if (!bound) {
        return reply.code(404).send({ error: { code: "workflow_not_found" } });
      }
      const actor = await requireOpsCapability(req, reply, body.teamId, "operations.suppress");
      if (!actor) return;
      return runWorkflowAction({
        req,
        reply,
        bound,
        actorUserId: actor.userId,
        action: "suppress",
        expectedVersion: body.expectedVersion,
        idempotencyKey: body.idempotencyKey,
        apply: async () => {
          const { suppressWorkflow } = await import(
            "../services/observability/workflow.service.js"
          );
          return suppressWorkflow({
            workflowId: id,
            teamId: bound.teamId,
            actorUserId: actor.userId,
            ipAddress: requestIp(req),
            userAgent: requestUa(req),
          });
        },
      });
    },
  );

  app.post(
    "/v1/ops/workflows/:id/reopen",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsWorkflowId.parse(req.params);
      const body = TeamIdOnlyWorkflow.parse(req.body ?? {});
      const bound = await bindWorkflowWorkspace({
        workflowId: id,
        declaredTeamId: body.teamId,
      });
      if (!bound) {
        return reply.code(404).send({ error: { code: "workflow_not_found" } });
      }
      const actor = await requireOpsCapability(req, reply, body.teamId, "operations.resolve");
      if (!actor) return;
      return runWorkflowAction({
        req,
        reply,
        bound,
        actorUserId: actor.userId,
        action: "reopen",
        expectedVersion: body.expectedVersion,
        idempotencyKey: body.idempotencyKey,
        apply: async () => {
          const { reopenWorkflow } = await import(
            "../services/observability/workflow.service.js"
          );
          return reopenWorkflow({
            workflowId: id,
            teamId: bound.teamId,
            actorUserId: actor.userId,
            ipAddress: requestIp(req),
            userAgent: requestUa(req),
          });
        },
      });
    },
  );

  app.post(
    "/v1/ops/workflows/:id/schedule-retry",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsWorkflowId.parse(req.params);
      const body = ScheduleRetryBody.parse(req.body ?? {});
      const bound = await bindWorkflowWorkspace({
        workflowId: id,
        declaredTeamId: body.teamId,
      });
      if (!bound) {
        return reply.code(404).send({ error: { code: "workflow_not_found" } });
      }
      const actor = await requireOpsCapability(req, reply, body.teamId, "operations.acknowledge");
      if (!actor) return;
      return runWorkflowAction({
        req,
        reply,
        bound,
        actorUserId: actor.userId,
        action: "schedule-retry",
        expectedVersion: body.expectedVersion,
        idempotencyKey: body.idempotencyKey,
        apply: async () => {
          const { scheduleRetry } = await import(
            "../services/observability/workflow.service.js"
          );
          return scheduleRetry({
            workflowId: id,
            teamId: bound.teamId,
            nextRetryAtUtc: new Date(body.nextRetryAtUtc),
            actorUserId: actor.userId,
            ipAddress: requestIp(req),
            userAgent: requestUa(req),
          });
        },
      });
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
      // PHASE 12 — VERTICAL B. Resolve the linked workflows SERVER-side
      // so the Command Center can render "why is this happening" with
      // real titles instead of raw UUID lists. Team-anchored; bounded to
      // 25 rows; never projects generator metadata.
      const linkedWorkflowIds = Array.isArray(chain.linkedWorkflowIds)
        ? (chain.linkedWorkflowIds as string[]).slice(0, 25)
        : [];
      const linkedWorkflows =
        linkedWorkflowIds.length > 0
          ? await prisma.operationalWorkflow
              .findMany({
                where: { id: { in: linkedWorkflowIds }, teamId: q.teamId },
                select: {
                  id: true,
                  title: true,
                  status: true,
                  severity: true,
                  workflowType: true,
                },
                take: 25,
              })
              .catch(() => [])
          : [];
      return reply.code(200).send({
        chain: {
          id: chain.id,
          chainKey: chain.chainKey,
          title: chain.title,
          summary: chain.summary,
          rootCauseType: chain.rootCauseType,
          severity: chain.severity,
          status: chain.status,
          linkedIncidentIds: Array.isArray(chain.linkedIncidentIds)
            ? (chain.linkedIncidentIds as string[]).slice(0, 50)
            : [],
          linkedWorkflowIds,
          linkedCaseIds: Array.isArray(chain.linkedCaseIds)
            ? (chain.linkedCaseIds as string[]).slice(0, 50)
            : [],
          linkedEvidenceIds: Array.isArray(chain.linkedEvidenceIds)
            ? (chain.linkedEvidenceIds as string[]).slice(0, 50)
            : [],
          startAtUtc: chain.startAtUtc.toISOString(),
          lastSeenAtUtc: chain.lastSeenAtUtc.toISOString(),
          resolvedAtUtc: chain.resolvedAtUtc?.toISOString() ?? null,
        },
        linkedWorkflows,
      });
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

  /**
   * ATTACH SLA POSTURE TO A PROJECTED CONDITION.
   *
   * ONE place, used by the list and the detail alike, so the queue and the
   * drawer can never disagree about whether something is late.
   *
   * The posture is read from the PERSISTED cycle, never recomputed from the
   * workspace's current policy. A condition with no cycle is reported as
   * UNTRACKED_LEGACY rather than measured against today's numbers — which is
   * the closure this route exists to carry: the previous derivation was
   * measured to flip an open condition from ON_TRACK to BREACHED when a
   * workspace tightened its policy, and to erase a real breach when it
   * loosened one.
   */
  function withSla<
    T extends { id: string; status: string },
  >(
    projected: T,
    cycles: Map<string, prismaPkg.OperationalIncidentSlaCycle>,
    now: Date,
  ): T & { sla: ReturnType<typeof projectIncidentSla> } {
    return {
      ...projected,
      sla: projectIncidentSla(
        projected.status,
        cycles.get(projected.id) ?? null,
        now,
      ),
    };
  }


  // ---------------------------------------------------------------------------
  // SAVED VIEWS
  //
  //   GET    /v1/ops/saved-views      the reader's own, plus the workspace's
  //   POST   /v1/ops/saved-views      save the current filters under a name
  //   DELETE /v1/ops/saved-views/:id  remove one the reader owns
  //
  // Gated on OPERATIONS_VIEW and nothing more. A saved view GRANTS nothing:
  // opening one issues the ordinary queue read under the reader's own
  // authority, so a view shared by an administrator shows a viewer exactly
  // what that viewer could already have filtered to by hand. Requiring a
  // mutation capability to save one would be gating a bookmark behind the
  // permission to change things.
  // ---------------------------------------------------------------------------

  /**
   * MAY THIS CALLER MANAGE SHARED VIEWS HERE?
   *
   * Resolved through the SAME canonical authority every other Operations
   * permission uses, so there is one place that decides and no route-local
   * role string, plan name or workspace label anywhere near this question.
   * Fails CLOSED: an authority that cannot be resolved is not a grant.
   */
  async function canManageSharedViews(
    teamId: string,
    userId: string,
  ): Promise<boolean> {
    return evaluateMemberAccess({
      teamId,
      userId,
      permission: "operations.saved_views.manage" as never,
    })
      .then((d) => d.allowed === true)
      .catch(() => false);
  }

  /**
   * The canonical tenant audit record for a shared-view mutation.
   *
   * Only TEAM views are audited here. A PRIVATE view is one person's own
   * bookmark and auditing every rename of one would bury the shared-state
   * changes an access review is actually looking for — existing product
   * policy, deliberately not widened.
   *
   * `adminOverride` and `creatorUserId` are both recorded: an administrator
   * acting on somebody else's view does NOT become its author, and the
   * history has to say who made it and who changed it.
   */
  async function auditSharedView(input: {
    operation: "created" | "renamed" | "updated" | "deleted";
    teamId: string;
    actorUserId: string;
    savedViewId: string;
    creatorUserId: string;
    adminOverride: boolean;
    previousVisibility?: string;
    newVisibility?: string;
    changedFields?: string[];
    req: FastifyRequest;
  }): Promise<void> {
    await emitTenantAudit({
      action: `operations.saved_view.${input.operation}`,
      outcome: "success",
      sourceApp: "API",
      actorUserId: input.actorUserId,
      workspaceId: input.teamId,
      resourceType: "operations_saved_view",
      resourceId: input.savedViewId,
      metadata: {
        creatorUserId: input.creatorUserId,
        adminOverride: input.adminOverride,
        previousVisibility: input.previousVisibility ?? null,
        newVisibility: input.newVisibility ?? null,
        // FIELD NAMES ONLY. The stored query can name a colleague or a case
        // an operator is chasing, and an audit row is read by more people
        // than the view is.
        changedFields: input.changedFields ?? [],
        ipAddress: requestIp(input.req) ?? null,
        userAgent: requestUa(input.req) ?? null,
      },
    }).catch(() => {
      /* an audit sink outage must not undo an authorized, completed write */
    });
  }

  app.get(
    "/v1/ops/saved-views",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const actor = await requireOpsCapability(req, reply, q.teamId, "operations.view");
      if (!actor) return;

      const views = await listOperationsSavedViews({
        teamId: q.teamId,
        userId: actor.userId,
      });
      return reply.code(200).send({ views });
    },
  );

  app.post(
    "/v1/ops/saved-views",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({
          teamId: z.string().uuid(),
          name: z.string().trim().min(1).max(120),
          description: z.string().trim().max(400).optional(),
          visibility: z.enum(["PRIVATE", "TEAM"]),
          pinned: z.boolean().optional(),
          // Validated against the SAME strict schema the queue's own
          // parameters define, so a view cannot express a filter the queue
          // could not apply — which would silently do something else when
          // the view was replayed.
          filter: OperationsSavedViewFilterSchema,
        })
        .parse(req.body ?? {});

      const actor = await requireOpsCapability(
        req,
        reply,
        body.teamId,
        "operations.view",
      );
      if (!actor) return;

      const created = await createOperationsSavedView({
        teamId: body.teamId,
        actorUserId: actor.userId,
        name: body.name,
        description: body.description ?? null,
        visibility: body.visibility,
        pinned: body.pinned ?? false,
        filter: body.filter,
        canManageShared: await canManageSharedViews(body.teamId, actor.userId),
      });

      if (!created.ok) {
        // Distinguishable answers: saving over your own view is not the same
        // problem as a workspace mismatch or a missing authority, and only
        // one of them the operator can fix by choosing another name.
        const status =
          created.reason === "duplicate_name"
            ? 409
            : created.reason === "not_permitted"
              ? 403
              : 400;
        return reply.code(status).send({ error: { code: created.reason } });
      }
      if (created.view.visibility === "TEAM") {
        await auditSharedView({
          operation: "created",
          teamId: body.teamId,
          actorUserId: actor.userId,
          savedViewId: created.view.id,
          creatorUserId: actor.userId,
          adminOverride: false,
          newVisibility: "TEAM",
          req,
        });
      }
      return reply.code(201).send({ view: created.view });
    },
  );

  /**
   * PATCH /v1/ops/saved-views/:id
   *
   * Rename, re-scope or re-filter a view the caller owns.
   *
   * `expectedUpdatedAt` is REQUIRED. Without it two operators editing one
   * shared view produce a silent lost update: both saves succeed and the
   * first person's change is gone with no error anywhere. A stale token
   * answers 409 so the caller can re-read and decide, which is the only
   * outcome that does not quietly destroy somebody's work.
   */
  app.patch(
    "/v1/ops/saved-views/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsIncidentId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          expectedUpdatedAt: z.string().datetime(),
          name: z.string().trim().min(1).max(120).optional(),
          description: z.string().trim().max(400).nullable().optional(),
          visibility: z.enum(["PRIVATE", "TEAM"]).optional(),
          filter: OperationsSavedViewFilterSchema.optional(),
        })
        .parse(req.body ?? {});

      const actor = await requireOpsCapability(
        req,
        reply,
        body.teamId,
        "operations.view",
      );
      if (!actor) return;

      const updated = await updateOperationsSavedView({
        teamId: body.teamId,
        actorUserId: actor.userId,
        id,
        expectedUpdatedAt: body.expectedUpdatedAt,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined
          ? { description: body.description }
          : {}),
        ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
        ...(body.filter !== undefined ? { filter: body.filter } : {}),
        canManageShared: await canManageSharedViews(body.teamId, actor.userId),
      });

      if (!updated.ok) {
        const status =
          updated.reason === "not_found"
            ? 404
            : updated.reason === "not_permitted"
              ? 403
              : updated.reason === "conflict" || updated.reason === "duplicate_name"
                ? 409
                : 400;
        return reply.code(status).send({ error: { code: updated.reason } });
      }

      // Audited when the view IS or WAS shared: converting one out of TEAM is
      // as much a change to shared state as changing one inside it.
      if (
        updated.view.visibility === "TEAM" ||
        updated.previousVisibility === "TEAM"
      ) {
        await auditSharedView({
          operation: body.name !== undefined ? "renamed" : "updated",
          teamId: body.teamId,
          actorUserId: actor.userId,
          savedViewId: updated.view.id,
          creatorUserId: updated.creatorUserId,
          adminOverride: updated.adminOverride,
          previousVisibility: updated.previousVisibility,
          newVisibility: updated.view.visibility,
          changedFields: [
            ...(body.name !== undefined ? ["name"] : []),
            ...(body.description !== undefined ? ["description"] : []),
            ...(body.visibility !== undefined ? ["visibility"] : []),
            ...(body.filter !== undefined ? ["filter"] : []),
          ],
          req,
        });
      }
      return reply.code(200).send({ view: updated.view });
    },
  );

  app.delete(
    "/v1/ops/saved-views/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsIncidentId.parse(req.params);
      const q = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const actor = await requireOpsCapability(req, reply, q.teamId, "operations.view");
      if (!actor) return;

      const removed = await deleteOperationsSavedView({
        teamId: q.teamId,
        actorUserId: actor.userId,
        id,
        canManageShared: await canManageSharedViews(q.teamId, actor.userId),
      });

      if (!removed.ok) {
        // 404 for a PRIVATE view that is not the caller's, or an id that is
        // not in this workspace: confirming existence is already more than a
        // caller who cannot act on it should learn.
        //
        // 403 for a TEAM view they can SEE but may not manage — its
        // existence is not a secret, so the honest answer is the authority.
        return removed.reason === "not_permitted"
          ? reply.code(403).send({ error: { code: "not_permitted" } })
          : reply.code(404).send({ error: { code: "saved_view_not_found" } });
      }

      if (removed.visibility === "TEAM") {
        await auditSharedView({
          operation: "deleted",
          teamId: q.teamId,
          actorUserId: actor.userId,
          savedViewId: id,
          creatorUserId: removed.creatorUserId,
          adminOverride: removed.adminOverride,
          previousVisibility: "TEAM",
          req,
        });
      }
      return reply.code(204).send();
    },
  );


  const BulkActionBody = z.object({
    teamId: z.string().uuid(),
    actionType: z.enum([
      "BULK_ASSIGN_WORKFLOWS",
      "BULK_ESCALATE_WORKFLOWS",
      "BULK_SUPPRESS_INCIDENTS",
      "BULK_RESOLVE_WORKFLOWS",
      "BULK_SCHEDULE_RETRY",
      "BULK_ACKNOWLEDGE_INCIDENTS",
      "BULK_ASSIGN_INCIDENTS",
      "BULK_ADD_MITIGATION",
      "BULK_DISMISS_RECOMMENDATIONS",
    ]),
    targetIds: z.array(z.string().uuid()).min(1).max(200),
    note: z.string().min(1).max(400).optional(),
    assigneeUserId: z.string().uuid().optional(),
    nextRetryAtUtc: z.string().datetime().optional(),
    // PHASE 12 — VERTICAL B. Durable dedup token. A retry with the same
    // key returns the ORIGINAL run instead of fanning out a second time.
    idempotencyKey: z.string().min(8).max(120).optional(),
  });

  /**
   * PHASE 4B — bulk action type -> the permission its single-item equivalent
   * requires. TOTAL over the `actionType` enum above; TypeScript will not
   * compile a new action type into that enum without an entry here, which is
   * the point: an unmapped bulk action is an unauthorized one.
   */
  const BULK_ACTION_PERMISSION: Record<
    z.infer<typeof BulkActionBody>["actionType"],
    | "operations.acknowledge"
    | "operations.assign"
    | "operations.resolve"
    | "operations.suppress"
  > = {
    BULK_ASSIGN_WORKFLOWS: "operations.assign",
    BULK_ESCALATE_WORKFLOWS: "operations.assign",
    BULK_SUPPRESS_INCIDENTS: "operations.suppress",
    BULK_RESOLVE_WORKFLOWS: "operations.resolve",
    BULK_SCHEDULE_RETRY: "operations.acknowledge",
    BULK_ACKNOWLEDGE_INCIDENTS: "operations.acknowledge",
    // The SAME permission one row's assignment requires. A bulk sweep is a
    // fan-out, never a larger authority than its single-item equivalent.
    BULK_ASSIGN_INCIDENTS: "operations.assign",
    BULK_ADD_MITIGATION: "operations.acknowledge",
    BULK_DISMISS_RECOMMENDATIONS: "operations.acknowledge",
  };

  /**
   * PHASE 12 — VERTICAL B. Bounded per-item projection so the operator
   * sees exactly which target succeeded, was skipped, or failed — never
   * one global "bulk action failed" banner.
   */
  function projectBulkItem(item: prismaPkg.BulkOperationalActionItem) {
    return {
      id: item.id,
      targetType: item.targetType,
      targetId: item.targetId,
      status: item.status,
      errorCode: item.errorCode,
      completedAtUtc: item.completedAtUtc?.toISOString() ?? null,
    };
  }

  app.post(
    "/v1/ops/bulk-actions",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = BulkActionBody.parse(req.body ?? {});
      // PHASE 4B / D29 — the bulk gate is the SAME gate as the single-item
      // action it fans out into.
      //
      // A blanket "may run bulk actions" permission would be a hole through
      // every one of them: an operator authorized to acknowledge could
      // suppress 200 conditions at once by routing through this endpoint.
      // The action type therefore selects its own permission, from the same
      // table the single-item routes use.
      const actor = await requireOpsCapability(
        req,
        reply,
        body.teamId,
        BULK_ACTION_PERMISSION[body.actionType],
      );
      if (!actor) return;

      // 1. Durable idempotency replay — the marker is persisted on the
      //    run row's resultJson, so a retry after a dropped connection
      //    reads back the original outcome instead of re-fanning out.
      if (body.idempotencyKey) {
        const prior = await prisma.bulkOperationalActionRun
          .findFirst({
            where: {
              teamId: body.teamId,
              actionType: body.actionType,
              resultJson: {
                path: ["opsIdempotencyKey"],
                equals: body.idempotencyKey,
              },
            },
            orderBy: { createdAt: "desc" },
          })
          .catch(() => null);
        if (prior) {
          const priorItems = await prisma.bulkOperationalActionItem
            .findMany({
              where: { runId: prior.id },
              orderBy: { createdAt: "asc" },
              take: 500,
            })
            .catch(() => []);
          return reply.code(200).send({
            run: {
              runId: prior.id,
              status: prior.status,
              ...(prior.resultJson as Record<string, unknown> | null),
            },
            items: priorItems.map(projectBulkItem),
            idempotentReplay: true,
          });
        }
      }

      // 1b. Assignee eligibility, checked ONCE before the fan-out.
      //
      //     The SAME resolver the single-item route and the operator picker
      //     use, so the set shown, the set one row accepts and the set a
      //     sweep accepts cannot drift. Cross-workspace assignment is
      //     refused by construction — the resolver is scoped to `teamId`.
      //
      //     Checked BEFORE the run is created rather than per item, because
      //     an ineligible assignee fails identically for all 200 targets:
      //     fanning out to record 200 copies of one answer would leave the
      //     operator reading a per-item failure list to learn a single fact.
      if (body.actionType === "BULK_ASSIGN_INCIDENTS") {
        // A bulk assign with no assignee is refused rather than read as an
        // unassign. Bulk-unassigning 200 conditions is a deliberate act, and
        // a missing field is not a plausible way to express it.
        if (body.assigneeUserId === undefined) {
          return reply.code(400).send({
            error: "assignee_required",
            message: "Choose who should own these conditions.",
          });
        }
        const eligible = await isAssignableOperator({
          teamId: body.teamId,
          userId: body.assigneeUserId,
        });
        if (!eligible) {
          return reply.code(400).send({
            error: "invalid_assignee",
            message:
              "Assignee must be an active member of this workspace who can act on operational work.",
          });
        }
      }

      // 2. Target-bound step-up. A bulk fan-out mutates many operator
      //    records at once, so the actor re-proves before the runner
      //    touches anything.
      const stepUp = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId: actor.userId,
        purpose: "REVIEWER_OPS_BULK_ACTION",
        resourceKind: "workspace",
        resourceId: body.teamId,
      });
      if (stepUp.sent) return;

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

      // 3. Stamp the idempotency marker onto the persisted run.
      if (body.idempotencyKey) {
        await prisma.bulkOperationalActionRun
          .update({
            where: { id: result.runId },
            data: {
              resultJson: {
                total: result.total,
                succeeded: result.succeeded,
                failed: result.failed,
                skipped: result.skipped,
                opsIdempotencyKey: body.idempotencyKey,
              },
            },
          })
          .catch(() => undefined);
      }

      // 4. Per-item outcome so the UI can render which rows moved.
      const items = await prisma.bulkOperationalActionItem
        .findMany({
          where: { runId: result.runId },
          orderBy: { createdAt: "asc" },
          take: 500,
        })
        .catch(() => []);
      return reply.code(200).send({
        run: result,
        items: items.map(projectBulkItem),
        idempotentReplay: false,
      });
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
      // Bounded projection — `targetIdsJson` is echoed back but the
      // internal idempotency marker is stripped from resultJson.
      const resultJson = (run.resultJson ?? null) as Record<
        string,
        unknown
      > | null;
      const safeResult = resultJson
        ? Object.fromEntries(
            Object.entries(resultJson).filter(
              ([k]) => k !== "opsIdempotencyKey",
            ),
          )
        : null;
      return reply.code(200).send({
        run: {
          id: run.id,
          teamId: run.teamId,
          actionType: run.actionType,
          status: run.status,
          requestedByUserId: run.requestedByUserId,
          noteText: run.noteText,
          result: safeResult,
          createdAtUtc: run.createdAt.toISOString(),
          completedAtUtc: run.completedAtUtc?.toISOString() ?? null,
        },
        items: items.map(projectBulkItem),
      });
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
      const actor = await requireDomainActionOnOpsSurface(req, reply, body.teamId, "intelligence.run");
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

  // ---------------------------------------------------------------------------
  // PHASE 13 §4 (2026-08-17) — operator dismissal of a media-intelligence run.
  //
  // `DISMISSED` has been a member of the run status vocabulary, and
  // `dismissRun` its only writer, with nothing able to call it. Two shipped
  // surfaces already assumed otherwise: the media-graph ops console renders a
  // "Run dismissed (operator)" counter tile over
  // `media_intelligence_run_dismissed_total`, which no code path could ever
  // increment, and the media-intelligence processor's own comment tells
  // operations that a run left PENDING by an unshipped processor arm can be
  // "dismissed manually". This is the route that makes both true.
  //
  // NOTE ON THE IDENTIFIER, which differs from its sibling above: the retry
  // route's `:runId` is a BullMQ JOB id (`mi-<kind>-<evidenceId>`), because it
  // acts on the queue. This one acts on the `media_intelligence_runs` ROW, so it
  // takes that row's UUID. Same segment name, different namespace — hence the
  // separate, stricter schema rather than reuse of `RetryRunParams`.
  //
  // `dismissRun` is idempotent and tenant-scoped in its own WHERE clause
  // (`id = ? AND team_id = ? AND status IN ('PENDING','FAILED','PROCESSING')`),
  // so a terminal run is untouched and a run belonging to another workspace
  // matches nothing even before the authorization below is considered.
  // ---------------------------------------------------------------------------
  const DismissRunParams = z.object({ runId: z.string().uuid() });
  const DismissRunBody = z
    .object({ teamId: z.string().uuid(), reason: z.string().max(200).optional() })
    .strict();

  app.post(
    "/v1/ops/media-intelligence/runs/:runId/dismiss",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { runId } = DismissRunParams.parse(req.params);
      const body = DismissRunBody.parse(req.body ?? {});
      const actor = await requireDomainActionOnOpsSurface(req, reply, body.teamId, "intelligence.run");
      if (!actor) return;
      const { dismissRun } = await import(
        "@proovra/shared-runtime/media-intelligence"
      );
      const result = await dismissRun(runId, body.teamId);
      if (!result.ok) {
        // The run is absent, belongs to another workspace, or is already
        // terminal. All three are reported as one code: distinguishing them
        // would tell a caller whether a run id exists in a workspace they may
        // not be entitled to enumerate.
        return reply
          .code(409)
          .send({ error: { code: "run_not_dismissable" } });
      }
      return reply.code(200).send({ runId, dismissed: true });
    },
  );

  app.post(
    "/v1/ops/media-intelligence/dlq/replay",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = ReplayDlqBody.parse(req.body ?? {});
      const actor = await requireDomainActionOnOpsSurface(req, reply, body.teamId, "intelligence.run");
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
 * PHASE 4B / D29 (2026-08-22) — `requireOpsActorAction` IS GONE.
 *
 * It was the "stricter variant of requireOpsActor for incident mutations",
 * and what made it stricter was `identity.access_review.action` — the
 * permission that decides whether a person keeps their access to a workspace.
 * Sixteen generic Operations mutations were gated on it: acknowledge, resolve,
 * suppress, assign, escalate, bulk actions, media-intelligence retry.
 *
 * That is over-granting and mislabelling in one move. Anyone allowed to
 * acknowledge a failed report was thereby allowed to adjudicate access
 * reviews, and nothing in the codebase answered "who may run Operations in
 * this workspace?" — the answer lived in an identity permission nobody would
 * think to look at.
 *
 * Every call site now uses `requireOpsCapability` with the permission that
 * describes the action, and the three media-intelligence routes use the
 * INTELLIGENCE domain's own permission, because re-running a job is the
 * domain's decision and not a generic operational one.
 */
