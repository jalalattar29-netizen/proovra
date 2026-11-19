/**
 * Enterprise Routes
 * API endpoints for API keys, batch analysis, team management, and webhooks
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { requireAuth } from "../middleware/auth.js";
import { evaluateCurrentWorkspace } from "../middleware/authorize.js";
import { getAuthUserId } from "../auth.js";
import { requireLegalAcceptance } from "../middleware/require-legal-acceptance.js";
import { workspaceEvidenceWhere } from "@proovra/shared-runtime";
import { prisma } from "../db.js";
import { getEmailAppBaseUrl } from "../services/email.service.js";
import { resolveWorkspaceSeatState } from "../services/billing/workspace-seats.service.js";
import {
  evaluateWorkspaceAiOperation,
  getWorkspaceAiUsageThisMonth,
  workspaceIncludesProfessionalSurfaces,
} from "../services/billing-enforcement.service.js";
import { resolveEvidenceRecordAccess } from "../services/evidence/evidence-record-access.service.js";
import { resolveEntitlement } from "../services/packaging/entitlement.service.js";
import { AppError, ErrorCode } from "../errors.js";
// A-3 closure — legacy in-memory `apiKeyService` import retired.
// The Phase 17 `ApiCredential` model + `/v1/integrations/api-keys`
// (team-scoped, durable, audit-backed) is the single source of truth.
// The five `/v1/api-keys*` handlers below now return HTTP 410 Gone
// and the quota counter reads directly from Prisma.
import { BatchStatus, batchAnalysisService } from "../services/batch-analysis.service.js";
import { getEmailService } from "../services/email.service.js";
// CR1 Phase E — legacy `getWebhookService` import removed. Its only use
// in this file was a dead try/catch that fetched the service and
// immediately void'd it (no webhook was ever fired). Canonical webhook
// delivery happens via `services/integrations/webhook-dispatcher.ts`
// triggered through the integrations subsystem.
import { emitPlatformAudit } from "../services/audit/tenant-audit.service.js";
import { writeAnalyticsEvent } from "../services/analytics-event.service.js";

async function requireAuthAndLegal(req: FastifyRequest, reply: FastifyReply) {
  await requireAuth(req, reply);
  if (reply.sent) return;
  await requireLegalAcceptance(req, reply);
}

/**
 * A1-01 (Free-user audit, 2026-11-14) — Batch analysis and Quotas & usage are
 * the PROFESSIONAL surfaces: the web (SurfaceGate, `tiers.ts`) and native
 * (`professionalSurfaceVisible`) hide them unless the workspace in use
 * includes `professionalSurfacesIncluded`, and the API now answers the same
 * question for the same subject — the request's own workspace, proven by
 * `evaluateCurrentWorkspace` — through `workspaceIncludesProfessionalSurfaces`.
 * No proven workspace is not included (fail closed).
 *
 * The refusal is a stable nested `ENTITLEMENT_REQUIRED` (the code the shared
 * user-facing catalogue already words), with `details.entitlement` naming the
 * surface so a client can show "not on your plan" instead of a load failure.
 */
const PROFESSIONAL_SURFACES_REFUSAL = {
  error: {
    code: "ENTITLEMENT_REQUIRED" as const,
    message: "Batch analysis and Quotas & usage are included on Pro and above.",
    details: { entitlement: "PROFESSIONAL_SURFACES" as const },
  },
};

/**
 * A1-02 (Free-user audit, 2026-11-14) — the batch-completion email linked to
 * `/batch/<id>`, a route the web never had (404). The batch console lives at
 * `/operations/batch-analysis` (the R7.5 move from `/dashboard/batch-analysis`)
 * and lists the account's jobs, the finished one included; it takes no job
 * parameter, so the link names the console.
 */
export function batchCompletionEmailLink(appUrl: string | undefined): string {
  const base = (appUrl || "https://app.proovra.com").replace(/\/+$/, "");
  return `${base}/operations/batch-analysis`;
}

/**
 * B6-F-40 (Free-user audit 0ea0) — the workspace this request PROVED (plan and
 * role were checked on it). Every batch read and write is bound to it, so a
 * job or record in another workspace is never served or acted on under this
 * workspace's entitlement.
 */
const provenBatchWorkspace = new WeakMap<FastifyRequest, string>();

function batchWorkspaceOf(req: FastifyRequest): { teamId: string } {
  const teamId = provenBatchWorkspace.get(req);
  // Unreachable behind the guard; fail closed rather than widen to the owner.
  if (!teamId) throw new AppError(ErrorCode.FORBIDDEN, "No workspace was proven for this request");
  return { teamId };
}

