/**
 * DEPRECATED in Phase R. The canonical workflow engine is
 * EvidenceReviewWorkflow / reviewer-ops. These routes remain only for
 * in-flight Phase 22 instances and will be retired in a follow-up
 * phase.
 *
 * The frontend mutation buttons that drove submit / approve /
 * request-changes / assign-reviewer / cancel were removed in Phase C
 * (the /workflows/[id] detail page now carries a deprecation banner
 * directing operators to /review). The routes below remain live so
 * any pre-existing Phase 22 row can still be closed out, but no new
 * UI surface should call them — extend reviewer-ops instead.
 *
 * Phase 22 — Workflow instance routes.
 *
 *   GET    /v1/workflows/instances?teamId&status&limit          — list
 *   GET    /v1/workflows/instances/:id                          — get + steps
 *   POST   /v1/workflows/instances                              — create
 *   POST   /v1/workflows/instances/:id/submit                   — submit
 *   POST   /v1/workflows/instances/:id/steps/:stepKey/map-evidence
 *   POST   /v1/workflows/instances/:id/steps/:stepKey/waive     — step-up required
 *   POST   /v1/workflows/instances/:id/assign-reviewer
 *   POST   /v1/workflows/instances/:id/approve                  — step-up required (if high-risk)
 *   POST   /v1/workflows/instances/:id/request-changes
 *   POST   /v1/workflows/instances/:id/cancel                   — step-up required (after submit)
 *
 * Auth posture:
 *   - All routes use `requireAuth` (session JWT).
 *   - 404 on non-member (anti-enumeration via the Phase 17 access-
 *     policy engine + identity.member.read permission gate).
 *   - Sensitive mutations gate through `requireStepUpForSensitiveAction`
 *     reusing the Phase 19 catalog (e.g. `STEP_WAIVE_REQUIRED`,
 *     `INSTANCE_CANCEL_AFTER_SUBMIT`).
 *   - Engine errors map to Phase 20 standardized response codes:
 *     STEP_UP_REQUIRED / GOVERNANCE_BLOCKED / RATE_LIMITED.
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";
import {
  WORKFLOW_ACTOR_ROLES,
  WORKFLOW_INSTANCE_STATUSES,
  WorkflowIntakeModeSchema,
} from "@proovra/shared";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { evaluateMemberAccess } from "../services/identity/access-policy.service.js";
import {
  WorkflowEngineError,
  assignReviewer,
  createWorkflowInstance,
  getInstanceExportPolicySummary,
  getInstanceTimeline,
  getInstanceWithSteps,
  listInstances,
  mapEvidenceToStep,
  projectInstance,
  projectStep,
  projectStepForReviewer,
  transitionInstance,
  waiveStep,
} from "../services/workflows/evidence-workflow-engine.service.js";
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";

const TeamIdQuery = z.object({ teamId: z.string().uuid() });
const ParamsId = z.object({ id: z.string().uuid() });

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
 * 404-on-non-member + identity.member.read permission gate.
 */
