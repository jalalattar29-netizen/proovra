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
import { appendPlatformAuditLog } from "../services/platform-audit-log.service.js";
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

async function requireOrgAdmin(
  userId: string,
  orgId: string,
): Promise<boolean> {
  const membership = await prisma.organizationMembership.findFirst({
    where: {
      userId,
      organizationId: orgId,
      role: { in: ["ORG_OWNER", "ORG_ADMIN"] },
    },
    select: { id: true },
  });
  return membership !== null;
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
      if (!(await requireOrgAdmin(userId, orgId))) {
        return reply.code(403).send({ error: { code: "org_admin_required" } });
      }
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
      if (!(await requireOrgAdmin(userId, orgId))) {
        return reply.code(403).send({ error: { code: "org_admin_required" } });
      }
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
      await appendPlatformAuditLog({
        userId,
        action: "org.notification_policy_updated",
        category: "governance",
        source: "api",
        outcome: "success",
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
