import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";
import {
  WORKFLOW_INTAKE_MODES,
  WORKFLOW_LOCATION_REQUIREMENTS,
  WORKFLOW_PLAN_MODES,
  WORKFLOW_WORKSPACE_CATEGORIES,
  WORKFLOW_WORKSPACE_ROLES,
  WorkflowExportPolicySchema,
  WorkflowReviewPolicySchema,
  WorkflowRuleSchema,
  WorkflowStepSchema,
  WorkflowVisibilityPolicySchema,
} from "@proovra/shared";

import { authorizeOrFail } from "../middleware/authorize.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import {
  archiveWorkspaceWorkflowTemplate,
  createWorkspaceWorkflowTemplate,
  listEffectiveWorkflowTemplates,
  projectEffectiveWorkflowTemplate,
  updateWorkspaceWorkflowTemplate,
} from "../services/workflow-template.service.js";

/*
 * Workflow template routes — Phase 2.
 *
 *   GET    /v1/workflow/templates              — list effective templates
 *   POST   /v1/workflow/templates              — create workspace template
 *   PATCH  /v1/workflow/templates/:id          — update workspace template
 *   POST   /v1/workflow/templates/:id/archive  — archive workspace template
 *
 * Phase 2 invariants:
 *   - These routes do NOT replace /v1/capture/intake-templates. That endpoint
 *     continues to serve the in-code seed list unchanged.
 *   - The capture page is NOT wired to these routes in this phase.
 *   - All routes require authentication. Mutations require role >= ADMIN.
 *   - No unauthenticated workflow endpoint exists.
 */

// -----------------------------------------------------------------------------
// Zod schemas (route-local thin wrappers around the shared Phase 1 schemas)
// -----------------------------------------------------------------------------

const ListQuery = z.object({
  teamId: z.string().uuid().optional(),
  workspaceCategory: z.enum(WORKFLOW_WORKSPACE_CATEGORIES).optional(),
  includeArchived: z
    .union([z.literal("true"), z.literal("false")])
    .optional(),
});

const CreateBody = z.object({
  teamId: z.string().uuid(),
  slug: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/, {
      message: "slug must be kebab-case",
    }),
  name: z.string().min(1).max(180),
  description: z.string().max(2000).optional(),
  workspaceCategory: z.enum(WORKFLOW_WORKSPACE_CATEGORIES).optional(),
  planMode: z.enum(WORKFLOW_PLAN_MODES),
  locationRequirement: z.enum(WORKFLOW_LOCATION_REQUIREMENTS),
  intakeModes: z.array(z.enum(WORKFLOW_INTAKE_MODES)).min(1),
  allowedRoles: z.array(z.enum(WORKFLOW_WORKSPACE_ROLES)).max(4).optional(),
  steps: z.array(WorkflowStepSchema).min(1).max(64),
  rules: z.array(WorkflowRuleSchema).max(64).optional(),
  visibilityPolicy: WorkflowVisibilityPolicySchema.optional(),
  reviewPolicy: WorkflowReviewPolicySchema.optional(),
  exportPolicy: WorkflowExportPolicySchema.optional(),
});

const UpdateBody = z.object({
  name: z.string().min(1).max(180).optional(),
  description: z.string().max(2000).nullable().optional(),
  workspaceCategory: z
    .enum(WORKFLOW_WORKSPACE_CATEGORIES)
    .nullable()
    .optional(),
  planMode: z.enum(WORKFLOW_PLAN_MODES).optional(),
  locationRequirement: z.enum(WORKFLOW_LOCATION_REQUIREMENTS).optional(),
  intakeModes: z.array(z.enum(WORKFLOW_INTAKE_MODES)).min(1).optional(),
  allowedRoles: z.array(z.enum(WORKFLOW_WORKSPACE_ROLES)).max(4).optional(),
  steps: z.array(WorkflowStepSchema).min(1).max(64).optional(),
  rules: z.array(WorkflowRuleSchema).max(64).optional(),
  visibilityPolicy: WorkflowVisibilityPolicySchema.nullable().optional(),
  reviewPolicy: WorkflowReviewPolicySchema.nullable().optional(),
  exportPolicy: WorkflowExportPolicySchema.nullable().optional(),
});

const ParamsId = z.object({ id: z.string().uuid() });

// -----------------------------------------------------------------------------
// Membership helpers
// -----------------------------------------------------------------------------

/**
 * PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — canonical authorization.
 * Both gates route through authorizeOrFail (ACTIVE membership + org lifecycle
 * + capability + fail-closed + anti-enumeration 404). Reads use `evidence.read`
 * (the base evidence-domain read every member holds; workflow templates govern
 * evidence workflows and have no dedicated read permission). Template mutations
 * use `workflow.template.manage` (held by OWNER + ADMIN only — the same set the
 * former `hasRole(ADMIN)` check enforced).
 */
