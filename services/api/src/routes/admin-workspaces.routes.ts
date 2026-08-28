import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";
import { emitPlatformAudit } from "../services/audit/tenant-audit.service.js";
import {
  getAdminWorkspaceDetail,
  listAdminWorkspaces,
  WorkspaceNotFoundError,
} from "../services/admin/workspaces.service.js";

/**
 * PLATFORM ADMIN — Workspace directory (ADM-027).
 *
 *   GET /v1/admin/workspaces      — roster, server-side filtered + paginated
 *   GET /v1/admin/workspaces/:id  — detail, canonical commercial context
 *
 * TENANT_SCOPE_EXCEPTION: platform_admin_global — both routes read GLOBAL
 * cross-tenant state and are gated by `requirePlatformAdmin`, which IS the
 * authorization boundary here. No per-tenant `authorizeOrFail` applies: a
 * platform operator is deliberately not a member of the workspaces they
 * oversee, which is why the support-access grant flow exists separately for
 * anything that needs to act INSIDE a tenant.
 *
 * WHAT THIS SURFACE DELIBERATELY DOES NOT EXPOSE
 * ---------------------------------------------------------------------------
 * Evidence CONTENT. It reports counts, storage totals and failure states —
 * operational metadata — and never a title, a file, a storage key or a hash.
 * Platform-operations visibility and evidence-content authorization are
 * different grants, and collapsing them because the viewer happens to be an
 * admin would quietly widen the second one.
 */

const ListQuery = z.object({
  page: z.coerce.number().int().min(1).max(100000).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  search: z.string().trim().max(200).optional(),
  kind: z.enum(["PERSONAL", "OWNED", "ORGANIZATION"]).optional(),
  lifecycle: z.enum(["LIVE", "CLOSED", "ALL"]).optional().default("LIVE"),
  plan: z.enum(["FREE", "PAYG", "PRO", "TEAM", "ENTERPRISE"]).optional(),
  billingStatus: z
    .enum(["ACTIVE", "PAST_DUE", "CANCELED", "INACTIVE", "TRIALING"])
    .optional(),
  organizationId: z.string().uuid().optional(),
  customersOnly: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
});

const UuidParam = z.string().uuid();

export async function adminWorkspacesRoutes(app: FastifyInstance) {
  app.get(
    "/v1/admin/workspaces",
    { preHandler: requirePlatformAdmin },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = ListQuery.safeParse(req.query ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          error: { code: "validation_error", detail: parsed.error.flatten() },
        });
      }
      const q = parsed.data;
      const result = await listAdminWorkspaces({
        page: q.page,
        limit: q.limit,
        search: q.search,
        kind: q.kind,
        lifecycle: q.lifecycle,
        plan: q.plan,
        billingStatus: q.billingStatus,
        organizationId: q.organizationId,
        customersOnly: q.customersOnly,
      });
      return reply.code(200).send(result);
    },
  );

  app.get(
    "/v1/admin/workspaces/:id",
    { preHandler: requirePlatformAdmin },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const idParse = UuidParam.safeParse((req.params as { id?: unknown }).id);
      if (!idParse.success) {
        return reply.code(400).send({
          error: { code: "validation_error", detail: idParse.error.flatten() },
        });
      }
      const teamId = idParse.data;

      let detail;
      try {
        detail = await getAdminWorkspaceDetail(teamId);
      } catch (err) {
        if (err instanceof WorkspaceNotFoundError) {
          return reply.code(404).send({
            error: { code: "workspace_not_found", message: "Workspace not found" },
          });
        }
        throw err;
      }

      // ADM-022 — a cross-tenant read of one named tenant is audited, matching
      // the policy the customer-detail route already follows. The ROSTER is
      // not: it is a bounded page of metadata with no single subject, and
      // auditing every page render produces noise that buries the reads that
      // matter.
      await emitPlatformAudit({
        action: "admin.workspace_detail_viewed",
        outcome: "success",
        sourceApp: "API",
        actorUserId: req.user?.sub ?? null,
        resourceType: "workspace",
        resourceId: teamId,
        correlationId: req.id,
        metadata: {
          workspaceKind: detail.kind,
          organizationId: detail.organization?.id ?? null,
        },
      }).catch(() => null);

      return reply.code(200).send(detail);
    },
  );
}

export default adminWorkspacesRoutes;
