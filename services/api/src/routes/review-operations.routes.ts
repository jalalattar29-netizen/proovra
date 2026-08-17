/**
 * Phase 13 — Enterprise review operations routes.
 *
 *   GET   /v1/review-operations/queue                            — list workflows
 *   GET   /v1/review-operations/queue-counts                      — counts
 *   POST  /v1/review-operations/evidence/:evidenceId/claim        — self-claim
 *   POST  /v1/review-operations/evidence/:evidenceId/decision     — log decision
 *   POST  /v1/review-operations/bulk                              — bulk action
 *   POST  /v1/review-operations/reconcile-slas                    — cron SLA sweep
 *
 * Every route is workspace-scoped via `requireMember` + the
 * `evidence_request.review` permission (the canonical reviewer
 * permission). 404 on non-members so role enumeration is impossible.
 *
 * Service accounts are NOT permitted to perform human review decisions
 * — the routes require an authenticated user session.
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";
import {
  REVIEW_DECISION_TYPES,
  REVIEW_SLA_STATUSES,
  REVIEW_STAGES,
} from "@proovra/shared";

import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorizeOrFail } from "../middleware/authorize.js";
import { requireIntegrationCronSecret } from "../middleware/cron-secret.js";
import {
  ReviewOperationError,
  bulkReviewAction,
  claimReviewerWorkflow,
  getReviewQueueCounts,
  listReviewQueue,
  projectReviewWorkflow,
  reconcileReviewSlas,
  recordLifecycleTransition,
} from "../services/review-operations/review-operations.service.js";
// Track 1C — canonical review-decision authority. Reviewer VERDICTS
// (approve / reject / request-info) append an immutable
// WorkflowReviewDecision row AND derive the workflow.status projection
// in one transaction. Lifecycle routing (escalate / reopen / close)
// stays on the Phase 13 lifecycle service above.
import {
  ReviewDecisionAuthorityError,
  recordReviewDecision,
} from "../services/reviewer-ops/review-decision.service.js";
// Phase C0 — Sensitive review decision step-up enforcement.
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";
import type { StepUpPurpose } from "@proovra/shared";
import { loadWorkspaceReviewerOpsFlags } from "../services/reviewer-ops/sla-policy.service.js";

const ParamsEvidenceId = z.object({ evidenceId: z.string().uuid() });

/**
 * PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — canonical reviewer gate.
 * Routes through authorizeOrFail (ACTIVE membership + org lifecycle +
 * `evidence_request.review` capability + fail-closed + anti-enumeration 404).
 * Previously status-blind (`if (!membership)` + role-only requirePermission).
 */
async function requireReviewerMember(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<{ userId: string } | null> {
  const outcome = await authorizeOrFail(req, reply, {
    teamId,
    permission: "evidence_request.review",
    antiEnumeration: true,
  });
  return outcome ? { userId: outcome.actorUserId } : null;
}

/**
 * PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — canonical admin gate.
 * Enforces ACTIVE membership + org lifecycle + fail-closed + anti-enumeration
 * via the canonical primitive, THEN preserves the stricter OWNER/ADMIN-only
 * restriction (no single admin-exclusive permission exists in the vocabulary,
 * so the role check remains, reading role from an informational lookup).
 */
async function requireAdminMember(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<{ userId: string } | null> {
  const outcome = await authorizeOrFail(req, reply, {
    teamId,
    permission: "evidence_request.review",
    antiEnumeration: true,
  });
  if (!outcome) return null;
  // Informational role read (authorization already enforced above); the
  // OWNER/ADMIN restriction is stricter than the reviewer permission.
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId: outcome.actorUserId } },
  });
  if (!membership || (membership.role !== "OWNER" && membership.role !== "ADMIN")) {
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  return { userId: outcome.actorUserId };
}

function reviewErrorToReply(err: unknown, reply: FastifyReply): void {
  // Track 1C — canonical decision-authority error surface. Conflicts
  // (stale / already-resolved / duplicate / independence violations)
  // are 409; a missing rationale is 422; anti-enumeration not-found is
  // 404. NEVER 403 (anti-enumeration posture of this route file).
  if (err instanceof ReviewDecisionAuthorityError) {
    const status =
      err.code === "workflow_not_found"
        ? 404
        : err.code === "rationale_required"
          ? 422
          : 409;
    reply.code(status).send({
      error: { code: err.code, details: err.details ?? null },
    });
    return;
  }
  if (err instanceof ReviewOperationError) {
    const status =
      err.code === "workflow_not_found" || err.code === "evidence_not_in_workspace"
        ? 404
        : err.code === "invalid_stage_transition"
          ? 409
          : err.code === "note_required"
            ? 422
            : err.code === "permission_denied"
              ? 403
              : err.code === "already_assigned_elsewhere"
                ? 409
                : 400;
    reply.code(status).send({
      error: { code: err.code, details: err.details ?? null },
    });
    return;
  }
  reply.code(500).send({ error: { code: "internal_error" } });
}

