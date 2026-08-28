/**
 * Platform Control Center — Customers / Organizations admin routes.
 *
 * Two READ-ONLY platform-admin endpoints backing the Customers roster +
 * detail. Both are gated by `requirePlatformAdmin`. NOTHING here mutates
 * state, recomputes an evidence hash, touches custody / signing / reports /
 * packages / billing checkout / the SSO-SCIM core / the tenant model. This
 * is pure aggregation over existing models.
 *
 *   GET /v1/admin/organizations       — paginated, searchable, filterable
 *                                        roster.
 *   GET /v1/admin/organizations/:id   — read-only detail (overview,
 *                                        identity, evidence, governance,
 *                                        billing, activity + provisioning).
 *
 * Secrets: the aggregation service selects ONLY non-secret columns. No IdP
 * secret, no SCIM token, no SAML private key, no card/Stripe id ever
 * crosses the wire. Fields that cannot be derived are `null` and the UI
 * renders "Not measured" / "Not connected" / "—".
 *
 * Audit: a lightweight tenant audit row is appended on detail access
 * (best-effort — an audit failure never blocks the read). Reuses the
 * canonical `emitTenantAudit` facade (this route acts on a specific org).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";
import { emitTenantAudit } from "../services/audit/tenant-audit.service.js";
import {
  getAdminOrganizationDetail,
  listAdminOrganizations,
  OrgNotFoundError,
  type OnboardingHealth,
} from "../services/organization/admin-organizations.service.js";

const UuidParam = z.string().uuid();

const ListQuery = z.object({
  page: z.coerce.number().int().min(1).max(100000).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  search: z.string().trim().max(200).optional(),
  plan: z.enum(["FREE", "PAYG", "PRO", "TEAM", "ENTERPRISE"]).optional(),
  status: z.enum(["ACTIVE", "SUSPENDED", "ARCHIVED"]).optional(),
  health: z.enum(["HEALTHY", "ATTENTION", "BLOCKED", "UNKNOWN"]).optional(),
  // ADM-003 — filter on the CONTRACT, never on a plan string.
  enterprise: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
});

// TENANT_SCOPE_EXCEPTION: platform_admin_global -- every route in this plugin is
// gated by requirePlatformAdmin and reads GLOBAL cross-tenant aggregates. It is
// intentionally NOT scoped to a single tenant; the platform-admin gate IS the
// authorization boundary. No per-tenant authorizeOrFail applies here.
export async function adminOrganizationsRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /v1/admin/customers — THE customer roster.
  //
  // ADM-033 — "customers" is what this surface is about. The population is
  // `Organization.kind = 'CUSTOMER'`, which excludes the 1:1 SYSTEM container
  // every workspace owns; calling it "organizations" is what made counting those
  // containers look reasonable. `/v1/admin/organizations` remains registered
  // below as a byte-identical alias so no existing consumer breaks.
  // ---------------------------------------------------------------------------
  const listCustomers = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "validation_error",
          detail: parsed.error.flatten(),
        },
      });
    }
    const q = parsed.data;
    const result = await listAdminOrganizations({
      page: q.page,
      limit: q.limit,
      search: q.search,
      plan: q.plan,
      status: q.status,
      health: q.health as OnboardingHealth | undefined,
      enterprise: q.enterprise,
    });
    return reply.code(200).send(result);
  };

  app.get(
    "/v1/admin/customers",
    { preHandler: requirePlatformAdmin },
    listCustomers,
  );

  // Compatibility alias — same handler, same gate, same payload. Retained so
  // this remediation does not break a consumer mid-flight; the web console now
  // calls `/v1/admin/customers`.
  app.get(
    "/v1/admin/organizations",
    { preHandler: requirePlatformAdmin },
    listCustomers,
  );

  // ---------------------------------------------------------------------------
  // GET /v1/admin/customers/:id — read-only customer detail.
  // (`/v1/admin/organizations/:id` is registered below as an alias.)
  // ---------------------------------------------------------------------------
  const customerDetail = async (req: FastifyRequest, reply: FastifyReply) => {
      const idParse = UuidParam.safeParse((req.params as { id?: unknown }).id);
      if (!idParse.success) {
        return reply.code(400).send({
          error: { code: "validation_error", detail: idParse.error.flatten() },
        });
      }
      const orgId = idParse.data;

      let detail;
      try {
        detail = await getAdminOrganizationDetail(orgId);
      } catch (err) {
        if (err instanceof OrgNotFoundError) {
          return reply.code(404).send({
            error: { code: "org_not_found", message: "Organization not found" },
          });
        }
        throw err;
      }

      // Best-effort access audit. Never blocks the read.
      try {
        await emitTenantAudit({
          action: "ADMIN_ORG_DETAIL_VIEWED",
          outcome: "success",
          sourceApp: "API",
          actorUserId: req.user?.sub ?? null,
          organizationId: orgId,
          resourceType: "organization",
          resourceId: orgId,
          correlationId: req.id,
          metadata: { orgId },
        });
      } catch {
        // Audit is advisory here; a failure must not fail the read.
      }

      return reply.code(200).send(detail);
  };

  app.get(
    "/v1/admin/customers/:id",
    { preHandler: requirePlatformAdmin },
    customerDetail,
  );

  // Compatibility alias for the pre-rename path.
  app.get(
    "/v1/admin/organizations/:id",
    { preHandler: requirePlatformAdmin },
    customerDetail,
  );
}
