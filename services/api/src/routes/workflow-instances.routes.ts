/**
 * DEPRECATED in Phase R. The canonical workflow engine is
 * EvidenceReviewWorkflow / reviewer-ops. These routes remain only for
 * in-flight Phase 22 instances and will be retired in a follow-up
 * phase.
 *
 * The frontend mutation buttons that drove submit / approve /
 * request-changes / assign-reviewer / cancel were removed in Phase C
 * (the /workflows/[id] detail page now carries a deprecation banner
 * directing operators to /review). The reads and the step waive remain
 * live so a pre-existing Phase 22 row can still be inspected and its
 * step bookkeeping closed out; no new UI surface should call them —
 * extend reviewer-ops instead.
 *
 * Phase 22 — Workflow instance routes.
 *
 *   GET    /v1/workflows/instances?teamId&status&limit          — list
 *   GET    /v1/workflows/instances/:id                          — get + steps
 *   GET    /v1/workflows/instances/:id/timeline
 *   GET    /v1/workflows/instances/:id/export-policy
 *   POST   /v1/workflows/instances/:id/steps/:stepKey/waive     — review permission + step-up
 *   POST   /v1/workflows/instances                              — 410 (D48)
 *   POST   /v1/workflows/instances/:id/submit                   — 410 (D48)
 *   POST   /v1/workflows/instances/:id/steps/:stepKey/map-evidence — 410 (D48)
 *   POST   /v1/workflows/instances/:id/assign-reviewer          — 410 (D48)
 *   POST   /v1/workflows/instances/:id/approve                  — 410 (D48)
 *   POST   /v1/workflows/instances/:id/request-changes          — 410 (D48)
 *   POST   /v1/workflows/instances/:id/cancel                   — 410 (D48)
 *
 * Auth posture:
 *   - All routes use `requireAuth` (session JWT).
 *   - Every live route authorizes through the canonical `authorizeOrFail`
 *     with anti-enumeration (a non-member is 404 `not_found`).
 *   - Engine errors map to Phase 20 standardized response codes:
 *     STEP_UP_REQUIRED / GOVERNANCE_BLOCKED / RATE_LIMITED.
 *
 * D48 (2026-09-17) — PERMISSIONS AND RETIREMENT.
 *
 * Every route here used to be gated on `identity.member.read` — a
 * member-DIRECTORY read that VIEWER holds — so a read-only VIEWER could
 * create, submit, approve, request changes on, reassign and cancel a
 * workflow instance. The gate is now the one reviewer-ops uses for the
 * same actions:
 *
 *   - reads (list / get / timeline / export-policy / templates alias):
 *     `evidence.read` — the reviewer-ops read baseline.
 *   - waive (the ONE surviving product mutation — the detail page's
 *     legacy step control): `evidence_request.review` — the reviewer-ops
 *     write capability (OWNER / ADMIN / REVIEWER; not CONTRIBUTOR, not
 *     VIEWER). Step-up is still required after the permission check.
 *
 * The other seven mutations had no consumer anywhere (apps/web,
 * apps/mobile, e2e, worker): the detail page's lifecycle buttons were
 * removed in Phase C and no page ever called create or map-evidence. They
 * are retired to a typed 410 `WORKFLOW_INSTANCE_MUTATION_RETIRED` naming
 * the reviewer-ops route that replaced each one. The tombstones keep
 * `requireAuth`, never parse their input and read/write no domain data;
 * stored instances are untouched and still readable.
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";
import { WORKFLOW_INSTANCE_STATUSES, type Permission } from "@proovra/shared";

import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorizeOrFail } from "../middleware/authorize.js";
import { evaluateMemberAccess } from "../services/identity/access-policy.service.js";
import {
  WorkflowEngineError,
  getInstanceExportPolicySummary,
  getInstanceTimeline,
  getInstanceWithSteps,
  listInstances,
  projectInstance,
  projectStep,
  projectStepForReviewer,
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

/** The reviewer-ops read baseline (see the D48 note in the header). */
const WORKFLOW_READ_PERMISSION: Permission = "evidence.read";
/** The reviewer-ops write capability (see the D48 note in the header). */
const WORKFLOW_REVIEW_PERMISSION: Permission = "evidence_request.review";

/**
 * Canonical authorization: 404 `not_found` for a caller outside the
 * workspace (anti-enumeration), 403 `permission_denied` for a member who
 * lacks `permission`.
 */
async function requireWorkflowActor(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
  permission: Permission,
): Promise<{ userId: string } | null> {
  const outcome = await authorizeOrFail(req, reply, {
    teamId,
    permission,
    antiEnumeration: true,
  });
  return outcome ? { userId: outcome.actorUserId } : null;
}