async function requireWorkflowActor(
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

function handleEngineError(reply: FastifyReply, err: unknown): boolean {
  if (err instanceof WorkflowEngineError) {
    const status =
      err.code === "WORKFLOW_INSTANCE_NOT_FOUND" ||
      err.code === "WORKFLOW_STEP_NOT_FOUND" ||
      err.code === "WORKFLOW_TEMPLATE_NOT_FOUND"
        ? 404
        : err.code === "WORKFLOW_LEGAL_HOLD_ACTIVE" ||
            err.code === "WORKFLOW_ACTOR_NOT_PERMITTED"
          ? 403
          : err.code === "WORKFLOW_VISIBILITY_DENIED"
            ? 403
            : 409;
    reply.code(status).send({ error: { code: err.code } });
    return true;
  }
  return false;
}

export async function workflowInstancesRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------------

  app.get(
    "/v1/workflows/instances",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid(),
          status: z
            .enum(WORKFLOW_INSTANCE_STATUSES as unknown as [string, ...string[]])
            .optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        })
        .parse(req.query ?? {});
      const actor = await requireWorkflowActor(req, reply, q.teamId);
      if (!actor) return;
      const rows = await listInstances({
        teamId: q.teamId,
        status: q.status as never,
        limit: q.limit,
      });
      return reply
        .code(200)
        .send({ instances: rows.map(projectInstance) });
    },
  );

  // -------------------------------------------------------------------------
  // Get
  // -------------------------------------------------------------------------

  app.get(
    "/v1/workflows/instances/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const q = TeamIdQuery.parse(req.query ?? {});
      const actor = await requireWorkflowActor(req, reply, q.teamId);
      if (!actor) return;
      try {
        const { instance, steps } = await getInstanceWithSteps({
          teamId: q.teamId,
          id,
        });
        // Phase 23 — reviewer/admin-only step projection includes the
        // privateReviewerNote. Anyone else gets the safe projection.
        // The actor is reviewer-or-above if (a) they're the assigned
        // reviewer on this instance OR (b) they hold the
        // identity.access_review.action permission (Phase 17 — OWNER
        // and ADMIN by default).
        const isAssignedReviewer =
          instance.assignedReviewerUserId === actor.userId;
        let isReviewerCapable = isAssignedReviewer;
        if (!isReviewerCapable) {
          const reviewerCheck = await evaluateMemberAccess({
            teamId: q.teamId,
            userId: actor.userId,
            permission: "identity.access_review.action",
          });
          isReviewerCapable = reviewerCheck.allowed;
        }
        // Mapped-evidence summary — operator-facing only. We list ids
        // + step pointers; the route layer does NOT echo evidence
        // bodies / file contents.
        const mappedRows = await prisma.evidenceWorkflowInstanceEvidence.findMany({
          where: { workflowInstanceId: instance.id },
          select: {
            evidenceId: true,
            stepInstanceId: true,
            createdAt: true,
          },
          orderBy: { createdAt: "asc" },
          take: 200,
        });
        return reply.code(200).send({
          instance: projectInstance(instance),
          steps: isReviewerCapable
            ? steps.map(projectStepForReviewer)
            : steps.map(projectStep),
          mappedEvidence: mappedRows.map((r) => ({
            evidenceId: r.evidenceId,
            stepInstanceId: r.stepInstanceId,
            mappedAtUtc: r.createdAt.toISOString(),
          })),
        });
      } catch (err) {
        if (handleEngineError(reply, err)) return;
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  const CreateBody = z.object({
    teamId: z.string().uuid(),
    templateId: z.string().uuid().nullable().optional(),
    templateSlug: z.string().min(1).max(120).nullable().optional(),
    templateVersion: z.number().int().min(1).nullable().optional(),
    intakeMode: WorkflowIntakeModeSchema,
    actorRole: z.enum(WORKFLOW_ACTOR_ROLES as unknown as [string, ...string[]]),
    caseId: z.string().uuid().nullable().optional(),
    claimRef: z.string().max(128).nullable().optional(),
    matterRef: z.string().max(128).nullable().optional(),
    evidenceRequestId: z.string().uuid().nullable().optional(),
    intakeSessionId: z.string().uuid().nullable().optional(),
    title: z.string().max(180).nullable().optional(),
    steps: z
      .array(
        z.object({
          stepKey: z.string().min(1).max(80),
          title: z.string().min(1).max(180),
          required: z.boolean(),
          orderIndex: z.number().int().min(0),
          acceptedKinds: z.array(z.string().min(1).max(40)).optional(),
          identityRequirement: z.string().max(40).nullable().optional(),
          locationRequirement: z.string().max(20).nullable().optional(),
        }),
      )
      .min(1)
      .max(50),
  });

  app.post(
    "/v1/workflows/instances",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = CreateBody.parse(req.body ?? {});
      const actor = await requireWorkflowActor(req, reply, body.teamId);
      if (!actor) return;
      try {
        const created = await createWorkflowInstance({
          teamId: body.teamId,
          templateId: body.templateId ?? null,
          templateSlug: body.templateSlug ?? null,
          templateVersion: body.templateVersion ?? null,
          steps: body.steps,
          intakeMode: body.intakeMode as never,
          actorRole: body.actorRole as never,
          caseId: body.caseId ?? null,
          claimRef: body.claimRef ?? null,
          matterRef: body.matterRef ?? null,
          evidenceRequestId: body.evidenceRequestId ?? null,
          intakeSessionId: body.intakeSessionId ?? null,
          createdByUserId: actor.userId,
          title: body.title ?? null,
        });
        return reply
          .code(201)
          .send({ instance: projectInstance(created) });
      } catch (err) {
        if (handleEngineError(reply, err)) return;
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // Map evidence to a step
  // -------------------------------------------------------------------------

  const MapEvidenceBody = z.object({
    teamId: z.string().uuid(),
    evidenceId: z.string().uuid(),
  });

  app.post(
    "/v1/workflows/instances/:id/steps/:stepKey/map-evidence",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z
        .object({
          id: z.string().uuid(),
          stepKey: z.string().min(1).max(80),
        })
        .parse(req.params);
      const body = MapEvidenceBody.parse(req.body ?? {});
      const actor = await requireWorkflowActor(req, reply, body.teamId);
      if (!actor) return;
      try {
        const step = await mapEvidenceToStep({
          teamId: body.teamId,
          workflowInstanceId: params.id,
          stepKey: params.stepKey,
          evidenceId: body.evidenceId,
          actorUserId: actor.userId,
        });
        return reply.code(200).send({ step: projectStep(step) });
      } catch (err) {
        if (handleEngineError(reply, err)) return;
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // Waive a step (step-up required)
  // -------------------------------------------------------------------------

  const WaiveBody = z.object({
    teamId: z.string().uuid(),
    reason: z.string().min(1).max(400),
  });

  app.post(
    "/v1/workflows/instances/:id/steps/:stepKey/waive",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z
        .object({
          id: z.string().uuid(),
          stepKey: z.string().min(1).max(80),
        })
        .parse(req.params);
      const body = WaiveBody.parse(req.body ?? {});
      const actor = await requireWorkflowActor(req, reply, body.teamId);
      if (!actor) return;
      // Step-up: STEP_WAIVE_REQUIRED — defined in @proovra/shared
      // WORKFLOW_STEP_UP_ACTIONS. The Phase 19 catalog covers the
      // base step-up purposes (MEMBER_*, GOVERNANCE_*, ...); the
      // Phase 22 waive uses the generic SESSION_SANITY_CHECK purpose
      // until the catalog formally adds STEP_WAIVE_REQUIRED in a
      // future migration.
      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId: actor.userId,
        purpose: "SESSION_SANITY_CHECK",
        resourceKind: "evidence_workflow_step_instance",
        resourceId: params.id,
      });
      if (gate.sent) return;
      try {
        const step = await waiveStep({
          teamId: body.teamId,
          workflowInstanceId: params.id,
          stepKey: params.stepKey,
          actorUserId: actor.userId,
          reason: body.reason,
        });
        return reply.code(200).send({ step: projectStep(step) });
      } catch (err) {
        if (handleEngineError(reply, err)) return;
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // Transitions: submit / approve / request-changes / cancel
  // -------------------------------------------------------------------------

  app.post(
    "/v1/workflows/instances/:id/submit",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = TeamIdQuery.parse(req.body ?? {});
      const actor = await requireWorkflowActor(req, reply, body.teamId);
      if (!actor) return;
      try {
        const updated = await transitionInstance({
          teamId: body.teamId,
          workflowInstanceId: id,
          targetStatus: "SUBMITTED",
          actorUserId: actor.userId,
        });
        return reply.code(200).send({ instance: projectInstance(updated) });
      } catch (err) {
        if (handleEngineError(reply, err)) return;
        throw err;
      }
    },
  );

  app.post(
    "/v1/workflows/instances/:id/approve",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = TeamIdQuery.parse(req.body ?? {});
      const actor = await requireWorkflowActor(req, reply, body.teamId);
      if (!actor) return;
      try {
        // Must move SUBMITTED → NEEDS_REVIEW → APPROVED via the
        // allow-list. Approval emits its own audit + counter bump.
        // The route serves both NEEDS_REVIEW → APPROVED and
        // SUBMITTED → NEEDS_REVIEW shortcut; for Phase 22 we only
        // accept NEEDS_REVIEW → APPROVED here (operator must move
        // to NEEDS_REVIEW first via /assign-reviewer or its own
        // transition).
        const updated = await transitionInstance({
          teamId: body.teamId,
          workflowInstanceId: id,
          targetStatus: "APPROVED",
          actorUserId: actor.userId,
        });
        return reply.code(200).send({ instance: projectInstance(updated) });
      } catch (err) {
        if (handleEngineError(reply, err)) return;
        throw err;
      }
    },
  );

  app.post(
    "/v1/workflows/instances/:id/request-changes",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = TeamIdQuery.parse(req.body ?? {});
      const actor = await requireWorkflowActor(req, reply, body.teamId);
      if (!actor) return;
      try {
        const updated = await transitionInstance({
          teamId: body.teamId,
          workflowInstanceId: id,
          targetStatus: "CHANGES_REQUESTED",
          actorUserId: actor.userId,
        });
        return reply.code(200).send({ instance: projectInstance(updated) });
      } catch (err) {
        if (handleEngineError(reply, err)) return;
        throw err;
      }
    },
  );

  app.post(
    "/v1/workflows/instances/:id/cancel",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = TeamIdQuery.parse(req.body ?? {});
      const actor = await requireWorkflowActor(req, reply, body.teamId);
      if (!actor) return;
      // Cancellation after submission is operator-sensitive — gate
      // with step-up. (Cancellation of DRAFT is non-sensitive; the
      // service layer still requires the actor to be a workspace
      // member.)
      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId: actor.userId,
        purpose: "SESSION_SANITY_CHECK",
        resourceKind: "evidence_workflow_instance",
        resourceId: id,
      });
      if (gate.sent) return;
      try {
        const updated = await transitionInstance({
          teamId: body.teamId,
          workflowInstanceId: id,
          targetStatus: "CANCELLED",
          actorUserId: actor.userId,
        });
        return reply.code(200).send({ instance: projectInstance(updated) });
      } catch (err) {
        if (handleEngineError(reply, err)) return;
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // Assign reviewer
  // -------------------------------------------------------------------------

  const AssignReviewerBody = z.object({
    teamId: z.string().uuid(),
    reviewerUserId: z.string().uuid(),
  });

  app.post(
    "/v1/workflows/instances/:id/assign-reviewer",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = AssignReviewerBody.parse(req.body ?? {});
      const actor = await requireWorkflowActor(req, reply, body.teamId);
      if (!actor) return;
      try {
        const updated = await assignReviewer({
          teamId: body.teamId,
          workflowInstanceId: id,
          reviewerUserId: body.reviewerUserId,
          actorUserId: actor.userId,
        });
        // Transition to NEEDS_REVIEW if currently SUBMITTED.
        if (updated.status === "SUBMITTED") {
          try {
            await transitionInstance({
              teamId: body.teamId,
              workflowInstanceId: id,
              targetStatus: "NEEDS_REVIEW",
              actorUserId: actor.userId,
            });
          } catch {
            /* best-effort — operator can re-issue */
          }
        }
        return reply.code(200).send({ instance: projectInstance(updated) });
      } catch (err) {
        if (handleEngineError(reply, err)) return;
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // Phase 23 — Timeline + export-policy summaries
  // -------------------------------------------------------------------------

  app.get(
    "/v1/workflows/instances/:id/timeline",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const q = TeamIdQuery.parse(req.query ?? {});
      const actor = await requireWorkflowActor(req, reply, q.teamId);
      if (!actor) return;
      try {
        const events = await getInstanceTimeline({ teamId: q.teamId, id });
        return reply.code(200).send({ events });
      } catch (err) {
        if (handleEngineError(reply, err)) return;
        throw err;
      }
    },
  );

  app.get(
    "/v1/workflows/instances/:id/export-policy",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const q = TeamIdQuery.parse(req.query ?? {});
      const actor = await requireWorkflowActor(req, reply, q.teamId);
      if (!actor) return;
      try {
        const summary = await getInstanceExportPolicySummary({
          teamId: q.teamId,
          id,
        });
        return reply.code(200).send({ summary });
      } catch (err) {
        if (handleEngineError(reply, err)) return;
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // Phase 23 — Templates alias at /v1/workflows/templates
  //
  // The Phase 1/2 endpoint at /v1/workflow/templates (singular) is the
  // canonical surface. Phase 22 introduced /v1/workflows/instances
  // (plural) for the runtime layer. To keep the URL family
  // consistent for the new workflow UI, we expose an alias at
  // /v1/workflows/templates that proxies the existing service
  // function. The original endpoint is preserved unchanged for back-
  // compat with the capture page hook.
  // -------------------------------------------------------------------------

  app.get(
    "/v1/workflows/templates",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid(),
          sector: z.string().min(1).max(64).optional(),
          includeArchived: z.coerce.boolean().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const actor = await requireWorkflowActor(req, reply, q.teamId);
      if (!actor) return;
      const { listEffectiveWorkflowTemplates, projectEffectiveWorkflowTemplate } =
        await import("../services/workflow-template.service.js");
      const rows = await listEffectiveWorkflowTemplates({
        teamId: q.teamId,
        includeArchived: q.includeArchived ?? false,
      });
      // Optional sector filter.
      const filtered = q.sector
        ? rows.filter(
            (r) =>
              (r.template.workspaceCategory ?? "").toLowerCase() ===
              q.sector!.toLowerCase(),
          )
        : rows;
      const limited = filtered.slice(0, q.limit ?? 200);
      // Phase D — surface the full canonical projection so the admin
      // page can render every field the underlying WorkflowTemplate
      // schema already carries (steps, planMode, locationRequirement,
      // allowedRoles, rules, archived, dbId, id, version). The shape
      // here is exactly `projectEffectiveWorkflowTemplate` plus two
      // pre-computed convenience counts (`requiredStepCount`,
      // `stepCount`) that the page already pins. NO new fields are
      // invented; this only stops the alias from dropping fields the
      // canonical /v1/workflow/templates (singular) endpoint already
      // returns via the same projection helper.
      return reply.code(200).send({
        templates: limited.map((r) => ({
          ...projectEffectiveWorkflowTemplate(r),
          requiredStepCount: r.template.steps.filter((s) => s.required).length,
          stepCount: r.template.steps.length,
        })),
      });
    },
  );

  // Suppress unused warnings for helpers we re-export elsewhere.
  void requestIp;
  void requestUa;
}