async function requireWorkspaceMember(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<{ userId: string } | null> {
  const outcome = await authorizeOrFail(req, reply, {
    teamId,
    permission: "evidence.read",
    antiEnumeration: true,
  });
  return outcome ? { userId: outcome.actorUserId } : null;
}

async function requireWorkspaceAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<{ userId: string } | null> {
  const outcome = await authorizeOrFail(req, reply, {
    teamId,
    permission: "workflow.template.manage",
    antiEnumeration: true,
  });
  return outcome ? { userId: outcome.actorUserId } : null;
}

// -----------------------------------------------------------------------------
// Route registration
// -----------------------------------------------------------------------------

export async function workflowRoutes(app: FastifyInstance) {
  // -- List effective templates --------------------------------------------

  app.get(
    "/v1/workflow/templates",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = ListQuery.parse(req.query ?? {});

      // Membership check only when a teamId is provided. Without teamId, the
      // caller gets only the global view (seed + platform DB rows), which
      // is safe for any authenticated user.
      if (query.teamId) {
        const ok = await requireWorkspaceMember(req, reply, query.teamId);
        if (!ok) return;
      }

      const list = await listEffectiveWorkflowTemplates({
        teamId: query.teamId ?? null,
        workspaceCategory: query.workspaceCategory ?? null,
        includeArchived: query.includeArchived === "true",
      });

      return reply
        .code(200)
        .send({ templates: list.map(projectEffectiveWorkflowTemplate) });
    },
  );

  // -- Create workspace template -------------------------------------------

  app.post(
    "/v1/workflow/templates",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = CreateBody.parse(req.body ?? {});
      const ok = await requireWorkspaceAdmin(req, reply, body.teamId);
      if (!ok) return;

      try {
        const row = await createWorkspaceWorkflowTemplate(
          {
            slug: body.slug,
            name: body.name,
            description: body.description ?? null,
            workspaceCategory: body.workspaceCategory ?? null,
            planMode: body.planMode,
            locationRequirement: body.locationRequirement,
            intakeModes: body.intakeModes,
            allowedRoles: body.allowedRoles,
            steps: body.steps,
            rules: body.rules,
            visibilityPolicy: body.visibilityPolicy ?? null,
            reviewPolicy: body.reviewPolicy ?? null,
            exportPolicy: body.exportPolicy ?? null,
          },
          { teamId: body.teamId, actorUserId: ok.userId },
        );

        return reply.code(201).send({
          template: {
            id: row.id,
            slug: row.slug,
            teamId: row.teamId,
            version: row.version,
            archived: row.archived,
          },
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to create template";
        // Most plausible failure: unique-violation on (team_id, slug). Surface
        // a 409 so the client can choose a different slug or use PATCH.
        if (
          typeof message === "string" &&
          message.toLowerCase().includes("unique")
        ) {
          return reply.code(409).send({ message });
        }
        return reply.code(400).send({ message });
      }
    },
  );

  // -- Update workspace template -------------------------------------------

  app.patch(
    "/v1/workflow/templates/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = UpdateBody.parse(req.body ?? {});

      const existing = await prisma.evidenceWorkflowTemplate.findUnique({
        where: { id },
      });
      if (!existing || !existing.teamId) {
        return reply.code(404).send({ message: "Template not found" });
      }

      const ok = await requireWorkspaceAdmin(req, reply, existing.teamId);
      if (!ok) return;

      try {
        const row = await updateWorkspaceWorkflowTemplate(
          {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.description !== undefined
              ? { description: body.description ?? null }
              : {}),
            ...(body.workspaceCategory !== undefined
              ? { workspaceCategory: body.workspaceCategory ?? null }
              : {}),
            ...(body.planMode !== undefined ? { planMode: body.planMode } : {}),
            ...(body.locationRequirement !== undefined
              ? { locationRequirement: body.locationRequirement }
              : {}),
            ...(body.intakeModes !== undefined
              ? { intakeModes: body.intakeModes }
              : {}),
            ...(body.allowedRoles !== undefined
              ? { allowedRoles: body.allowedRoles }
              : {}),
            ...(body.steps !== undefined ? { steps: body.steps } : {}),
            ...(body.rules !== undefined ? { rules: body.rules } : {}),
            ...(body.visibilityPolicy !== undefined
              ? { visibilityPolicy: body.visibilityPolicy ?? null }
              : {}),
            ...(body.reviewPolicy !== undefined
              ? { reviewPolicy: body.reviewPolicy ?? null }
              : {}),
            ...(body.exportPolicy !== undefined
              ? { exportPolicy: body.exportPolicy ?? null }
              : {}),
          },
          {
            templateId: id,
            teamId: existing.teamId,
            actorUserId: ok.userId,
          },
        );

        if (!row) {
          return reply.code(404).send({ message: "Template not found" });
        }

        return reply.code(200).send({
          template: {
            id: row.id,
            slug: row.slug,
            teamId: row.teamId,
            version: row.version,
            archived: row.archived,
          },
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to update template";
        return reply.code(400).send({ message });
      }
    },
  );

  // -- Archive workspace template ------------------------------------------

  app.post(
    "/v1/workflow/templates/:id/archive",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);

      const existing = await prisma.evidenceWorkflowTemplate.findUnique({
        where: { id },
      });
      if (!existing || !existing.teamId) {
        return reply.code(404).send({ message: "Template not found" });
      }

      const ok = await requireWorkspaceAdmin(req, reply, existing.teamId);
      if (!ok) return;

      const row = await archiveWorkspaceWorkflowTemplate({
        templateId: id,
        teamId: existing.teamId,
        actorUserId: ok.userId,
      });

      if (!row) {
        // Already archived or not found — treat as idempotent success.
        return reply.code(200).send({
          template: {
            id: existing.id,
            slug: existing.slug,
            teamId: existing.teamId,
            version: existing.version,
            archived: true,
          },
        });
      }

      return reply.code(200).send({
        template: {
          id: row.id,
          slug: row.slug,
          teamId: row.teamId,
          version: row.version,
          archived: row.archived,
        },
      });
    },
  );
}