function professionalGuard(permission: "evidence.read" | "evidence.update_metadata") {
  return async function requireAuthLegalAndProfessional(req: FastifyRequest, reply: FastifyReply) {
    await requireAuthAndLegal(req, reply);
    if (reply.sent) return;
    const current = await evaluateCurrentWorkspace(req, { permission });
    // PRO-NC-08 (WS-ENT) — a ROLE refusal is not a plan refusal (A2-14). A
    // VIEWER of a Pro workspace was told batch analysis is "included on Pro
    // and above". The permission branch now answers with the role refusal;
    // the plan sentence is kept for the plan branch (and for a caller with no
    // proven workspace, as before). An authorization outage stays retryable.
    if (!current.allowed && current.httpStatus === 503) {
      return reply.code(503).send({
        error: { code: "AUTHORIZATION_UNAVAILABLE", message: "Authorization could not be evaluated. Please retry." },
      });
    }
    if (!current.allowed && current.httpStatus === 403) {
      return reply.code(403).send({
        error: {
          code: "FORBIDDEN",
          message:
            permission === "evidence.update_metadata"
              ? "Your role in this workspace cannot start or change batch jobs."
              : "Your role in this workspace cannot open batch analysis or quotas.",
          details: { reason: current.reasonCode, permission },
        },
      });
    }
    if (current.allowed && (await workspaceIncludesProfessionalSurfaces(current.context.workspaceId))) {
      provenBatchWorkspace.set(req, current.context.workspaceId);
      return;
    }
    return reply.code(403).send(PROFESSIONAL_SURFACES_REFUSAL);
  };
}

/** Reads of the professional surfaces (any role). */
const requireAuthLegalAndProfessional = professionalGuard("evidence.read");
/**
 * B6-F-40 — starting work (create, process) is a write: A2-14, a VIEWER is
 * read-only, and `evidence.read` (which VIEWER holds) gated it.
 */
const requireAuthLegalProfessionalWriter = professionalGuard("evidence.update_metadata");

function getRequestPath(req: FastifyRequest): string {
  const url = req.url || "";
  const qIndex = url.indexOf("?");
  return qIndex >= 0 ? url.slice(0, qIndex) : url;
}

// PHASE 11 §3 Batch C — no Workspace/Organization is ever available here:
// `batchAnalysisService` jobs are keyed by userId only (no tenant column),
// and the legacy `/v1/api-keys*` handlers are pure retirement notices. So
// every event in this file is genuinely PLATFORM-scoped (never fabricate a
// tenant subject).
const ENTERPRISE_READ_ACTIONS: ReadonlySet<string> = new Set([
  "enterprise.batch_view",
  "enterprise.batch_list",
  "enterprise.batch_results_view",
  "enterprise.quotas_view",
  "enterprise.usage_stats_view",
]);

function auditEnterpriseAction(
  req: FastifyRequest,
  params: {
    userId: string | null;
    action: string;
    outcome?: "success" | "failure" | "blocked";
    severity?: "info" | "warning" | "critical";
    resourceType?: string | null;
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
  }
) {
  const outcome =
    params.outcome === "blocked" ? "denied" : params.outcome === "failure" ? "error" : "success";
  // PRO-G2-15 — a successful READ of one's own usage, quotas or batch results
  // is not a chain event: each row took the platform-wide audit lock on every
  // page poll. These are the caller's OWN usage, quotas and batch jobs
  // (userId-keyed, no tenant data); denials, failures, exports and writes are
  // still chained.
  if (outcome === "success" && ENTERPRISE_READ_ACTIONS.has(params.action)) return;
  void emitPlatformAudit({
    action: params.action,
    outcome,
    denialReason: outcome === "denied" ? params.action : undefined,
    sourceApp: "API",
    actorUserId: params.userId,
    resourceType: params.resourceType ?? "enterprise",
    resourceId: params.resourceId ?? null,
    correlationId: req.id,
    metadata: {
      ...(params.metadata ?? {}),
      severity: params.severity ?? "info",
    },
  }).catch(() => null);
}

function fireEnterpriseAnalyticsEvent(params: {
  eventType: string;
  userId: string;
  req: FastifyRequest;
  entityType?: string | null;
  entityId?: string | null;
  severity?: string | null;
  metadata?: Record<string, unknown>;
}) {
  void writeAnalyticsEvent({
    eventType: params.eventType,
    userId: params.userId,
    path: getRequestPath(params.req),
    entityType: params.entityType ?? "enterprise",
    entityId: params.entityId ?? null,
    severity: params.severity ?? "info",
    metadata: params.metadata ?? {},
    req: params.req,
    skipSessionUpsert: true,
  }).catch(() => null);
}