export async function reviewOperationsRoutes(app: FastifyInstance) {
  app.get(
    "/v1/review-operations/queue",
    { preHandler: requireAuth },
    async (req, reply) => {
      const query = z
        .object({
          teamId: z.string().uuid(),
          stage: z.enum(REVIEW_STAGES).optional(),
          slaStatus: z.enum(REVIEW_SLA_STATUSES).optional(),
          assignedToUserId: z.string().uuid().optional(),
          unassigned: z.union([z.literal("true"), z.literal("false")]).optional(),
          priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).optional(),
          escalated: z.union([z.literal("true"), z.literal("false")]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const ok = await requireReviewerMember(req, reply, query.teamId);
      if (!ok) return;
      const rows = await listReviewQueue({
        teamId: query.teamId,
        stage: query.stage,
        slaStatus: query.slaStatus,
        assignedToUserId: query.assignedToUserId,
        unassigned: query.unassigned === "true",
        priority: query.priority,
        escalated: query.escalated === "true",
        limit: query.limit,
      });
      return reply
        .code(200)
        .send({ workflows: rows.map(projectReviewWorkflow) });
    },
  );

  app.get(
    "/v1/review-operations/queue-counts",
    { preHandler: requireAuth },
    async (req, reply) => {
      const query = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ok = await requireReviewerMember(req, reply, query.teamId);
      if (!ok) return;
      const counts = await getReviewQueueCounts({
        teamId: query.teamId,
        meUserId: ok.userId,
      });
      return reply.code(200).send({ counts });
    },
  );

  app.post(
    "/v1/review-operations/evidence/:evidenceId/claim",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { evidenceId } = ParamsEvidenceId.parse(req.params);
      const body = z
        .object({ teamId: z.string().uuid() })
        .parse(req.body ?? {});
      const ok = await requireReviewerMember(req, reply, body.teamId);
      if (!ok) return;
      const workflow = await prisma.evidenceReviewWorkflow.findUnique({
        where: { evidenceId },
        select: { teamId: true },
      });
      if (!workflow || workflow.teamId !== body.teamId) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      try {
        const updated = await claimReviewerWorkflow({
          evidenceId,
          actorUserId: ok.userId,
        });
        return reply
          .code(200)
          .send({ workflow: projectReviewWorkflow(updated) });
      } catch (err) {
        return reviewErrorToReply(err, reply);
      }
    },
  );

  app.post(
    "/v1/review-operations/evidence/:evidenceId/decision",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { evidenceId } = ParamsEvidenceId.parse(req.params);
      const body = z
        .object({
          // PHASE 12 POINT 4 PASS C1 — OPTIONAL. The workspace subject is
          // DERIVED from the workflow row, not asserted by the caller; when
          // a client still sends one it must match, and a mismatch is
          // concealed as not-found rather than described. This removes the
          // last reason for the review surfaces to hold a tenant id.
          teamId: z.string().uuid().optional(),
          decision: z.enum(REVIEW_DECISION_TYPES),
          note: z.string().max(2000).nullable().optional(),
          escalationReason: z.string().max(400).nullable().optional(),
        })
        .parse(req.body ?? {});
      const workflow = await prisma.evidenceReviewWorkflow.findUnique({
        where: { evidenceId },
        select: { id: true, teamId: true },
      });
      if (
        !workflow ||
        !workflow.teamId ||
        (body.teamId && workflow.teamId !== body.teamId)
      ) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      // The authorization subject is the persisted workspace of the record.
      const teamId = workflow.teamId;
      const ok = await requireReviewerMember(req, reply, teamId);
      if (!ok) return;

      // Phase C0 — Sensitive reviewer decision step-up gate. When
      // the workspace governance flag for the chosen decision is
      // set (`requireStepUpForApprove` / `requireStepUpForReject`),
      // the request must carry a fresh step-up token for the
      // matching purpose. Mirrors the existing gate on the
      // `/v1/reviewer-ops/*` workflow surface. When the flag is
      // off, this is a no-op and the request proceeds.
      //
      // Decision-to-gate mapping uses the canonical Phase 13
      // decision vocabulary (`APPROVE_INTERNAL`, `REJECT_INSUFFICIENT`,
      // etc.). The two terminal-trust decisions are the ones
      // protected: any "internal approval" or "insufficient
      // rejection" carries enough operational weight to warrant
      // the step-up gate when the workspace opts in.
      const stepUpGateKey: "approve" | "reject" | null =
        body.decision === "APPROVE_INTERNAL"
          ? "approve"
          : body.decision === "REJECT_INSUFFICIENT"
            ? "reject"
            : null;
      if (stepUpGateKey) {
        const flags = await loadWorkspaceReviewerOpsFlags(teamId);
        const flagKey =
          stepUpGateKey === "approve"
            ? "requireStepUpForApprove"
            : "requireStepUpForReject";
        if (flags[flagKey]) {
          const purpose: StepUpPurpose =
            stepUpGateKey === "approve"
              ? "REVIEW_APPROVAL_HIGH_RISK"
              : "REVIEWER_OPS_REJECT";
          const result = await requireStepUpForSensitiveAction({
            req,
            reply,
            teamId: teamId,
            userId: ok.userId,
            purpose,
            resourceKind: "evidence_review_decision",
            resourceId: evidenceId,
          });
          if (result.sent) return;
        }
      }

      try {
        let updated;
        if (
          body.decision === "APPROVE_INTERNAL" ||
          body.decision === "REJECT_INSUFFICIENT" ||
          body.decision === "REQUEST_MORE_INFO"
        ) {
          // Track 1C — reviewer VERDICT: the canonical decision
          // authority appends the immutable decision row + derives the
          // status projection atomically. Adjudicator authority is an
          // informational role read (authorization already enforced by
          // requireReviewerMember above).
          const membership = await prisma.teamMember.findUnique({
            where: {
              teamId_userId: { teamId: teamId, userId: ok.userId },
            },
            select: { role: true },
          });
          const result = await recordReviewDecision({
            workflowId: workflow.id,
            teamId: teamId,
            actorUserId: ok.userId,
            decision:
              body.decision === "APPROVE_INTERNAL"
                ? "APPROVE"
                : body.decision === "REJECT_INSUFFICIENT"
                  ? "REJECT"
                  : "REQUEST_INFO",
            rationale: body.note ?? body.escalationReason ?? null,
            actorIsAdjudicator:
              membership?.role === "OWNER" || membership?.role === "ADMIN",
          });
          updated = result.workflow;
        } else {
          // ESCALATE / REOPEN / CLOSE — lifecycle routing, not a
          // verdict; handled by the Phase 13 lifecycle service.
          updated = await recordLifecycleTransition({
            evidenceId,
            decision: body.decision,
            actorUserId: ok.userId,
            note: body.note ?? null,
            escalationReason: body.escalationReason ?? null,
          });
        }
        return reply
          .code(200)
          .send({ workflow: projectReviewWorkflow(updated) });
      } catch (err) {
        return reviewErrorToReply(err, reply);
      }
    },
  );

  app.post(
    "/v1/review-operations/bulk",
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = z
        .object({
          teamId: z.string().uuid(),
          evidenceIds: z.array(z.string().uuid()).min(1).max(200),
          action: z.enum([
            "ASSIGN",
            "MARK_IN_REVIEW",
            "ESCALATE",
            "CLOSE",
            "REQUEST_MORE_INFO",
          ]),
          assignedToUserId: z.string().uuid().optional(),
          note: z.string().max(2000).nullable().optional(),
        })
        .parse(req.body ?? {});

      const ok =
        body.action === "ASSIGN"
          ? await requireAdminMember(req, reply, body.teamId)
          : await requireReviewerMember(req, reply, body.teamId);
      if (!ok) return;

      try {
        const result = await bulkReviewAction({
          teamId: body.teamId,
          evidenceIds: body.evidenceIds,
          actorUserId: ok.userId,
          action: body.action,
          assignedToUserId: body.assignedToUserId,
          note: body.note ?? null,
        });
        return reply.code(200).send({ result });
      } catch (err) {
        return reviewErrorToReply(err, reply);
      }
    },
  );

  // Cron-protected SLA reconciliation sweep.
  app.post(
    "/v1/review-operations/reconcile-slas",
    async (req, reply) => {
      const ok = await requireIntegrationCronSecret(req, reply);
      if (!ok) return;
      const body = z
        .object({
          teamId: z.string().uuid().optional(),
          batchSize: z.number().int().min(1).max(2000).optional(),
        })
        .parse(req.body ?? {});
      const summary = await reconcileReviewSlas({
        teamId: body.teamId,
        batchSize: body.batchSize,
      });
      return reply.code(200).send({ summary });
    },
  );
}
