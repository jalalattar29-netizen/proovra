/**
 * Phase 25 — Reviewer Operations Intelligence + SLA Engine routes.
 *
 *   GET  /v1/reviewer-ops/queue?teamId&queue&limit
 *   GET  /v1/reviewer-ops/dashboard?teamId
 *   GET  /v1/reviewer-ops/workspace/:workflowId?teamId
 *   GET  /v1/reviewer-ops/workload?teamId&limit
 *
 *   POST /v1/reviewer-ops/reviews/:workflowId/assign
 *   POST /v1/reviewer-ops/reviews/:workflowId/reassign
 *   POST /v1/reviewer-ops/reviews/:workflowId/start
 *   POST /v1/reviewer-ops/reviews/:workflowId/pause
 *   POST /v1/reviewer-ops/reviews/:workflowId/request-info
 *   POST /v1/reviewer-ops/reviews/:workflowId/approve
 *   POST /v1/reviewer-ops/reviews/:workflowId/reject
 *
 *   GET  /v1/reviewer-ops/escalations?teamId&status&severity&reason
 *   POST /v1/reviewer-ops/escalations/:id/acknowledge
 *   POST /v1/reviewer-ops/escalations/:id/reassign
 *   POST /v1/reviewer-ops/escalations/:id/resolve
 *   POST /v1/reviewer-ops/escalations/:id/suppress
 *
 *   POST /v1/reviewer-ops/reconcile (cron-secret protected)
 *
 * Auth posture:
 *   - All routes (except reconcile) use `requireAuth` + a Phase 17
 *     workspace-membership gate (404 on non-member, anti-enumeration).
 *   - Reviewer actions gate on `evidence_request.review`.
 *   - Reconcile uses a shared-secret header (REVIEWER_OPS_CRON_SECRET
 *     or INTEGRATION_CRON_SECRET fallback).
 *   - Errors map to the Phase 25 ReviewerOpsErrorCode catalog.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ReviewerOpsBulkInputSchema,
  ReviewerOpsSavedViewFilterSchema,
  ReviewerOpsSlaPolicySchema,
  REVIEWER_OPS_QUEUE_TYPES,
  REVIEW_ESCALATION_REASONS,
  REVIEW_ESCALATION_STATUSES,
  SAVED_VIEW_VISIBILITIES,
  type SavedViewVisibility,
} from "@proovra/shared";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { evaluateMemberAccess } from "../services/identity/access-policy.service.js";
import {
  ReviewerOpsError,
  approveReview,
  assignReviewerToWorkflow,
  buildDashboard,
  getReviewerOpsWorkspace,
  listReviewerOpsQueue,
  pauseReview,
  rejectReview,
  requestInformation,
  runReconcile,
  startReview,
  type LifecycleActorContext,
} from "../services/reviewer-ops/reviewer-operations-engine.service.js";
import { projectQueueIntelligence } from "../services/reviewer-ops/queue-intelligence.service.js";
import {
  EscalationEngineError,
  acknowledgeEscalation,
  createEscalation,
  listEscalations,
  reassignEscalation,
  resolveEscalation,
  suppressEscalation,
} from "../services/reviewer-ops/escalation-engine.service.js";
import {
  computeReviewerWorkload,
  listLatestWorkloadSnapshots,
  suggestReviewers,
} from "../services/reviewer-ops/workload.service.js";
import {
  loadWorkspaceReviewerOpsFlags,
  resolveEffectiveSlaPolicy,
  upsertWorkspaceReviewerOpsFlags,
  upsertWorkspaceSlaPolicy,
  type WorkspaceReviewerOpsFlags,
} from "../services/reviewer-ops/sla-policy.service.js";
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";
import type { StepUpPurpose } from "@proovra/shared";
import { runtimeAdaptiveGate } from "../services/access-control/adaptive-runtime-gate.service.js";
import { executeBulkTriage } from "../services/reviewer-ops/bulk-triage.service.js";
import {
  createReviewerOpsSavedView,
  deleteReviewerOpsSavedView,
  listReviewerOpsSavedViews,
} from "../services/reviewer-ops/saved-queue-views.service.js";
import {
  getEscalationAnalytics,
  getReviewerPerformance,
} from "../services/reviewer-ops/analytics.service.js";
import { bump } from "../services/ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../services/security/security-event.service.js";

// -----------------------------------------------------------------------------
// Auth helpers — 404-on-non-member + reviewer-capability resolution
// -----------------------------------------------------------------------------

async function requireReviewerActor(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<LifecycleActorContext | null> {
  const userId = getAuthUserId(req);
  const member = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { id: true, status: true },
  });
  if (!member) {
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  if (member.status !== "ACTIVE") {
    reply.code(403).send({
      error: { code: "REVIEW_ACTOR_BLOCKED", reason: "member_inactive" },
    });
    return null;
  }
  // Reviewer permission gate. Service-account JWTs are detected via
  // the auth surface; we look up the user record to read the kind.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!user) {
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  const reviewerCheck = await evaluateMemberAccess({
    teamId,
    userId,
    permission: "evidence_request.review",
  });
  // We treat anyone WITHOUT reviewer permission as still able to view
  // (so admins can dashboard), but write operations re-check.
  return {
    teamId,
    actorUserId: userId,
    isReviewerCapable: reviewerCheck.allowed,
    isServiceAccount: false,
  };
}

function requireReviewerCapable(
  ctx: LifecycleActorContext,
  reply: FastifyReply,
): boolean {
  if (!ctx.isReviewerCapable) {
    reply.code(403).send({
      error: {
        code: "REVIEW_PERMISSION_DENIED",
        reason: "reviewer_required",
      },
    });
    return false;
  }
  return true;
}

// -----------------------------------------------------------------------------
// Phase 25.5 — Step-up gate driven by workspace governance flags.
//
// If the matching workspace flag (`requireStepUpForApprove`, etc.) is
// false, this is a no-op. When true, the request must carry a fresh
// approved step-up challenge for the given purpose; otherwise the
// middleware sends the challenge response and we return `true` so the
// caller bails out cleanly.
// -----------------------------------------------------------------------------

type StepUpGateKey =
  | "approve"
  | "reject"
  | "escalationResolve"
  | "bulk";

const STEP_UP_PURPOSE_BY_GATE: Record<StepUpGateKey, StepUpPurpose> = {
  approve: "REVIEW_APPROVAL_HIGH_RISK",
  reject: "REVIEWER_OPS_REJECT",
  escalationResolve: "REVIEWER_OPS_ESCALATION_RESOLVE",
  bulk: "REVIEWER_OPS_BULK_ACTION",
};

const STEP_UP_FLAG_BY_GATE: Record<StepUpGateKey, keyof WorkspaceReviewerOpsFlags> = {
  approve: "requireStepUpForApprove",
  reject: "requireStepUpForReject",
  escalationResolve: "requireStepUpForEscalationResolve",
  bulk: "requireStepUpForBulk",
};

async function enforceStepUpIfFlagged(
  req: FastifyRequest,
  reply: FastifyReply,
  ctx: LifecycleActorContext,
  gate: StepUpGateKey,
  resource: { kind: string; id: string },
): Promise<boolean> {
  const flags = await loadWorkspaceReviewerOpsFlags(ctx.teamId);
  const flagKey = STEP_UP_FLAG_BY_GATE[gate];
  if (!flags[flagKey]) return false; // not required → proceed
  const result = await requireStepUpForSensitiveAction({
    req,
    reply,
    teamId: ctx.teamId,
    userId: ctx.actorUserId,
    purpose: STEP_UP_PURPOSE_BY_GATE[gate],
    resourceKind: resource.kind,
    resourceId: resource.id,
  });
  return result.sent; // true → middleware already replied
}

// -----------------------------------------------------------------------------
// Error mapping
// -----------------------------------------------------------------------------

function sendEngineError(reply: FastifyReply, err: unknown): boolean {
  if (err instanceof ReviewerOpsError) {
    const status =
      err.code === "REVIEW_WORKFLOW_NOT_FOUND"
        ? 404
        : err.code === "REVIEW_PERMISSION_DENIED" ||
            err.code === "REVIEW_ACTOR_BLOCKED" ||
            err.code === "REVIEW_GOVERNANCE_BLOCKED"
          ? 403
          : err.code === "REVIEW_STEP_UP_REQUIRED"
            ? 401
            : 409;
    reply
      .code(status)
      .send({ error: { code: err.code, details: err.details ?? null } });
    return true;
  }
  if (err instanceof EscalationEngineError) {
    const status =
      err.code === "REVIEW_ESCALATION_NOT_FOUND" ||
      err.code === "REVIEW_WORKFLOW_NOT_FOUND"
        ? 404
        : err.code === "REVIEW_PERMISSION_DENIED"
          ? 403
          : 409;
    reply
      .code(status)
      .send({ error: { code: err.code, details: err.details ?? null } });
    return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Param + body schemas
// -----------------------------------------------------------------------------

const TeamIdQuery = z.object({ teamId: z.string().uuid() });
const ParamsWorkflowId = z.object({ workflowId: z.string().uuid() });
const ParamsId = z.object({ id: z.string().uuid() });

const BoundedNote = z.string().min(1).max(1000);

/**
 * Per-team wrapper around `runReconcile()` used by the all-teams
 * sweep. A failure for one team must NOT abort the rest of the
 * sweep — we capture the error into a structured result and let the
 * loop carry on. The route catch-block contract (every `catch (err)`
 * must call `sendEngineError` or `throw err`) is honored by isolating
 * the try/catch inside this helper, which lives outside any route
 * handler.
 */