function nextMonthStart(): Date {
  const d = new Date();
  d.setMonth(d.getMonth() + 1, 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function readFloatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * B6-F-49 (Free-user audit 0ea0) — usage statistics for the workspace this
 * request PROVED, from the meters that are enforced.
 *
 * This counted the USER's analytics events and records across every workspace
 * and multiplied by an env unit price, so a page gated on one workspace showed
 * user-wide figures and an unexplained "Total Cost". `/v1/quotas` was moved to
 * the enforced meter (BILLING-010); this now follows it:
 *   - this month = the plan allowance meter the AI gate charges
 *     (`getWorkspaceAiUsageThisMonth`), today / this week = the workspace's
 *     durable AI ledger rollups;
 *   - record types, active API keys and active batches = this workspace's.
 * The cost figures remain for client compatibility, now an explicitly
 * labelled ILLUSTRATIVE list-rate estimate over those operations
 * (`costBasis`, `costIsCharged: false`): nothing is billed per analysis.
 */
async function getRealUsageStats(req: FastifyRequest, userId: string) {
  const { teamId } = batchWorkspaceOf(req);
  const now = new Date();
  const dayKey = (d: Date) => d.toISOString().slice(0, 10);
  const todayKey = dayKey(now);
  const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7));

  const allowance = await evaluateWorkspaceAiOperation({ teamId });
  const meter = allowance.scope ? await getWorkspaceAiUsageThisMonth(allowance.scope) : { consumed: 0, cap: null };
  // The workspace's record population through the canonical scope authority
  // (a raw teamId predicate misses a personal workspace's legacy NULL-team rows).
  const evidenceScope = await workspaceEvidenceWhere(teamId, prisma);

  const [todayRow, weekRows, allMonths, evidenceTypes, activeApiKeys, activeBatches] = await Promise.all([
    prisma.aiUsageDaily
      .findUnique({ where: { workspaceId_dayUtc: { workspaceId: teamId, dayUtc: todayKey } } })
      .catch(() => null),
    prisma.aiUsageDaily
      .findMany({ where: { workspaceId: teamId, dayUtc: { gte: dayKey(weekStart) } }, select: { operations: true } })
      .catch(() => [] as Array<{ operations: number }>),
    prisma.aiUsageMonthly
      .aggregate({ where: { workspaceId: teamId }, _sum: { operations: true } })
      .catch(() => ({ _sum: { operations: 0 } })),
    prisma.evidence.groupBy({
      by: ["type"],
      where: { AND: [evidenceScope, { deletedAt: null }] },
      _count: { type: true },
    }),
    prisma.apiCredential.count({ where: { status: "ACTIVE", teamId } }),
    batchAnalysisService.countJobs(userId, ["PENDING", "PROCESSING"], { teamId }),
  ]);

  const unitCost = readFloatEnv("AI_ANALYSIS_UNIT_PRICE_USD", 0.1);
  const thisMonth = meter.consumed;
  const total = Math.max(allMonths._sum.operations ?? 0, thisMonth);

  const topEvidenceTypes: Record<string, number> = {};
  for (const row of evidenceTypes) {
    topEvidenceTypes[String(row.type).toLowerCase()] = row._count.type;
  }

  return {
    workspaceId: teamId,
    dailyAnalyses: {
      today: todayRow?.operations ?? 0,
      thisWeek: weekRows.reduce((sum, row) => sum + row.operations, 0),
      thisMonth,
    },
    costBreakdown: {
      totalCost: total * unitCost,
      thisMonth: thisMonth * unitCost,
      averagePerAnalysis: total > 0 ? unitCost : 0,
    },
    costBasis: "ILLUSTRATIVE_LIST_RATE_ESTIMATE" as const,
    costIsCharged: false,
    topEvidenceTypes,
    activeApiKeys,
    activeBatches,
  };
}

