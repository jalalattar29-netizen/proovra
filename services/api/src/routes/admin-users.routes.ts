import type { FastifyInstance } from "fastify";
import { Prisma, TeamMemberStatus, MfaFactorStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { createErrorResponse, ErrorCode } from "../errors.js";
import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";

/**
 * Platform Control Center P1 — Platform Users roster.
 *
 * GET /v1/admin/users — a READ-ONLY roster over the EXISTING identity
 * models. Every field is either a REAL value read from the database or
 * `null` ("Not measured" in the UI). Nothing is fabricated.
 *
 * HONESTY / SECURITY invariants (locked by phase-admin-users.test.ts):
 *   • NO password hash, NO MFA secret material, NO tokens, NO secrets of
 *     any kind ever leave this endpoint. The User.select list below is an
 *     explicit allow-list; `passwordHash` and every MfaFactor secret
 *     column are deliberately absent.
 *   • `mfaEnrolled` is a boolean derived from the EXISTENCE of a
 *     non-revoked MfaFactor row — we count factors, we never read their
 *     secret ciphertext / IV / auth-tag / KEK id.
 *   • `lastLoginAt` is DERIVED. The schema has no `User.lastLoginAt`
 *     column and no `Session` model. The authoritative successful-login
 *     signal is the `login_completed` AnalyticsEvent written on every
 *     successful auth (see auth.routes.ts `fireLoginCompletedAnalytics`
 *     → analytics-event.service `writeAnalyticsEvent`). We take the
 *     newest such event's `createdAt` per user; if a user has never
 *     produced one, `lastLoginAt` is `null` — never guessed.
 *   • `suspended` / `deactivated` are derived from TeamMember.status
 *     (SUSPENDED / REVOKED). A user with no memberships, or only ACTIVE
 *     ones, reports `false`. When there is no membership signal at all we
 *     still return `false` (not suspended) rather than inventing a state.
 *   • `riskStatus` — there is no per-user risk score model, so it is
 *     always `null` (honestly "Not measured") until such a signal exists.
 */

const PAGE_SIZE_DEFAULT = 25;
const PAGE_SIZE_MAX = 100;

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_SIZE_MAX)
    .optional()
    .default(PAGE_SIZE_DEFAULT),
  search: z.string().trim().max(200).optional(),
  platformRole: z.enum(["admin"]).optional(),
  provider: z.enum(["GOOGLE", "APPLE", "GUEST", "EMAIL"]).optional(),
  suspended: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      return value === "true";
    }),
});

// TENANT_SCOPE_EXCEPTION: platform_admin_global -- every route in this plugin is
// gated by requirePlatformAdmin and reads GLOBAL cross-tenant aggregates. It is
// intentionally NOT scoped to a single tenant; the platform-admin gate IS the
// authorization boundary. No per-tenant authorizeOrFail applies here.
export async function adminUsersRoutes(app: FastifyInstance) {
  app.get(
    "/v1/admin/users",
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const parsed = listQuerySchema.safeParse(req.query ?? {});
      if (!parsed.success) {
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            req.id,
            { reason: parsed.error.message },
            "Invalid users query"
          )
        );
      }

      const { page, pageSize, search, platformRole, provider, suspended } =
        parsed.data;

      // Base filter — email/name search, platformRole, provider are all
      // direct User-column predicates. `suspended` is a TeamMember.status
      // signal, so it is expressed as a relation predicate.
      const where: Prisma.UserWhereInput = {
        ...(platformRole ? { platformRole } : {}),
        ...(provider ? { provider } : {}),
        ...(search
          ? {
              OR: [
                { email: { contains: search, mode: "insensitive" } },
                { displayName: { contains: search, mode: "insensitive" } },
                { firstName: { contains: search, mode: "insensitive" } },
                { lastName: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
        ...(suspended === true
          ? {
              teamMembers: {
                some: {
                  status: { in: [TeamMemberStatus.SUSPENDED, TeamMemberStatus.REVOKED] },
                },
              },
            }
          : {}),
        ...(suspended === false
          ? {
              NOT: {
                teamMembers: {
                  some: {
                    status: { in: [TeamMemberStatus.SUSPENDED, TeamMemberStatus.REVOKED] },
                  },
                },
              },
            }
          : {}),
      };

      const skip = (page - 1) * pageSize;

      const [total, users] = await Promise.all([
        prisma.user.count({ where }),
        prisma.user.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
          skip,
          take: pageSize,
          // Explicit allow-list. NO passwordHash. NO secret material.
          select: {
            id: true,
            email: true,
            displayName: true,
            firstName: true,
            lastName: true,
            createdAt: true,
            provider: true,
            platformRole: true,
            country: true,
            timezone: true,
            _count: {
              select: {
                organizationMemberships: true,
                // teamMembers is the workspace-membership relation.
                teamMembers: true,
                // A user is "MFA enrolled" if they have >=1 non-revoked
                // authenticator. We count rows only — never read secrets.
                mfaFactors: {
                  where: {
                    status: {
                      in: [MfaFactorStatus.ACTIVE, MfaFactorStatus.ENROLLING],
                    },
                  },
                },
              },
            },
            // Access-lifecycle signal for suspended/deactivated. We read
            // ONLY the status column, no reasons/actors needed for the roster.
            teamMembers: {
              select: { status: true },
            },
          },
        }),
      ]);

      const userIds = users.map((u) => u.id);

      // Derive lastLoginAt from the newest `login_completed` AnalyticsEvent
      // per user. groupBy _max(createdAt) gives us one row per user in a
      // single query; users with no login event are simply absent → null.
      const lastLoginRows =
        userIds.length > 0
          ? await prisma.analyticsEvent.groupBy({
              by: ["userId"],
              where: {
                userId: { in: userIds },
                eventType: "login_completed",
              },
              _max: { createdAt: true },
            })
          : [];

      const lastLoginByUser = new Map<string, Date>();
      for (const row of lastLoginRows) {
        if (row.userId && row._max.createdAt) {
          lastLoginByUser.set(row.userId, row._max.createdAt);
        }
      }

      const items = users.map((u) => {
        const statuses = u.teamMembers.map((m) => m.status);
        const suspendedFlag = statuses.includes(TeamMemberStatus.SUSPENDED);
        const deactivatedFlag = statuses.includes(TeamMemberStatus.REVOKED);

        const composedName =
          [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || null;
        const name = u.displayName ?? composedName;

        const lastLoginAt = lastLoginByUser.get(u.id) ?? null;

        return {
          id: u.id,
          email: u.email ?? null,
          name,
          createdAt: u.createdAt,
          provider: u.provider,
          platformRole: u.platformRole ?? null,
          orgMembershipsCount: u._count.organizationMemberships,
          workspaceMembershipsCount: u._count.teamMembers,
          mfaEnrolled: u._count.mfaFactors > 0,
          lastLoginAt: lastLoginAt ? lastLoginAt.toISOString() : null,
          // Access-lifecycle: suspended (temporary) vs deactivated (revoked).
          suspended: suspendedFlag,
          deactivated: deactivatedFlag,
          country: u.country ?? null,
          timezone: u.timezone ?? null,
          // No per-user risk model exists yet → honestly "Not measured".
          riskStatus: null as string | null,
        };
      });

      return reply.code(200).send({
        items,
        page,
        pageSize,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
      });
    }
  );
}
