import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";
import { WORKFLOW_WORKSPACE_CATEGORIES } from "@proovra/shared";

import { authorizeOrFail } from "../middleware/authorize.js";
import { requireAuth } from "../middleware/auth.js";
import {
  listEffectiveWorkflowTemplates,
  projectEffectiveWorkflowTemplate,
} from "../services/workflow-template.service.js";

/*
 * Workflow template routes — Phase 2.
 *
 *   GET    /v1/workflow/templates              — list effective templates
 *   POST   /v1/workflow/templates              — RETIRED (410, 2026-09-16)
 *   PATCH  /v1/workflow/templates/:id          — RETIRED (410, 2026-09-16)
 *   POST   /v1/workflow/templates/:id/archive  — RETIRED (410, 2026-09-16)
 *
 * Phase 2 invariants:
 *   - These routes do NOT replace /v1/capture/intake-templates. That endpoint
 *     continues to serve the in-code seed list unchanged.
 *   - The capture page is NOT wired to these routes in this phase.
 *   - All routes require authentication. The three mutations were retired
 *     to typed 410 tombstones (templates are platform-managed).
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

// -----------------------------------------------------------------------------
// Membership helpers
// -----------------------------------------------------------------------------

/**
 * PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — canonical authorization.
 * The read gate routes through authorizeOrFail (ACTIVE membership + org
 * lifecycle + capability + fail-closed + anti-enumeration 404) using
 * `evidence.read` (the base evidence-domain read every member holds; workflow
 * templates govern evidence workflows and have no dedicated read permission).
 * The former `workflow.template.manage` admin gate went with the mutations it
 * guarded when they were retired to typed 410s (2026-09-16).
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

  // -- (RETIRED) Workspace template authoring --------------------------------
  //
  // OWNER DECISION (2026-09-16): workspace-level workflow-template authoring
  // is out of scope. Templates are platform-managed; a workspace reads the
  // effective list above and never writes to it.
  //
  // The three mutations were never a product capability. The capture page was
  // not wired to them (Phase 2 invariant, header), the create route had no
  // caller anywhere in apps/web or apps/mobile — so no workspace-sourced
  // template could exist for edit or archive to act on — and the Workflows
  // page tells administrators that templates are administered by platform
  // owners. They answer a typed 410 so a stale client is told the capability
  // is not offered rather than 404-ed. Stored template rows are untouched and
  // still served by the list route.

  const templateAuthoringRetired = (reply: FastifyReply) =>
    reply.code(410).send({
      error: {
        code: "WORKFLOW_TEMPLATE_AUTHORING_RETIRED",
        message:
          "Workflow templates are managed by the platform. Workspaces can use the available templates but cannot create, edit or archive them.",
      },
      canonical: "/v1/workflow/templates",
    });

  app.post(
    "/v1/workflow/templates",
    { preHandler: requireAuth },
    async (_req: FastifyRequest, reply: FastifyReply) =>
      templateAuthoringRetired(reply),
  );

  app.patch(
    "/v1/workflow/templates/:id",
    { preHandler: requireAuth },
    async (_req: FastifyRequest, reply: FastifyReply) =>
      templateAuthoringRetired(reply),
  );

  app.post(
    "/v1/workflow/templates/:id/archive",
    { preHandler: requireAuth },
    async (_req: FastifyRequest, reply: FastifyReply) =>
      templateAuthoringRetired(reply),
  );
}