async function getRealQuotas(req: FastifyRequest, userId: string) {
  // B6-F-40 — this workspace's jobs only.
  const batchJobsUsed = await batchAnalysisService.countJobs(userId, undefined, batchWorkspaceOf(req));
  // PRO-G1-11 / PRO-G2-11 — API keys of the workspace this request PROVED
  // (the same predicate as /v1/usage-stats `activeApiKeys`), against the limit
  // key creation enforces: INTEGRATION_API_KEYS_MAX, resolved exactly as the
  // create route resolves it. It counted every workspace the caller OWNS and
  // showed "No enforced limit" while a Pro workspace's create answered 429
  // with limit 0. (The user-wide analytics count that sat here is gone: the
  // allowance below is the workspace meter, and nothing else is shown.)
  const { teamId: provenTeamId } = batchWorkspaceOf(req);
  const apiKeysUsed = await prisma.apiCredential.count({
    where: { status: "ACTIVE", teamId: provenTeamId },
  });
  const apiKeysEntitlement = await resolveEntitlement({ teamId: provenTeamId, key: "INTEGRATION_API_KEYS_MAX" });
  const apiKeysLimit = typeof apiKeysEntitlement.value === "number" ? apiKeysEntitlement.value : 0;

  // BILLING-010 — the seats shown are the seats enforced: the ONE seat answer for
  // the workspace in use. This read a personal entitlement or an env default,
  // counted the owner and ignored the contract, so a 400-seat owner saw "x / 10"
  // beside the real Billing page.
  // The request's own workspace, proven: a pointer alone is not a membership.
  const current = await evaluateCurrentWorkspace(req, { permission: "evidence.read" });
  const seats = current.allowed
    ? await resolveWorkspaceSeatState(current.context.workspaceId, prisma)
    : null;

  // BILLING-010 — the AI allowance is the one the AI gate enforces, on the meter
  // it charges. The three limits here were env figures nothing enforced, and the
  // count was analytics events of the user. Batch jobs have no enforced
  // limit, so none is shown; API keys show the enforced per-workspace limit.
  const allowance = current.allowed
    ? await evaluateWorkspaceAiOperation({ teamId: current.context.workspaceId })
    : null;
  const ai = allowance?.scope ? await getWorkspaceAiUsageThisMonth(allowance.scope) : null;

  return {
    analyses: {
      limit: ai?.cap ?? null,
      used: ai ? ai.consumed : 0,
      remaining: ai && ai.cap !== null ? Math.max(0, ai.cap - ai.consumed) : null,
      resetDate: nextMonthStart().toISOString(),
    },
    batchJobs: {
      limit: null,
      used: batchJobsUsed,
      remaining: null,
    },
    apiKeys: {
      limit: apiKeysLimit,
      used: apiKeysUsed,
      remaining: Math.max(0, apiKeysLimit - apiKeysUsed),
    },
    teamMembers: {
      // Null when nothing bounds the workspace as a whole: capacity is then per
      // Collaboration Team, and the page says so instead of inventing a number.
      limit: seats?.limit ?? null,
      used: seats?.used ?? 0,
      remaining: seats?.remaining ?? null,
    },
  };
}

