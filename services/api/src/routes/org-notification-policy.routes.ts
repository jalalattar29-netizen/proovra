/**
 * Organization Notification Policy — enterprise controls for
 * PROOVRA-relevant notification requirements only:
 *
 *   GET /v1/orgs/:orgId/notification-policy   (ORG_OWNER / ORG_ADMIN)
 *   PUT /v1/orgs/:orgId/notification-policy   (ORG_OWNER / ORG_ADMIN)
 *
 * A policy row per (organization, category) can make a category
 * mandatory in-app / by email, set a minimum email cadence, and control
 * whether CRITICAL items in the category may bypass quiet hours. Absence
 * of a row means platform defaults (the platform floor — mandatory
 * governance in-app — always applies regardless).
 *
 * Members never reach these routes (403); they see locked
 * "Managed by your organization" states in preferences. Personal
 * workspaces have no organization and therefore no policy surface.
 * Every change is audited and bumps the row's policyVersion.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { emitTenantAudit } from "../services/audit/tenant-audit.service.js";
import {
  checkOrgAccess,
  orgAccessDenial,
} from "../services/organization/org-access.js";
import {
  NOTIFICATION_FREQUENCIES,
  NOTIFICATION_PREFERENCE_TYPES,
} from "../services/notifications/notification-preferences.service.js";

const MINIMUM_FREQUENCIES = NOTIFICATION_FREQUENCIES.filter(
  (f) => f !== "OFF",
);

const PutBody = z.object({
  category: z.enum(NOTIFICATION_PREFERENCE_TYPES),
  mandatoryInApp: z.boolean(),
  mandatoryEmail: z.boolean(),
  minimumFrequency: z
    .enum(MINIMUM_FREQUENCIES as [string, ...string[]])
    .nullable()
    .optional(),
  quietHoursCriticalOverride: z.boolean(),
});

/**
 * B3A-F-005 (free-audit 0ea0) — THE CANONICAL ORG AUTHORITY, NOT A ROW READ.
 *
 * This asked only whether an ACTIVE ORG_OWNER / ORG_ADMIN membership ROW
 * existed, so an administrator whose contract-bounded membership had lapsed
 * (`validUntilUtc`), or whose Organization was SUSPENDED or ARCHIVED, kept
 * reading and rewriting the policy. `checkOrgAccess` is the one org
 * authority (status, expiry, organization lifecycle, explicit role set), and
 * `orgAccessDenial` its one rendering (PV-ORG-001): a non-member or a member
 * whose access has ended gets the 404 a missing organization gets; a live
 * member without the role, or a member of a closed organization, gets 403.
 */
async function requireOrgAdmin(
  userId: string,
  orgId: string,
): Promise<{ status: 403 | 404; body: { error: { code: "not_found" | "forbidden" } } } | null> {
  const access = await checkOrgAccess(prisma, {
    orgId,
    userId,
    roles: ["ORG_OWNER", "ORG_ADMIN"],
  });
  return access.kind === "ok" ? null : orgAccessDenial(access);
}

export async function orgNotificationPolicyRoutes(app: FastifyInstance) {
  app.get(
    "/v1/orgs/:orgId/notification-policy",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const orgId = z
        .string()
        .uuid()
        .parse((req.params as { orgId: string }).orgId);
      const denial = await requireOrgAdmin(userId, orgId);
      if (denial) return reply.code(denial.status).send(denial.body);
      const policies = await prisma.organizationNotificationPolicy.findMany({
        where: { organizationId: orgId },
        orderBy: { category: "asc" },
      });
      return reply.code(200).send({
        organizationId: orgId,
        policies: policies.map((p) => ({
          category: p.category,
          mandatoryInApp: p.mandatoryInApp,
          mandatoryEmail: p.mandatoryEmail,
          minimumFrequency: p.minimumFrequency,
          quietHoursCriticalOverride: p.quietHoursCriticalOverride,
          policyVersion: p.policyVersion,
          updatedAt: p.updatedAt.toISOString(),
        })),
        catalog: {
          categories: NOTIFICATION_PREFERENCE_TYPES,
          minimumFrequencies: MINIMUM_FREQUENCIES,
        },
      });
    },
  );

  app.put(
    "/v1/orgs/:orgId/notification-policy",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const orgId = z
        .string()
        .uuid()
        .parse((req.params as { orgId: string }).orgId);
      const denial = await requireOrgAdmin(userId, orgId);
      if (denial) return reply.code(denial.status).send(denial.body);
      const body = PutBody.parse(req.body ?? {});
      const row = await prisma.organizationNotificationPolicy.upsert({
        where: {
          organizationId_category: {
            organizationId: orgId,
            category: body.category,
          },
        },
        create: {
          organizationId: orgId,
          category: body.category,
          mandatoryInApp: body.mandatoryInApp,
          mandatoryEmail: body.mandatoryEmail,
          minimumFrequency: body.minimumFrequency ?? null,
          quietHoursCriticalOverride: body.quietHoursCriticalOverride,
          createdByUserId: userId,
        },
        update: {
          mandatoryInApp: body.mandatoryInApp,
          mandatoryEmail: body.mandatoryEmail,
          minimumFrequency: body.minimumFrequency ?? null,
          quietHoursCriticalOverride: body.quietHoursCriticalOverride,
          updatedByUserId: userId,
          policyVersion: { increment: 1 },
        },
      });
      await emitTenantAudit({
        action: "org.notification_policy_updated",
        outcome: "success",
        sourceApp: "API",
        actorUserId: userId,
        organizationId: orgId,
        resourceType: "organization",
        resourceId: orgId,
        metadata: {
          policyCategory: body.category,
          mandatoryInApp: body.mandatoryInApp,
          mandatoryEmail: body.mandatoryEmail,
          minimumFrequency: body.minimumFrequency ?? null,
          policyVersion: row.policyVersion,
        },
      }).catch(() => undefined);
      return reply.code(200).send({
        policy: {
          category: row.category,
          mandatoryInApp: row.mandatoryInApp,
          mandatoryEmail: row.mandatoryEmail,
          minimumFrequency: row.minimumFrequency,
          quietHoursCriticalOverride: row.quietHoursCriticalOverride,
          policyVersion: row.policyVersion,
        },
      });
    },
  );
}