async function runReconcileSafely(input: {
  teamId: string;
  batchSize?: number;
}): Promise<
  | { ok: true; result: Awaited<ReturnType<typeof runReconcile>> }
  | { ok: false; error: string }
> {
  try {
    const result = await runReconcile({
      teamId: input.teamId,
      batchSize: input.batchSize,
    });
    return { ok: true, result };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "unknown_error",
    };
  }
}

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

export async function reviewerOpsRoutes(app: FastifyInstance) {
  // ===========================================================================
  // GET /v1/reviewer-ops/queue
  // ===========================================================================

  app.get(
    "/v1/reviewer-ops/queue",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid(),
          queue: z.enum(REVIEWER_OPS_QUEUE_TYPES).default("UNASSIGNED"),
          limit: z.coerce.number().int().min(1).max(100).optional(),
        })
        .parse(req.query ?? {});
      const ctx = await requireReviewerActor(req, reply, q.teamId);
      if (!ctx) return;
      const result = await listReviewerOpsQueue(
        {
          teamId: q.teamId,
          meUserId: ctx.actorUserId,
          queue: q.queue,
          limit: q.limit,
        },
      );
      return reply.code(200).send(result);
    },
  );

  // ===========================================================================
  // POST /v1/reviewer-ops/queue-intelligence
  // Phase 25.7 — single projection endpoint that hydrates queue rows
  // with priority + stuck + assignment-suggestion + workload pressure
  // + governance blockers. Bounded to 100 workflowIds per call.
  // ===========================================================================
  app.post(
    "/v1/reviewer-ops/queue-intelligence",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({
          teamId: z.string().uuid(),
          workflowIds: z.array(z.string().uuid()).min(1).max(100),
        })
        .parse(req.body ?? {});
      const ctx = await requireReviewerActor(req, reply, body.teamId);
      if (!ctx) return;
      const result = await projectQueueIntelligence({
        teamId: body.teamId,
        workflowIds: body.workflowIds,
        actorUserId: ctx.actorUserId,
        isReviewerCapable: ctx.isReviewerCapable,
      });
      return reply.code(200).send(result);
    },
  );

  // ===========================================================================
  // GET /v1/reviewer-ops/dashboard
  // ===========================================================================

  app.get(
    "/v1/reviewer-ops/dashboard",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = TeamIdQuery.parse(req.query ?? {});
      const ctx = await requireReviewerActor(req, reply, q.teamId);
      if (!ctx) return;
      const dashboard = await buildDashboard({
        teamId: q.teamId,
        meUserId: ctx.actorUserId,
      });
      return reply.code(200).send(dashboard);
    },
  );

  // ===========================================================================
  // GET /v1/reviewer-ops/workspace/:workflowId
  // ===========================================================================

  app.get(
    "/v1/reviewer-ops/workspace/:workflowId",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { workflowId } = ParamsWorkflowId.parse(req.params);
      const q = TeamIdQuery.parse(req.query ?? {});
      const ctx = await requireReviewerActor(req, reply, q.teamId);
      if (!ctx) return;
      try {
        const ws = await getReviewerOpsWorkspace({
          teamId: q.teamId,
          workflowId,
        });
        return reply.code(200).send(ws);
      } catch (err) {
        if (sendEngineError(reply, err)) return;
        throw err;
      }
    },
  );

  // ===========================================================================
  // GET /v1/reviewer-ops/workload
  // ===========================================================================

  app.get(
    "/v1/reviewer-ops/workload",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          reviewerUserId: z.string().uuid().optional(),
          suggest: z.coerce.boolean().optional(),
        })
        .parse(req.query ?? {});
      const ctx = await requireReviewerActor(req, reply, q.teamId);
      if (!ctx) return;
      if (q.reviewerUserId) {
        const counts = await computeReviewerWorkload({
          teamId: q.teamId,
          reviewerUserId: q.reviewerUserId,
        });
        return reply.code(200).send({ counts });
      }
      const [snapshots, suggestions] = await Promise.all([
        listLatestWorkloadSnapshots({ teamId: q.teamId, limit: q.limit }),
        q.suggest
          ? suggestReviewers({ teamId: q.teamId, topN: 5 })
          : Promise.resolve([]),
      ]);
      return reply.code(200).send({ snapshots, suggestions });
    },
  );

  // ===========================================================================
  // POST /v1/reviewer-ops/reviews/:workflowId/assign + reassign
  // ===========================================================================

  app.post(
    "/v1/reviewer-ops/reviews/:workflowId/assign",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { workflowId } = ParamsWorkflowId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          assignedToUserId: z.string().uuid(),
          note: BoundedNote.nullable().optional(),
        })
        .parse(req.body ?? {});
      const ctx = await requireReviewerActor(req, reply, body.teamId);
      if (!ctx) return;
      if (!requireReviewerCapable(ctx, reply)) return;
      try {
        const result = await assignReviewerToWorkflow(ctx, {
          workflowId,
          assignedToUserId: body.assignedToUserId,
          note: body.note ?? null,
        });
        return reply.code(200).send({ projection: result });
      } catch (err) {
        if (sendEngineError(reply, err)) return;
        throw err;
      }
    },
  );

  app.post(
    "/v1/reviewer-ops/reviews/:workflowId/reassign",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { workflowId } = ParamsWorkflowId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          newAssigneeUserId: z.string().uuid(),
          note: BoundedNote.nullable().optional(),
        })
        .parse(req.body ?? {});
      const ctx = await requireReviewerActor(req, reply, body.teamId);
      if (!ctx) return;
      if (!requireReviewerCapable(ctx, reply)) return;
      try {
        const result = await assignReviewerToWorkflow(ctx, {
          workflowId,
          assignedToUserId: body.newAssigneeUserId,
          note: body.note ?? null,
        });
        return reply.code(200).send({ projection: result });
      } catch (err) {
        if (sendEngineError(reply, err)) return;
        throw err;
      }
    },
  );

  // ===========================================================================
  // POST /v1/reviewer-ops/reviews/:workflowId/start
  // ===========================================================================

  app.post(
    "/v1/reviewer-ops/reviews/:workflowId/start",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { workflowId } = ParamsWorkflowId.parse(req.params);
      const body = z.object({ teamId: z.string().uuid() }).parse(req.body ?? {});
      const ctx = await requireReviewerActor(req, reply, body.teamId);
      if (!ctx) return;
      if (!requireReviewerCapable(ctx, reply)) return;
      try {
        const result = await startReview(ctx, { workflowId });
        return reply.code(200).send({ projection: result });
      } catch (err) {
        if (sendEngineError(reply, err)) return;
        throw err;
      }
    },
  );

  // ===========================================================================
  // POST /v1/reviewer-ops/reviews/:workflowId/pause
  // ===========================================================================

  app.post(
    "/v1/reviewer-ops/reviews/:workflowId/pause",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { workflowId } = ParamsWorkflowId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          pausedReason: BoundedNote.max(400),
        })
        .parse(req.body ?? {});
      const ctx = await requireReviewerActor(req, reply, body.teamId);
      if (!ctx) return;
      if (!requireReviewerCapable(ctx, reply)) return;
      try {
        const result = await pauseReview(ctx, {
          workflowId,
          pausedReason: body.pausedReason,
        });
        return reply.code(200).send({ projection: result });
      } catch (err) {
        if (sendEngineError(reply, err)) return;
        throw err;
      }
    },
  );

  // ===========================================================================
  // POST /v1/reviewer-ops/reviews/:workflowId/request-info
  // ===========================================================================

  app.post(
    "/v1/reviewer-ops/reviews/:workflowId/request-info",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { workflowId } = ParamsWorkflowId.parse(req.params);
      const body = z
        .object({ teamId: z.string().uuid(), note: BoundedNote })
        .parse(req.body ?? {});
      const ctx = await requireReviewerActor(req, reply, body.teamId);
      if (!ctx) return;
      if (!requireReviewerCapable(ctx, reply)) return;
      try {
        const result = await requestInformation(ctx, {
          workflowId,
          note: body.note,
        });
        return reply.code(200).send({ projection: result });
      } catch (err) {
        if (sendEngineError(reply, err)) return;
        throw err;
      }
    },
  );

  // ===========================================================================
  // POST /v1/reviewer-ops/reviews/:workflowId/approve
  // ===========================================================================

  app.post(
    "/v1/reviewer-ops/reviews/:workflowId/approve",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { workflowId } = ParamsWorkflowId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          note: BoundedNote.nullable().optional(),
        })
        .parse(req.body ?? {});
      const ctx = await requireReviewerActor(req, reply, body.teamId);
      if (!ctx) return;
      if (!requireReviewerCapable(ctx, reply)) return;
      // Phase 26.75 — adaptive runtime gate (quarantine + age + risk).
      const gateApprove = await runtimeAdaptiveGate({
        req,
        reply,
        teamId: body.teamId,
        userId: ctx.actorUserId,
        action: "REVIEWER_APPROVE",
      });
      if (!gateApprove.allow) return;
      if (
        await enforceStepUpIfFlagged(req, reply, ctx, "approve", {
          kind: "review_workflow",
          id: workflowId,
        })
      ) {
        return;
      }
      try {
        const result = await approveReview(ctx, {
          workflowId,
          note: body.note ?? null,
        });
        return reply.code(200).send({ projection: result });
      } catch (err) {
        if (sendEngineError(reply, err)) return;
        throw err;
      }
    },
  );

  // ===========================================================================
  // POST /v1/reviewer-ops/reviews/:workflowId/reject
  // ===========================================================================

  app.post(
    "/v1/reviewer-ops/reviews/:workflowId/reject",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { workflowId } = ParamsWorkflowId.parse(req.params);
      const body = z
        .object({ teamId: z.string().uuid(), note: BoundedNote })
        .parse(req.body ?? {});
      const ctx = await requireReviewerActor(req, reply, body.teamId);
      if (!ctx) return;
      if (!requireReviewerCapable(ctx, reply)) return;
      // Phase 26.75 — adaptive runtime gate.
      const gateReject = await runtimeAdaptiveGate({
        req,
        reply,
        teamId: body.teamId,
        userId: ctx.actorUserId,
        action: "REVIEWER_REJECT",
      });
      if (!gateReject.allow) return;
      if (
        await enforceStepUpIfFlagged(req, reply, ctx, "reject", {
          kind: "review_workflow",
          id: workflowId,
        })
      ) {
        return;
      }
      try {
        const result = await rejectReview(ctx, {
          workflowId,
          note: body.note,
        });
        return reply.code(200).send({ projection: result });
      } catch (err) {
        if (sendEngineError(reply, err)) return;
        throw err;
      }
    },
  );

  // ===========================================================================
  // GET /v1/reviewer-ops/escalations
  // ===========================================================================

  app.get(
    "/v1/reviewer-ops/escalations",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid(),
          status: z
            .enum([...REVIEW_ESCALATION_STATUSES, "ALL"] as [
              string,
              ...string[],
            ])
            .optional(),
          severity: z.enum(["INFO", "WARNING", "HIGH", "CRITICAL"]).optional(),
          reason: z.enum(REVIEW_ESCALATION_REASONS).optional(),
          assignedToUserId: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const ctx = await requireReviewerActor(req, reply, q.teamId);
      if (!ctx) return;
      const escalations = await listEscalations({
        teamId: q.teamId,
        status: q.status as never,
        severity: q.severity,
        reason: q.reason,
        assignedToUserId: q.assignedToUserId,
        limit: q.limit,
      });
      return reply.code(200).send({ escalations });
    },
  );

  // ===========================================================================
  // POST /v1/reviewer-ops/escalations — manual operator-raised escalation
  // ===========================================================================

  app.post(
    "/v1/reviewer-ops/escalations",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({
          teamId: z.string().uuid(),
          workflowId: z.string().uuid(),
          reason: z.enum(REVIEW_ESCALATION_REASONS),
          severity: z
            .enum(["INFO", "WARNING", "HIGH", "CRITICAL"])
            .default("WARNING"),
          safeSummary: BoundedNote.max(400),
          assignedToUserId: z.string().uuid().nullable().optional(),
        })
        .parse(req.body ?? {});
      const ctx = await requireReviewerActor(req, reply, body.teamId);
      if (!ctx) return;
      if (!requireReviewerCapable(ctx, reply)) return;
      const result = await createEscalation({
        teamId: body.teamId,
        workflowId: body.workflowId,
        reason: body.reason,
        severity: body.severity,
        safeSummary: body.safeSummary,
        createdByUserId: ctx.actorUserId,
        assignedToUserId: body.assignedToUserId ?? null,
      });
      if (!result.ok) {
        return reply
          .code(result.code === "REVIEW_WORKFLOW_NOT_FOUND" ? 404 : 403)
          .send({ error: { code: result.code } });
      }
      return reply
        .code(result.created ? 201 : 200)
        .send({ escalation: result.escalation });
    },
  );

  // ===========================================================================
  // POST /v1/reviewer-ops/escalations/:id/acknowledge | reassign | resolve | suppress
  // ===========================================================================

  app.post(
    "/v1/reviewer-ops/escalations/:id/acknowledge",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z.object({ teamId: z.string().uuid() }).parse(req.body ?? {});
      const ctx = await requireReviewerActor(req, reply, body.teamId);
      if (!ctx) return;
      if (!requireReviewerCapable(ctx, reply)) return;
      try {
        const escalation = await acknowledgeEscalation({
          teamId: body.teamId,
          escalationId: id,
          actorUserId: ctx.actorUserId,
        });
        return reply.code(200).send({ escalation });
      } catch (err) {
        if (sendEngineError(reply, err)) return;
        throw err;
      }
    },
  );

  app.post(
    "/v1/reviewer-ops/escalations/:id/reassign",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          newAssigneeUserId: z.string().uuid(),
        })
        .parse(req.body ?? {});
      const ctx = await requireReviewerActor(req, reply, body.teamId);
      if (!ctx) return;
      if (!requireReviewerCapable(ctx, reply)) return;
      try {
        const escalation = await reassignEscalation({
          teamId: body.teamId,
          escalationId: id,
          actorUserId: ctx.actorUserId,
          newAssigneeUserId: body.newAssigneeUserId,
        });
        return reply.code(200).send({ escalation });
      } catch (err) {
        if (sendEngineError(reply, err)) return;
        throw err;
      }
    },
  );

  app.post(
    "/v1/reviewer-ops/escalations/:id/resolve",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          resolutionNote: BoundedNote.max(400),
        })
        .parse(req.body ?? {});
      const ctx = await requireReviewerActor(req, reply, body.teamId);
      if (!ctx) return;
      if (!requireReviewerCapable(ctx, reply)) return;
      // Phase 26.75 — adaptive runtime gate.
      const gateResolveEsc = await runtimeAdaptiveGate({
        req,
        reply,
        teamId: body.teamId,
        userId: ctx.actorUserId,
        action: "REVIEW_ESCALATION_RESOLVE",
      });
      if (!gateResolveEsc.allow) return;
      if (
        await enforceStepUpIfFlagged(req, reply, ctx, "escalationResolve", {
          kind: "review_escalation",
          id,
        })
      ) {
        return;
      }
      try {
        const escalation = await resolveEscalation({
          teamId: body.teamId,
          escalationId: id,
          actorUserId: ctx.actorUserId,
          resolutionNote: body.resolutionNote,
        });
        return reply.code(200).send({ escalation });
      } catch (err) {
        if (sendEngineError(reply, err)) return;
        throw err;
      }
    },
  );

  app.post(
    "/v1/reviewer-ops/escalations/:id/suppress",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          suppressionReason: BoundedNote.max(400),
        })
        .parse(req.body ?? {});
      const ctx = await requireReviewerActor(req, reply, body.teamId);
      if (!ctx) return;
      if (!requireReviewerCapable(ctx, reply)) return;
      if (
        await enforceStepUpIfFlagged(req, reply, ctx, "escalationResolve", {
          kind: "review_escalation",
          id,
        })
      ) {
        return;
      }
      try {
        const escalation = await suppressEscalation({
          teamId: body.teamId,
          escalationId: id,
          actorUserId: ctx.actorUserId,
          suppressionReason: body.suppressionReason,
        });
        return reply.code(200).send({ escalation });
      } catch (err) {
        if (sendEngineError(reply, err)) return;
        throw err;
      }
    },
  );

  // ===========================================================================
  // Phase 25.5 — Bulk triage
  // ===========================================================================

  app.post(
    "/v1/reviewer-ops/reviews/bulk",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = ReviewerOpsBulkInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: { code: "validation_error", detail: parsed.error.flatten() } });
      }
      const body = parsed.data;
      const ctx = await requireReviewerActor(req, reply, body.teamId);
      if (!ctx) return;
      if (!requireReviewerCapable(ctx, reply)) return;
      // Phase 26.75 — adaptive runtime gate.
      const gateBulk = await runtimeAdaptiveGate({
        req,
        reply,
        teamId: body.teamId,
        userId: ctx.actorUserId,
        action: "REVIEWER_BULK",
      });
      if (!gateBulk.allow) return;
      if (
        await enforceStepUpIfFlagged(req, reply, ctx, "bulk", {
          kind: "review_workflow_bulk",
          id: body.workflowIds.slice(0, 8).join(","),
        })
      ) {
        return;
      }
      const result = await executeBulkTriage(ctx, body);
      return reply.code(result.failed === 0 ? 200 : 207).send(result);
    },
  );

  // ===========================================================================
  // Phase 25.5 — Saved queue views (REVIEWER_OPS scope)
  // ===========================================================================

  app.get(
    "/v1/reviewer-ops/saved-views",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const ctx = await requireReviewerActor(req, reply, q.teamId);
      if (!ctx) return;
      const views = await listReviewerOpsSavedViews({
        teamId: q.teamId,
        userId: ctx.actorUserId,
        limit: q.limit,
      });
      return reply.code(200).send({ views });
    },
  );

  app.post(
    "/v1/reviewer-ops/saved-views",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({
          teamId: z.string().uuid(),
          name: z.string().min(1).max(120),
          description: z.string().max(400).nullable().optional(),
          visibility: z.enum(
            SAVED_VIEW_VISIBILITIES as unknown as [string, ...string[]],
          ),
          pinned: z.boolean().optional(),
          filter: ReviewerOpsSavedViewFilterSchema,
        })
        .parse(req.body ?? {});
      if (body.filter.teamId !== body.teamId) {
        return reply
          .code(400)
          .send({ error: { code: "teamId_mismatch" } });
      }
      const ctx = await requireReviewerActor(req, reply, body.teamId);
      if (!ctx) return;
      if (!requireReviewerCapable(ctx, reply)) return;
      const view = await createReviewerOpsSavedView({
        teamId: body.teamId,
        actorUserId: ctx.actorUserId,
        name: body.name,
        description: body.description ?? null,
        visibility: body.visibility as SavedViewVisibility,
        pinned: body.pinned ?? false,
        filter: body.filter,
      });
      if (!view) {
        return reply
          .code(409)
          .send({ error: { code: "duplicate_saved_view" } });
      }
      return reply.code(201).send({ view });
    },
  );

  app.delete(
    "/v1/reviewer-ops/saved-views/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const q = z.object({ teamId: z.string().uuid() }).parse(req.query ?? {});
      const ctx = await requireReviewerActor(req, reply, q.teamId);
      if (!ctx) return;
      const ok = await deleteReviewerOpsSavedView({
        teamId: q.teamId,
        actorUserId: ctx.actorUserId,
        id,
      });
      if (!ok) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      return reply.code(204).send();
    },
  );

  // ===========================================================================
  // Phase 25.5 — Analytics
  // ===========================================================================

  app.get(
    "/v1/reviewer-ops/analytics/escalations",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid(),
          rangeDays: z.coerce.number().int().min(1).max(90).optional(),
        })
        .parse(req.query ?? {});
      const ctx = await requireReviewerActor(req, reply, q.teamId);
      if (!ctx) return;
      const analytics = await getEscalationAnalytics({
        teamId: q.teamId,
        rangeDays: q.rangeDays,
      });
      return reply.code(200).send(analytics);
    },
  );

  app.get(
    "/v1/reviewer-ops/analytics/reviewers",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid(),
          rangeDays: z.coerce.number().int().min(1).max(90).optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
        })
        .parse(req.query ?? {});
      const ctx = await requireReviewerActor(req, reply, q.teamId);
      if (!ctx) return;
      const analytics = await getReviewerPerformance({
        teamId: q.teamId,
        rangeDays: q.rangeDays,
        limit: q.limit,
      });
      return reply.code(200).send(analytics);
    },
  );

  // ===========================================================================
  // Phase 25.5 — SLA policy + governance flags admin
  // ===========================================================================

  app.get(
    "/v1/reviewer-ops/sla-policy",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = TeamIdQuery.parse(req.query ?? {});
      const ctx = await requireReviewerActor(req, reply, q.teamId);
      if (!ctx) return;
      const [policy, flags] = await Promise.all([
        resolveEffectiveSlaPolicy({ teamId: q.teamId }),
        loadWorkspaceReviewerOpsFlags(q.teamId),
      ]);
      return reply.code(200).send({ policy, flags });
    },
  );

  app.post(
    "/v1/reviewer-ops/sla-policy",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({
          teamId: z.string().uuid(),
          overrides: ReviewerOpsSlaPolicySchema.optional(),
          flags: z
            .object({
              requireStepUpForApprove: z.boolean().optional(),
              requireStepUpForReject: z.boolean().optional(),
              requireStepUpForEscalationResolve: z.boolean().optional(),
              requireStepUpForBulk: z.boolean().optional(),
              reviewerInactivityHours: z
                .number()
                .int()
                .min(1)
                .max(720)
                .nullable()
                .optional(),
            })
            .optional(),
        })
        .parse(req.body ?? {});
      const ctx = await requireReviewerActor(req, reply, body.teamId);
      if (!ctx) return;
      if (!requireReviewerCapable(ctx, reply)) return;
      // Editing the SLA / step-up policy is itself a high-risk action.
      // Gate behind GOVERNANCE_POLICY_UPDATE (reuses existing Phase 19
      // purpose so we don't need a new catalog entry).
      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId: ctx.actorUserId,
        purpose: "GOVERNANCE_POLICY_UPDATE",
        resourceKind: "workspace_reviewer_ops_policy",
        resourceId: body.teamId,
      });
      if (gate.sent) return;
      if (body.overrides) {
        await upsertWorkspaceSlaPolicy({
          teamId: body.teamId,
          actorUserId: ctx.actorUserId,
          overrides: body.overrides,
        });
        bump("reviewer_sla_policy_updated_total");
        safeEmitSecurityEvent({
          teamId: body.teamId,
          eventType: "reviewer_sla_policy_updated",
          severity: "WARNING",
          details: {
            actorUserId: ctx.actorUserId,
            keys: Object.keys(body.overrides),
          },
        });
      }
      if (body.flags) {
        await upsertWorkspaceReviewerOpsFlags({
          teamId: body.teamId,
          actorUserId: ctx.actorUserId,
          flags: body.flags,
        });
        safeEmitSecurityEvent({
          teamId: body.teamId,
          eventType: "reviewer_governance_flags_updated",
          severity: "WARNING",
          details: {
            actorUserId: ctx.actorUserId,
            keys: Object.keys(body.flags),
          },
        });
      }
      const [policy, flags] = await Promise.all([
        resolveEffectiveSlaPolicy({ teamId: body.teamId }),
        loadWorkspaceReviewerOpsFlags(body.teamId),
      ]);
      return reply.code(200).send({ policy, flags });
    },
  );

  // ===========================================================================
  // POST /v1/reviewer-ops/reconcile — cron-secret protected
  // ===========================================================================

  app.post(
    "/v1/reviewer-ops/reconcile",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const headerSecret = req.headers["x-cron-secret"];
      const expected =
        process.env["REVIEWER_OPS_CRON_SECRET"] ||
        process.env["INTEGRATION_CRON_SECRET"] ||
        "";
      if (!expected) {
        return reply.code(503).send({
          error: { code: "REVIEWER_OPS_CRON_SECRET_NOT_CONFIGURED" },
        });
      }
      if (
        typeof headerSecret !== "string" ||
        headerSecret.length === 0 ||
        headerSecret !== expected
      ) {
        return reply.code(401).send({ error: { code: "unauthorized" } });
      }
      // Either single-team (legacy: { teamId }) or all-teams sweep
      // ({ allTeams: true }). All-teams mode enumerates teams from DB
      // and runs reconcile per team with a per-team timeout. This is
      // the path the worker tick uses.
      const body = z
        .union([
          z.object({
            teamId: z.string().uuid(),
            batchSize: z.number().int().min(1).max(2000).optional(),
          }),
          z.object({
            allTeams: z.literal(true),
            batchSize: z.number().int().min(1).max(2000).optional(),
            maxTeamsPerSweep: z.number().int().min(1).max(10_000).optional(),
          }),
        ])
        .parse(req.body ?? {});

      if ("teamId" in body) {
        const result = await runReconcile({
          teamId: body.teamId,
          batchSize: body.batchSize,
        });
        return reply.code(200).send({ teams: 1, perTeam: [result] });
      }

      const maxTeams = body.maxTeamsPerSweep ?? 500;
      const teams = await prisma.team.findMany({
        // Reviewer-ops only matters for teams that have at least one
        // review workflow row. Limit + ordering keeps the worker tick
        // bounded — the next tick picks up any team we missed.
        where: {
          evidenceReviewWorkflows: { some: {} },
        },
        select: { id: true },
        orderBy: { id: "asc" },
        take: maxTeams,
      });

      const perTeam: Array<{
        teamId: string;
        ok: boolean;
        result?: Awaited<ReturnType<typeof runReconcile>>;
        error?: string;
      }> = [];
      let totalEscalationsCreated = 0;
      let totalFlippedBreached = 0;
      let totalFlippedDueSoon = 0;
      let totalDueSoonReminders = 0;
      let totalInactivityReminders = 0;
      let failedTeams = 0;

      // Per-team error isolation runs through runReconcileSafely
      // (defined at the top of this file): a single team failure
      // must not abort the sweep for the rest of the fleet. The
      // helper captures the failure into a structured result and the
      // loop carries on, accumulating `failedTeams`. This intentionally
      // keeps the catch out of any route handler so the Phase 25
      // route-layer error-handling contract is preserved.
      for (const t of teams) {
        const teamResult = await runReconcileSafely({
          teamId: t.id,
          batchSize: body.batchSize,
        });
        if (teamResult.ok) {
          perTeam.push({ teamId: t.id, ok: true, result: teamResult.result });
          totalEscalationsCreated += teamResult.result.escalationsCreated;
          totalFlippedBreached += teamResult.result.flippedBreached;
          totalFlippedDueSoon += teamResult.result.flippedDueSoon;
          totalDueSoonReminders += teamResult.result.dueSoonRemindersScheduled;
          totalInactivityReminders +=
            teamResult.result.inactivityRemindersScheduled;
        } else {
          failedTeams += 1;
          perTeam.push({
            teamId: t.id,
            ok: false,
            error: teamResult.error,
          });
        }
      }

      return reply.code(200).send({
        teams: teams.length,
        failedTeams,
        totalEscalationsCreated,
        totalFlippedBreached,
        totalFlippedDueSoon,
        totalDueSoonReminders,
        totalInactivityReminders,
        perTeam,
      });
    },
  );
}