export async function enterpriseRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // A-3 CLOSURE — `/v1/api-keys*` legacy surface retired (HTTP 410 Gone).
  //
  // The previous handlers wrote to an in-memory `Map<>` in
  // `services/api-keys.service.ts`. That store was user-scoped, not durable,
  // had no audit trail, and was a parallel implementation to the canonical
  // Phase 17 `ApiCredential` model surfaced at `/v1/integrations/api-keys`
  // (team-scoped, durable, audit-backed, scoped to canonical permissions).
  //
  // Two-surface key management is a security finding (parallel auth state),
  // so the legacy surface is now retired:
  //
  //   - All 5 handlers below (`POST`, `GET`, `DELETE`, `POST /rotate`,
  //     `PATCH /rate-limit`) return HTTP 410 Gone.
  //   - Each retired call emits a `enterprise.api_key_legacy_endpoint_called`
  //     platform audit event tagged with the original method/path so
  //     operators can watch for residual clients that still try these.
  //   - Callers are redirected to `/v1/integrations/api-keys` via the
  //     `code: "API_KEYS_LEGACY_RETIRED"` payload.
  //
  // The legacy `services/api-keys.service.ts` file has been deleted and
  // `phase-cr1-legacy-purge.test.ts` now asserts BOTH the deletion and
  // these 410 responders.
  // ---------------------------------------------------------------------------

  const LEGACY_RETIRED_BODY = {
    code: "API_KEYS_LEGACY_RETIRED" as const,
    detail:
      "This API key endpoint has been retired. " +
      "Manage API keys at /v1/integrations/api-keys instead.",
    canonicalSurface: "/v1/integrations/api-keys",
  };

  function emitLegacyEndpointAuditAndRespond(
    req: FastifyRequest,
    reply: FastifyReply,
    legacyAction: string,
  ) {
    const userId = req.user?.sub ?? null;
    auditEnterpriseAction(req, {
      userId,
      action: "enterprise.api_key_legacy_endpoint_called",
      outcome: "blocked",
      severity: "warning",
      resourceType: "api_key",
      metadata: {
        legacyAction,
        method: req.method,
        path: getRequestPath(req),
        canonicalSurface: LEGACY_RETIRED_BODY.canonicalSurface,
      },
    });
    return reply.code(410).send(LEGACY_RETIRED_BODY);
  }

  // Phase Final-A3-PT2 — collapse the 5 explicit 410 handlers
  // (POST/GET on `/v1/api-keys`, DELETE/POST/PATCH on `/v1/api-keys/:id*`)
  // into two wildcard registrations covering every method + sub-path.
  app.all("/v1/api-keys", { preHandler: [requireAuthAndLegal] }, async (req, reply) =>
    emitLegacyEndpointAuditAndRespond(req, reply, "api_keys_root"),
  );
  app.all("/v1/api-keys/*", { preHandler: [requireAuthAndLegal] }, async (req, reply) =>
    emitLegacyEndpointAuditAndRespond(req, reply, "api_keys_subpath"),
  );

  app.post<{
    Body: { evidenceIds: string[]; name: string; description?: string };
  }>(
    "/v1/batch-analysis",
    { preHandler: [requireAuthLegalProfessionalWriter] },
    async (req) => {
      const userId = getAuthUserId(req);
      const workspace = batchWorkspaceOf(req);
      const { evidenceIds, name, description } = req.body;

      if (!evidenceIds || !Array.isArray(evidenceIds) || evidenceIds.length === 0) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "At least one evidence ID is required");
      }

      if (!name) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "Batch name is required");
      }

      try {
        // Members re-audit (second round, defect 5) — a batch is still built
        // only from the caller's own uploads, and each one must ALSO pass the
        // canonical record authority (resolveEvidenceRecordAccess,
        // evidence.read): current ACTIVE, unexpired membership, the
        // Organization's lifecycle, the role's capability and the
        // restricted-case rule. Being the record's uploader proves none of
        // those — a suspended member or an uploader shut out of a restricted
        // case used to get the analysis of content they can no longer open.
        const uniqueIds = [...new Set(evidenceIds)];
        const rows = await prisma.evidence.findMany({
          where: { id: { in: uniqueIds }, ownerUserId: userId, deletedAt: null },
          // teamId comes back on the same rows, so the durable job gets its
          // workspace without a second query.
          select: { id: true, teamId: true },
        });
        const evidence: typeof rows = [];
        for (const row of rows) {
          const decision = await resolveEvidenceRecordAccess({
            userId,
            evidenceId: row.id,
            permission: "evidence.read",
          });
          if (decision.allowed) evidence.push(row);
        }

        if (evidence.length !== uniqueIds.length || uniqueIds.length !== evidenceIds.length) {
          auditEnterpriseAction(req, {
            userId,
            action: "enterprise.batch_create",
            outcome: "blocked",
            severity: "warning",
            resourceType: "batch_job",
            metadata: { reason: "evidence_not_found_or_forbidden" },
          });

          throw new AppError(
            ErrorCode.EVIDENCE_NOT_FOUND,
            "Some evidence items not found or you don't have access"
          );
        }

        // ONE workspace per job. A batch spanning two has no honest team_id,
        // and assigning one of them would hide the rest from their own
        // workspace's reads.
        const teamIds = [...new Set(evidence.map((e) => e.teamId).filter(Boolean))];
        if (teamIds.length !== 1 || !teamIds[0]) {
          auditEnterpriseAction(req, {
            userId,
            action: "enterprise.batch_create",
            outcome: "blocked",
            severity: "warning",
            resourceType: "batch_job",
            metadata: { reason: "evidence_spans_multiple_workspaces" },
          });
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            "A batch job analyses evidence from one workspace. These items span more than one.",
          );
        }

        // B6-F-40 — and that workspace is the one this request proved. Plan
        // and role were checked on it; a record from another workspace (the
        // caller's Free personal one, say) is not analysed under its plan.
        if (teamIds[0] !== workspace.teamId) {
          auditEnterpriseAction(req, {
            userId,
            action: "enterprise.batch_create",
            outcome: "blocked",
            severity: "warning",
            resourceType: "batch_job",
            metadata: { reason: "evidence_outside_request_workspace" },
          });
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            "A batch job analyses evidence from the workspace you are working in. These items belong to another workspace.",
          );
        }

        const job = await batchAnalysisService.createJob({
          ownerUserId: userId,
          teamId: workspace.teamId,
          evidenceIds,
          name,
          description,
        });

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.batch_create",
          outcome: "success",
          resourceType: "batch_job",
          resourceId: job.id,
          metadata: {
            name: job.name,
            totalItems: job.totalItems,
          },
        });

        fireEnterpriseAnalyticsEvent({
          eventType: "batch_job_created",
          userId,
          req,
          entityType: "batch_job",
          entityId: job.id,
          metadata: { totalItems: job.totalItems },
        });

        return {
          data: {
            id: job.id,
            name: job.name,
            status: job.status,
            totalItems: job.totalItems,
            processedItems: job.processedItems,
            failedItems: job.failedItems,
            createdAt: job.createdAt,
          },
          message: "Batch job created. Call /batch-analysis/{id}/process to start.",
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.batch_create",
          outcome: "failure",
          severity: "critical",
          resourceType: "batch_job",
        });

        throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, "Failed to create batch job");
      }
    }
  );

  app.get<{ Params: { id: string } }>(
    "/v1/batch-analysis/:id",
    { preHandler: [requireAuthLegalAndProfessional] },
    async (req) => {
      const userId = getAuthUserId(req);
      const { id } = req.params;

      try {
        const job = await batchAnalysisService.getJob(userId, id, batchWorkspaceOf(req));

        if (!job) {
          auditEnterpriseAction(req, {
            userId,
            action: "enterprise.batch_view",
            outcome: "failure",
            severity: "warning",
            resourceType: "batch_job",
            resourceId: id,
            metadata: { reason: "not_found" },
          });
          throw new AppError(ErrorCode.NOT_FOUND, "Batch job not found");
        }

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.batch_view",
          outcome: "success",
          resourceType: "batch_job",
          resourceId: id,
          metadata: { status: job.status },
        });

        return {
          data: {
            id: job.id,
            name: job.name,
            status: job.status,
            totalItems: job.totalItems,
            processedItems: job.processedItems,
            failedItems: job.failedItems,
            createdAt: job.createdAt,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
            estimatedCompletion: job.estimatedCompletion,
            items: job.items.map((item) => ({
              evidenceId: item.evidenceId,
              status: item.status,
              progress: item.progress,
              error: item.error,
            })),
          },
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.batch_view",
          outcome: "failure",
          severity: "critical",
          resourceType: "batch_job",
          resourceId: id,
        });

        throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, "Failed to retrieve batch job");
      }
    }
  );

  app.get(
    "/v1/batch-analysis",
    { preHandler: [requireAuthLegalAndProfessional] },
    async (req) => {
      const userId = getAuthUserId(req);

      try {
        // F-21 — bounded and item-free (see listJobSummaries).
        const { jobs, truncated } = await batchAnalysisService.listJobSummaries(
          userId,
          undefined,
          batchWorkspaceOf(req),
        );

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.batch_list",
          outcome: "success",
          resourceType: "batch_job",
          metadata: { count: jobs.length },
        });

        return {
          truncated,
          data: jobs.map((job) => ({
            id: job.id,
            name: job.name,
            status: job.status,
            totalItems: job.totalItems,
            processedItems: job.processedItems,
            failedItems: job.failedItems,
            createdAt: job.createdAt,
            completedAt: job.completedAt,
            progress: Math.round(
              ((job.processedItems + job.failedItems) / job.totalItems) * 100
            ),
          })),
        };
      } catch (error) {
        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.batch_list",
          outcome: "failure",
          severity: "critical",
          resourceType: "batch_job",
        });

        throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, "Failed to list batch jobs", {
          reason: error instanceof Error ? error.name.slice(0, 64) : "unknown_error",
        });
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    "/v1/batch-analysis/:id/process",
    { preHandler: [requireAuthLegalProfessionalWriter] },
    async (req) => {
      const userId = getAuthUserId(req);
      const { id } = req.params;

      try {
        const job = await batchAnalysisService.getJob(userId, id, batchWorkspaceOf(req));

        if (!job) {
          auditEnterpriseAction(req, {
            userId,
            action: "enterprise.batch_process",
            outcome: "failure",
            severity: "warning",
            resourceType: "batch_job",
            resourceId: id,
            metadata: { reason: "not_found" },
          });
          throw new AppError(ErrorCode.NOT_FOUND, "Batch job not found");
        }

        // Only a PENDING job can start. This route answered 200 "Batch
        // processing started" for a CANCELLED (or finished, or running) job,
        // and the background claim then refused it, so nothing ran and the
        // caller was told it had (remediation 2026-11-10, tracked apart from
        // the AUD ledger). A race between two PENDING calls still ends with
        // one claim; the job does run, so neither answer is untrue.
        if (job.status !== BatchStatus.PENDING) {
          auditEnterpriseAction(req, {
            userId,
            action: "enterprise.batch_process",
            outcome: "failure",
            severity: "info",
            resourceType: "batch_job",
            resourceId: id,
            metadata: { reason: "not_pending", status: String(job.status) },
          });
          throw new AppError(
            ErrorCode.CONFLICT,
            job.status === BatchStatus.PROCESSING
              ? "This batch job is already processing."
              : "This batch job has already ended and cannot be started.",
          );
        }

        // B6-F-41 — the analyser is metadata-only, and was handed no evidence
        // getter, so every item completed with an empty result. The getter
        // reads each record inside the job's (proven) workspace only.
        const workspace = batchWorkspaceOf(req);
        const processingPromise = batchAnalysisService.processBatch(
          userId,
          id,
          (evidenceId) =>
            prisma.evidence.findFirst({
              where: { id: evidenceId, teamId: workspace.teamId, deletedAt: null },
              select: {
                type: true,
                mimeType: true,
                status: true,
                verificationStatus: true,
                createdAt: true,
                sizeBytes: true,
                storageBucket: true,
                storageKey: true,
              },
            }),
          workspace,
        );

        processingPromise
          .then(async () => {
            // CR1 Phase E — legacy in-memory webhook trigger removed.
            // It was a dead try/catch that fetched the legacy webhook
            // service factory and immediately void'd the handle. Canonical
            // webhook fan-out for batch completion belongs in the
            // integrations subsystem (see `webhook-dispatcher.ts`); add
            // it there if/when batch-complete events are wired.

            try {
              const emailService = getEmailService();
              if (emailService.isConfigured()) {
                const completedJob = await batchAnalysisService.getJob(userId, id, workspace);
                if (completedJob) {
                  const userEmail = req.user?.email || "";
                  if (userEmail) {
                    // B6-F-41 — the email names the workspace the job ran in,
                    // not the placeholder "Organization".
                    const team = await prisma.team.findUnique({
                      where: { id: workspace.teamId },
                      select: { name: true },
                    });
                    void emailService.sendBatchComplete(
                      userEmail,
                      team?.name?.trim() || "your workspace",
                      completedJob.name,
                      completedJob.totalItems,
                      completedJob.failedItems,
                      // PRO-PW-04 — APP_URL was read nowhere else; THE app-host authority.
                      batchCompletionEmailLink(getEmailAppBaseUrl())
                    );
                  }
                }
              }
            } catch (error) {
              console.error("Failed to send batch completion email:", error);
            }
          })
          .catch((error) => {
            console.error("Error in batch processing completion handlers:", error);
          });

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.batch_process",
          outcome: "success",
          resourceType: "batch_job",
          resourceId: id,
          metadata: { status: "processing" },
        });

        fireEnterpriseAnalyticsEvent({
          eventType: "batch_job_processing_started",
          userId,
          req,
          entityType: "batch_job",
          entityId: id,
        });

        return {
          message: "Batch processing started",
          data: { jobId: id, status: "processing" },
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.batch_process",
          outcome: "failure",
          severity: "critical",
          resourceType: "batch_job",
          resourceId: id,
        });

        throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, "Failed to start batch processing");
      }
    }
  );

  app.get<{ Params: { id: string } }>(
    "/v1/batch-analysis/:id/results",
    { preHandler: [requireAuthLegalAndProfessional] },
    async (req) => {
      const userId = getAuthUserId(req);
      const { id } = req.params;

      try {
        const job = await batchAnalysisService.getJob(userId, id, batchWorkspaceOf(req));

        if (!job) {
          auditEnterpriseAction(req, {
            userId,
            action: "enterprise.batch_results_view",
            outcome: "failure",
            severity: "warning",
            resourceType: "batch_job",
            resourceId: id,
            metadata: { reason: "not_found" },
          });
          throw new AppError(ErrorCode.NOT_FOUND, "Batch job not found");
        }

        if (job.status !== "completed" && job.status !== "cancelled") {
          auditEnterpriseAction(req, {
            userId,
            action: "enterprise.batch_results_view",
            outcome: "blocked",
            severity: "warning",
            resourceType: "batch_job",
            resourceId: id,
            metadata: { reason: "still_processing", status: job.status },
          });
          throw new AppError(ErrorCode.VALIDATION_ERROR, "Batch job is still processing");
        }

        const aggregatedResults = await batchAnalysisService.getAggregateResults(userId, id, batchWorkspaceOf(req));

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.batch_results_view",
          outcome: "success",
          resourceType: "batch_job",
          resourceId: id,
        });

        return { data: aggregatedResults };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.batch_results_view",
          outcome: "failure",
          severity: "critical",
          resourceType: "batch_job",
          resourceId: id,
        });

        throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, "Failed to retrieve batch results");
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    "/v1/batch-analysis/:id/cancel",
    // B6-F-50 (Free-user audit 0ea0) — stopping one's OWN job is an essential
    // path (A1-06): it adds nothing, so it is legal-gate exempt (CANCELLATION
    // in legal-acceptance-route-policy) and it does not ask the plan or the
    // workspace — a downgrade, a demotion or leaving the workspace must not
    // keep a job running. Ownership is the predicate of `cancelJob` itself.
    { preHandler: [requireAuthAndLegal] },
    async (req) => {
      const userId = getAuthUserId(req);
      const { id } = req.params;

      try {
        const outcome = await batchAnalysisService.cancelJob(userId, id);

        if (outcome === "NOT_FOUND") {
          auditEnterpriseAction(req, {
            userId,
            action: "enterprise.batch_cancel",
            outcome: "failure",
            severity: "warning",
            resourceType: "batch_job",
            resourceId: id,
            metadata: { reason: "not_found" },
          });
          throw new AppError(ErrorCode.NOT_FOUND, "Batch job not found");
        }

        if (outcome === "ALREADY_TERMINAL") {
          // A job that has already finished is not a job that never existed,
          // and the audit must not record a cancellation that did not happen —
          // which is exactly what this route used to do for a pending job.
          auditEnterpriseAction(req, {
            userId,
            action: "enterprise.batch_cancel",
            outcome: "failure",
            severity: "info",
            resourceType: "batch_job",
            resourceId: id,
            metadata: { reason: "already_terminal" },
          });
          throw new AppError(
            ErrorCode.CONFLICT,
            "This batch job has already finished and cannot be cancelled.",
          );
        }

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.batch_cancel",
          outcome: "success",
          resourceType: "batch_job",
          resourceId: id,
        });

        fireEnterpriseAnalyticsEvent({
          eventType: "batch_job_cancelled",
          userId,
          req,
          entityType: "batch_job",
          entityId: id,
        });

        return { message: "Batch job cancelled" };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.batch_cancel",
          outcome: "failure",
          severity: "critical",
          resourceType: "batch_job",
          resourceId: id,
        });

        throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, "Failed to cancel batch job");
      }
    }
  );

  app.get<{ Params: { id: string } }>(
    "/v1/batch-analysis/:id/export",
    { preHandler: [requireAuthLegalAndProfessional] },
    async (req, res) => {
      const userId = getAuthUserId(req);
      const { id } = req.params;

      try {
        const job = await batchAnalysisService.getJob(userId, id, batchWorkspaceOf(req));

        if (!job) {
          auditEnterpriseAction(req, {
            userId,
            action: "enterprise.batch_export",
            outcome: "failure",
            severity: "warning",
            resourceType: "batch_job",
            resourceId: id,
            metadata: { reason: "not_found" },
          });
          throw new AppError(ErrorCode.NOT_FOUND, "Batch job not found");
        }

        const csv = await batchAnalysisService.exportAsCSV(userId, id, batchWorkspaceOf(req));

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.batch_export",
          outcome: "success",
          resourceType: "batch_job",
          resourceId: id,
        });

        res.header("Content-Type", "text/csv");
        res.header("Content-Disposition", `attachment; filename="batch-${id}.csv"`);

        return res.send(csv);
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.batch_export",
          outcome: "failure",
          severity: "critical",
          resourceType: "batch_job",
          resourceId: id,
        });

        throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, "Failed to export batch results");
      }
    }
  );

  app.get(
    "/v1/quotas",
    { preHandler: [requireAuthLegalAndProfessional] },
    async (req) => {
      const userId = getAuthUserId(req);

      try {
        const data = await getRealQuotas(req, userId);

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.quotas_view",
          outcome: "success",
          resourceType: "quotas",
        });

        return { data };
      } catch (error) {
        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.quotas_view",
          outcome: "failure",
          severity: "critical",
          resourceType: "quotas",
        });

        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to load quotas",
          { reason: error instanceof Error ? error.name.slice(0, 64) : "unknown_error" }
        );
      }
    }
  );
  
  app.get(
    "/v1/usage-stats",
    { preHandler: [requireAuthLegalAndProfessional] },
    async (req) => {
      const userId = getAuthUserId(req);

      try {
        const data = await getRealUsageStats(req, userId);

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.usage_stats_view",
          outcome: "success",
          resourceType: "usage_stats",
        });

        return { data };
      } catch (error) {
        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.usage_stats_view",
          outcome: "failure",
          severity: "critical",
          resourceType: "usage_stats",
        });

        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to load usage statistics",
          { reason: error instanceof Error ? error.name.slice(0, 64) : "unknown_error" }
        );
      }
    }
  );
}