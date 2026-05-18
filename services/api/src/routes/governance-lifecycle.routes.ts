/**
 * Phase 27 — Governance Lifecycle routes.
 *
 *   Retention policies:
 *     GET    /v1/governance/retention-policies?teamId&status&scope
 *     POST   /v1/governance/retention-policies                 (ADMIN+)
 *     PATCH  /v1/governance/retention-policies/:id             (ADMIN+)
 *     POST   /v1/governance/retention-policies/:id/transition  (ADMIN+)
 *     GET    /v1/governance/retention-policies/:id/versions
 *     GET    /v1/governance/retention-policies/effective       (resolver)
 *
 *   Destruction queue:
 *     GET    /v1/governance/destruction-reviews?teamId&status
 *     POST   /v1/governance/destruction-reviews                (ADMIN+ create)
 *     GET    /v1/governance/destruction-reviews/:id
 *     POST   /v1/governance/destruction-reviews/:id/transition (ADMIN+ + step-up on APPROVED/EXECUTED)
 *
 *   Lifecycle:
 *     GET    /v1/governance/lifecycle/evidence/:id/events?teamId
 *     POST   /v1/governance/lifecycle/evidence/:id/transition  (ADMIN+ + step-up on PENDING_DESTRUCTION/DESTROYED)
 *
 *   Export gate:
 *     GET    /v1/governance/export-eligibility?teamId&evidenceId
 *
 *   Dashboard aggregate:
 *     GET    /v1/governance/dashboard?teamId
 *
 * Every mutating route checks workspace membership + the canonical
 * permission. Hold-affecting and destruction routes additionally
 * require step-up. NEVER returns privileged legal text — the routes
 * project the data via the service `project*` helpers, which strip
 * fields the dashboards must not see.
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../services/governance.service.js";
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";

import {
  RetentionEngineError,
  countActivePolicyConflicts,
  createRetentionPolicy,
  listPolicyVersions,
  listRetentionPolicies,
  resolveEffectiveRetentionPolicy,
  transitionRetentionPolicy,
  updateRetentionPolicy,
} from "../services/governance-lifecycle/retention-engine.service.js";
import {
  DestructionReviewError,
  countActiveDestructionReviews,
  countPendingDestructionByEvidence,
  createDestructionReview,
  getDestructionReview,
  listDestructionReviews,
  transitionDestructionReview,
} from "../services/governance-lifecycle/destruction-review.service.js";
import {
  LifecycleOrchestratorError,
  countByLifecycleState,
  listLifecycleEvents,
  transitionLifecycle,
} from "../services/governance-lifecycle/lifecycle-orchestrator.service.js";
import { checkExportEligibility } from "../services/governance-lifecycle/export-governance.service.js";
import {
  DESTRUCTION_REVIEW_REASONS,
  DESTRUCTION_REVIEW_STATUSES,
  EVIDENCE_LIFECYCLE_STATES,
  RETENTION_POLICY_SCOPES,
  RETENTION_POLICY_STATUSES,
} from "@proovra/shared";

const ParamsId = z.object({ id: z.string().uuid() });

async function requireMember(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<{ userId: string; role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" } | null> {
  const userId = getAuthUserId(req);
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
  });
  if (!membership) {
    reply.code(403).send({ message: "Not a member of the workspace" });
    return null;
  }
  return { userId, role: membership.role };
}

function denyByPermission(reply: FastifyReply, reason: string): void {
  reply.code(403).send({
    error: { code: "permission_denied", reason },
  });
}

function mapRetentionError(reply: FastifyReply, err: RetentionEngineError) {
  const code = err.code;
  if (code === "RETENTION_POLICY_NOT_FOUND") {
    return reply.code(404).send({ error: { code } });
  }
  if (code === "RETENTION_POLICY_DUPLICATE") {
    return reply.code(409).send({ error: { code } });
  }
  if (code === "RETENTION_POLICY_TERMINAL") {
    return reply.code(409).send({ error: { code, details: err.details } });
  }
  return reply.code(400).send({ error: { code, details: err.details } });
}

function mapDestructionError(
  reply: FastifyReply,
  err: DestructionReviewError,
) {
  const code = err.code;
  if (code === "DESTRUCTION_REVIEW_NOT_FOUND") {
    return reply.code(404).send({ error: { code } });
  }
  if (code === "DESTRUCTION_REVIEW_ACTIVE") {
    return reply.code(409).send({ error: { code, details: err.details } });
  }
  if (code === "DESTRUCTION_REVIEW_TERMINAL") {
    return reply.code(409).send({ error: { code, details: err.details } });
  }
  if (
    code === "DESTRUCTION_REVIEW_BLOCKED_BY_HOLD" ||
    code === "DESTRUCTION_REVIEW_BLOCKED_BY_IMMUTABLE" ||
    code === "DESTRUCTION_REVIEW_BLOCKED_BY_LIFECYCLE"
  ) {
    return reply.code(409).send({ error: { code, details: err.details } });
  }
  return reply.code(400).send({ error: { code, details: err.details } });
}

function mapLifecycleError(
  reply: FastifyReply,
  err: LifecycleOrchestratorError,
) {
  const code = err.code;
  if (code === "LIFECYCLE_EVIDENCE_NOT_FOUND") {
    return reply.code(404).send({ error: { code } });
  }
  if (
    code === "LIFECYCLE_BLOCKED_BY_HOLD" ||
    code === "LIFECYCLE_BLOCKED_BY_IMMUTABLE" ||
    code === "LIFECYCLE_TERMINAL_STATE"
  ) {
    return reply.code(409).send({ error: { code, details: err.details } });
  }
  return reply.code(400).send({ error: { code, details: err.details } });
}

export async function governanceLifecycleRoutes(app: FastifyInstance) {
  // ===========================================================================
  // Retention policies
  // ===========================================================================

  app.get(
    "/v1/governance/retention-policies",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = z
        .object({
          teamId: z.string().uuid(),
          status: z.enum([...RETENTION_POLICY_STATUSES, "ALL"]).optional(),
          scope: z.enum(RETENTION_POLICY_SCOPES).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "governance.policy.read");
      if (!perm.allowed) return denyByPermission(reply, perm.reason);
      const policies = await listRetentionPolicies({
        teamId: query.teamId,
        status: query.status as never,
        scope: query.scope,
        limit: query.limit,
      });
      return reply.code(200).send({ policies });
    },
  );

  app.post(
    "/v1/governance/retention-policies",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({
          teamId: z.string().uuid(),
          displayName: z.string().min(1).max(180),
          description: z.string().max(2000).nullable().optional(),
          scope: z.enum(RETENTION_POLICY_SCOPES),
          scopeQualifier: z.string().min(1).max(40).nullable().optional(),
          caseId: z.string().uuid().nullable().optional(),
          retentionDays: z.number().int().min(0).max(36500).nullable().optional(),
          immutable: z.boolean().optional(),
          autoExtensionEnabled: z.boolean().optional(),
          autoExtensionDays: z.number().int().min(1).max(36500).nullable().optional(),
          changeNote: z.string().min(1).max(2000).optional(),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "governance.policy.manage");
      if (!perm.allowed) return denyByPermission(reply, perm.reason);
      const gate = await requireStepUpForSensitiveAction({
        req, reply,
        teamId: body.teamId,
        userId: ok.userId,
        purpose: "RETENTION_POLICY_UPDATE",
        resourceKind: "evidence_retention_policy",
        resourceId: body.teamId,
      });
      if (gate.sent) return;
      try {
        const policy = await createRetentionPolicy({
          ...body,
          actorUserId: ok.userId,
        });
        return reply.code(201).send({ policy });
      } catch (err) {
        if (err instanceof RetentionEngineError)
          return mapRetentionError(reply, err);
        throw err;
      }
    },
  );

  app.patch(
    "/v1/governance/retention-policies/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          displayName: z.string().min(1).max(180).optional(),
          description: z.string().max(2000).nullable().optional(),
          retentionDays: z.number().int().min(0).max(36500).nullable().optional(),
          immutable: z.boolean().optional(),
          autoExtensionEnabled: z.boolean().optional(),
          autoExtensionDays: z.number().int().min(1).max(36500).nullable().optional(),
          changeNote: z.string().min(1).max(2000),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "governance.policy.manage");
      if (!perm.allowed) return denyByPermission(reply, perm.reason);
      const gate = await requireStepUpForSensitiveAction({
        req, reply,
        teamId: body.teamId,
        userId: ok.userId,
        purpose: "RETENTION_POLICY_UPDATE",
        resourceKind: "evidence_retention_policy",
        resourceId: id,
      });
      if (gate.sent) return;
      try {
        const policy = await updateRetentionPolicy({
          ...body,
          id,
          actorUserId: ok.userId,
        });
        return reply.code(200).send({ policy });
      } catch (err) {
        if (err instanceof RetentionEngineError)
          return mapRetentionError(reply, err);
        throw err;
      }
    },
  );

  app.post(
    "/v1/governance/retention-policies/:id/transition",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          nextStatus: z.enum(RETENTION_POLICY_STATUSES),
          supersededByPolicyId: z.string().uuid().nullable().optional(),
          changeNote: z.string().min(1).max(2000),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "governance.policy.manage");
      if (!perm.allowed) return denyByPermission(reply, perm.reason);
      const gate = await requireStepUpForSensitiveAction({
        req, reply,
        teamId: body.teamId,
        userId: ok.userId,
        purpose: "RETENTION_POLICY_UPDATE",
        resourceKind: "evidence_retention_policy",
        resourceId: id,
      });
      if (gate.sent) return;
      try {
        const policy = await transitionRetentionPolicy({
          ...body,
          id,
          actorUserId: ok.userId,
        });
        return reply.code(200).send({ policy });
      } catch (err) {
        if (err instanceof RetentionEngineError)
          return mapRetentionError(reply, err);
        throw err;
      }
    },
  );

  app.get(
    "/v1/governance/retention-policies/:id/versions",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const query = z
        .object({
          teamId: z.string().uuid(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "governance.policy.read");
      if (!perm.allowed) return denyByPermission(reply, perm.reason);
      try {
        const versions = await listPolicyVersions({
          teamId: query.teamId,
          id,
          limit: query.limit,
        });
        return reply.code(200).send({ versions });
      } catch (err) {
        if (err instanceof RetentionEngineError)
          return mapRetentionError(reply, err);
        throw err;
      }
    },
  );

  app.get(
    "/v1/governance/retention-policies/effective",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = z
        .object({
          teamId: z.string().uuid(),
          evidenceType: z.string().min(1).max(40).optional(),
          caseId: z.string().uuid().optional(),
          jurisdiction: z.string().min(1).max(40).optional(),
        })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "governance.policy.read");
      if (!perm.allowed) return denyByPermission(reply, perm.reason);
      const decision = await resolveEffectiveRetentionPolicy({
        teamId: query.teamId,
        evidenceType: query.evidenceType ?? null,
        caseId: query.caseId ?? null,
        jurisdiction: query.jurisdiction ?? null,
      });
      return reply.code(200).send(decision);
    },
  );

  // ===========================================================================
  // Destruction reviews
  // ===========================================================================

  app.get(
    "/v1/governance/destruction-reviews",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = z
        .object({
          teamId: z.string().uuid(),
          status: z
            .enum([...DESTRUCTION_REVIEW_STATUSES, "ACTIVE", "ALL"])
            .optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "governance.policy.read");
      if (!perm.allowed) return denyByPermission(reply, perm.reason);
      const reviews = await listDestructionReviews({
        teamId: query.teamId,
        status: query.status as never,
        limit: query.limit,
      });
      return reply.code(200).send({ reviews });
    },
  );

  app.post(
    "/v1/governance/destruction-reviews",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({
          teamId: z.string().uuid(),
          evidenceId: z.string().uuid(),
          reason: z.enum(DESTRUCTION_REVIEW_REASONS),
          retentionPolicyId: z.string().uuid().nullable().optional(),
          retentionPolicyVersion: z.number().int().min(1).nullable().optional(),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "evidence.delete");
      if (!perm.allowed) return denyByPermission(reply, perm.reason);
      try {
        const review = await createDestructionReview({
          ...body,
          actorUserId: ok.userId,
          requestId: req.id,
        });
        return reply.code(201).send({ review });
      } catch (err) {
        if (err instanceof DestructionReviewError)
          return mapDestructionError(reply, err);
        throw err;
      }
    },
  );

  app.get(
    "/v1/governance/destruction-reviews/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const query = z.object({ teamId: z.string().uuid() }).parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "governance.policy.read");
      if (!perm.allowed) return denyByPermission(reply, perm.reason);
      try {
        const review = await getDestructionReview({ teamId: query.teamId, id });
        return reply.code(200).send({ review });
      } catch (err) {
        if (err instanceof DestructionReviewError)
          return mapDestructionError(reply, err);
        throw err;
      }
    },
  );

  app.post(
    "/v1/governance/destruction-reviews/:id/transition",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          nextStatus: z.enum(DESTRUCTION_REVIEW_STATUSES),
          decisionNote: z.string().min(1).max(2000).nullable().optional(),
          deferredUntilUtc: z.string().datetime().nullable().optional(),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "evidence.delete");
      if (!perm.allowed) return denyByPermission(reply, perm.reason);
      // Step-up required for APPROVED + EXECUTED (the destructive
      // branches). The other transitions are operator-recoverable.
      if (body.nextStatus === "APPROVED" || body.nextStatus === "EXECUTED") {
        const gate = await requireStepUpForSensitiveAction({
          req, reply,
          teamId: body.teamId,
          userId: ok.userId,
          purpose:
            body.nextStatus === "APPROVED"
              ? "EVIDENCE_DESTRUCTION_APPROVE"
              : "EVIDENCE_DESTRUCTION_EXECUTE",
          resourceKind: "destruction_review",
          resourceId: id,
        });
        if (gate.sent) return;
      }
      try {
        const review = await transitionDestructionReview({
          teamId: body.teamId,
          id,
          actorUserId: ok.userId,
          nextStatus: body.nextStatus,
          decisionNote: body.decisionNote ?? null,
          deferredUntilUtc: body.deferredUntilUtc
            ? new Date(body.deferredUntilUtc)
            : null,
          requestId: req.id,
        });
        return reply.code(200).send({ review });
      } catch (err) {
        if (err instanceof DestructionReviewError)
          return mapDestructionError(reply, err);
        if (err instanceof LifecycleOrchestratorError)
          return mapLifecycleError(reply, err);
        throw err;
      }
    },
  );

  // ===========================================================================
  // Lifecycle events
  // ===========================================================================

  app.get(
    "/v1/governance/lifecycle/evidence/:id/events",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const query = z
        .object({
          teamId: z.string().uuid(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "governance.policy.read");
      if (!perm.allowed) return denyByPermission(reply, perm.reason);
      const events = await listLifecycleEvents({
        teamId: query.teamId,
        evidenceId: id,
        limit: query.limit,
      });
      return reply.code(200).send({ events });
    },
  );

  app.post(
    "/v1/governance/lifecycle/evidence/:id/transition",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          toState: z.enum(EVIDENCE_LIFECYCLE_STATES),
          summary: z.string().min(1).max(400),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;
      // Manual lifecycle transition is an ADMIN action — direct manipulation
      // of state machine pointers must be permission-gated and audited.
      const perm = requirePermission(ok.role, "governance.policy.manage");
      if (!perm.allowed) return denyByPermission(reply, perm.reason);
      // Step-up required when entering destruction or terminal states.
      if (body.toState === "PENDING_DESTRUCTION" || body.toState === "DESTROYED") {
        const gate = await requireStepUpForSensitiveAction({
          req, reply,
          teamId: body.teamId,
          userId: ok.userId,
          purpose: "EVIDENCE_LIFECYCLE_FORCE",
          resourceKind: "evidence",
          resourceId: id,
        });
        if (gate.sent) return;
      }
      try {
        const result = await transitionLifecycle({
          teamId: body.teamId,
          evidenceId: id,
          toState: body.toState,
          actorUserId: ok.userId,
          summary: body.summary,
          requestId: req.id,
        });
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof LifecycleOrchestratorError)
          return mapLifecycleError(reply, err);
        throw err;
      }
    },
  );

  // ===========================================================================
  // Export eligibility
  // ===========================================================================

  app.get(
    "/v1/governance/export-eligibility",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = z
        .object({
          teamId: z.string().uuid(),
          evidenceId: z.string().uuid(),
        })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;
      // Reading the eligibility decision is an authenticated, member-only
      // signal — same permission level as governance.policy.read.
      const perm = requirePermission(ok.role, "governance.policy.read");
      if (!perm.allowed) return denyByPermission(reply, perm.reason);
      const result = await checkExportEligibility({
        teamId: query.teamId,
        evidenceId: query.evidenceId,
        actorUserId: ok.userId,
      });
      return reply.code(200).send(result);
    },
  );

  // ===========================================================================
  // Dashboard aggregate
  // ===========================================================================

  app.get(
    "/v1/governance/dashboard",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = z.object({ teamId: z.string().uuid() }).parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "governance.policy.read");
      if (!perm.allowed) return denyByPermission(reply, perm.reason);

      const [byLifecycleState, activeReviewCount, pendingDestructionCount, conflictCount, activePoliciesCount, activeHoldsCount] =
        await Promise.all([
          countByLifecycleState(query.teamId),
          countActiveDestructionReviews(query.teamId),
          countPendingDestructionByEvidence(query.teamId),
          countActivePolicyConflicts(query.teamId),
          prisma.evidenceRetentionPolicy.count({
            where: { teamId: query.teamId, status: "ACTIVE" },
          }),
          prisma.evidenceLegalHold.count({
            where: { teamId: query.teamId, status: "ACTIVE" },
          }),
        ]);

      return reply.code(200).send({
        lifecycle: {
          byState: byLifecycleState,
          pendingDestructionCount,
        },
        destruction: {
          activeReviewCount,
        },
        retention: {
          activePoliciesCount,
          conflictCount,
        },
        holds: {
          activeHoldsCount,
        },
      });
    },
  );
}