/**
 * D48 — the typed 410 for a retired Phase 22 mutation. Reads and writes
 * nothing; `canonical` names the reviewer-ops route that replaced it.
 */
function workflowInstanceMutationRetired(
  reply: FastifyReply,
  canonical: string,
) {
  return reply.code(410).send({
    error: {
      code: "WORKFLOW_INSTANCE_MUTATION_RETIRED",
      message:
        "This workflow action has moved to Reviewer Operations. Existing workflow records stay readable here.",
    },
    canonical,
  });
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
      const actor = await requireWorkflowActor(
        req,
        reply,
        q.teamId,
        WORKFLOW_READ_PERMISSION,
      );
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
      const actor = await requireWorkflowActor(
        req,
        reply,
        q.teamId,
        WORKFLOW_READ_PERMISSION,
      );
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
  // RETIRED (D48) — create, map-evidence
  //
  // Neither had a caller anywhere: no page ever created a Phase 22 instance
  // or mapped evidence to one of its steps. New review work is created by the
  // platform as an EvidenceReviewWorkflow and worked in reviewer-ops.
  // -------------------------------------------------------------------------

  app.post(
    "/v1/workflows/instances",
    { preHandler: requireAuth },
    async (_req: FastifyRequest, reply: FastifyReply) =>
      workflowInstanceMutationRetired(reply, "/v1/reviewer-ops/queue"),
  );

  app.post(
    "/v1/workflows/instances/:id/steps/:stepKey/map-evidence",
    { preHandler: requireAuth },
    async (_req: FastifyRequest, reply: FastifyReply) =>
      workflowInstanceMutationRetired(
        reply,
        "/v1/reviewer-ops/workspace/:workflowId",
      ),
  );

  // -------------------------------------------------------------------------
  // Waive a step (review permission + step-up required)
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
      // D48 — waiving a REQUIRED step is a review decision, so it needs the
      // reviewer-ops write capability, checked BEFORE step-up so a VIEWER is
      // refused outright rather than invited to verify for an action they
      // can never take.
      const actor = await requireWorkflowActor(
        req,
        reply,
        body.teamId,
        WORKFLOW_REVIEW_PERMISSION,
      );
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
  // RETIRED (D48) — submit / approve / request-changes / cancel /
  // assign-reviewer
  //
  // Their buttons were removed from the detail page in Phase C; each action
  // is owned by the reviewer-ops lifecycle route named in `canonical`.
  // -------------------------------------------------------------------------

  app.post(
    "/v1/workflows/instances/:id/submit",
    { preHandler: requireAuth },
    async (_req: FastifyRequest, reply: FastifyReply) =>
      workflowInstanceMutationRetired(
        reply,
        "/v1/reviewer-ops/reviews/:workflowId/start",
      ),
  );

  app.post(
    "/v1/workflows/instances/:id/approve",
    { preHandler: requireAuth },
    async (_req: FastifyRequest, reply: FastifyReply) =>
      workflowInstanceMutationRetired(
        reply,
        "/v1/reviewer-ops/reviews/:workflowId/approve",
      ),
  );

  app.post(
    "/v1/workflows/instances/:id/request-changes",
    { preHandler: requireAuth },
    async (_req: FastifyRequest, reply: FastifyReply) =>
      workflowInstanceMutationRetired(
        reply,
        "/v1/reviewer-ops/reviews/:workflowId/request-info",
      ),
  );

  app.post(
    "/v1/workflows/instances/:id/cancel",
    { preHandler: requireAuth },
    async (_req: FastifyRequest, reply: FastifyReply) =>
      workflowInstanceMutationRetired(
        reply,
        "/v1/reviewer-ops/reviews/:workflowId/reject",
      ),
  );

  app.post(
    "/v1/workflows/instances/:id/assign-reviewer",
    { preHandler: requireAuth },
    async (_req: FastifyRequest, reply: FastifyReply) =>
      workflowInstanceMutationRetired(
        reply,
        "/v1/reviewer-ops/reviews/:workflowId/assign",
      ),
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
      const actor = await requireWorkflowActor(
        req,
        reply,
        q.teamId,
        WORKFLOW_READ_PERMISSION,
      );
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
      const actor = await requireWorkflowActor(
        req,
        reply,
        q.teamId,
        WORKFLOW_READ_PERMISSION,
      );
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
      const actor = await requireWorkflowActor(
        req,
        reply,
        q.teamId,
        WORKFLOW_READ_PERMISSION,
      );
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
