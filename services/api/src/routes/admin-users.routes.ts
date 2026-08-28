import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { prisma } from "../db.js";
import { createErrorResponse, ErrorCode } from "../errors.js";
import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";
import { emitPlatformAudit } from "../services/audit/tenant-audit.service.js";
import {
  getAdminPersonDetail,
  listAdminPeople,
  PersonNotFoundError,
} from "../services/admin/people.service.js";

/**
 * PLATFORM ADMIN — People directory (ADM-028, ADM-016, ADM-031).
 *
 *   GET /v1/admin/users            — roster with commercial filters
 *   GET /v1/admin/users/:id        — per-person detail
 *   GET /v1/admin/lifecycle-requests — account closure / data-export queue
 *
 * The roster's security posture is UNCHANGED and deliberately so: an explicit
 * column allow-list, no `passwordHash`, no MFA secret material, no tokens, and
 * `riskStatus: null` because no per-user risk model exists. What it gained is
 * the commercial dimension it never had — the tier, the provider subscription,
 * pending cancellation, the personal workspace, and a `:id` route to open.
 *
 * "Which of our users are PRO?" is now `?tier=PRO`.
 *
 * TENANT_SCOPE_EXCEPTION: platform_admin_global — cross-tenant reads gated by
 * `requirePlatformAdmin`, which IS the authorization boundary here.
 */

const ListQuery = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
  search: z.string().trim().max(200).optional(),
  platformRole: z.enum(["admin"]).optional(),
  provider: z.enum(["GOOGLE", "APPLE", "GUEST", "EMAIL"]).optional(),
  tier: z.enum(["FREE", "PAYG", "PRO", "TEAM", "ENTERPRISE"]).optional(),
  subscriptionStatus: z
    .enum(["ACTIVE", "TRIALING", "PAST_DUE", "CANCELED"])
    .optional(),
  pendingCancellation: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  organizationId: z.string().uuid().optional(),
  teamId: z.string().uuid().optional(),
});

const UuidParam = z.string().uuid();

export async function adminUsersRoutes(app: FastifyInstance) {
  app.get(
    "/v1/admin/users",
    { preHandler: requirePlatformAdmin },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = ListQuery.safeParse(req.query ?? {});
      if (!parsed.success) {
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            req.id,
            { reason: parsed.error.message },
            "Invalid users query",
          ),
        );
      }
      const q = parsed.data;
      const result = await listAdminPeople({
        page: q.page,
        pageSize: q.pageSize,
        search: q.search,
        platformRole: q.platformRole,
        provider: q.provider,
        tier: q.tier,
        subscriptionStatus: q.subscriptionStatus,
        pendingCancellation: q.pendingCancellation,
        organizationId: q.organizationId,
        teamId: q.teamId,
      });
      return reply.code(200).send(result);
    },
  );

  app.get(
    "/v1/admin/users/:id",
    { preHandler: requirePlatformAdmin },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const idParse = UuidParam.safeParse((req.params as { id?: unknown }).id);
      if (!idParse.success) {
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            req.id,
            { reason: "invalid user id" },
            "Invalid user id",
          ),
        );
      }
      const userId = idParse.data;

      let detail;
      try {
        detail = await getAdminPersonDetail(userId);
      } catch (err) {
        if (err instanceof PersonNotFoundError) {
          return reply
            .code(404)
            .send({ error: { code: "user_not_found", message: "User not found" } });
        }
        throw err;
      }

      // ADM-022 — reading ONE named person's commercial and workspace footprint
      // is a targeted cross-tenant read and is audited, matching the policy the
      // customer-detail route already follows. The paged roster is not: it has
      // no single subject, and auditing every page render buries the reads that
      // matter under noise.
      await emitPlatformAudit({
        action: "admin.user_detail_viewed",
        outcome: "success",
        sourceApp: "API",
        actorUserId: req.user?.sub ?? null,
        resourceType: "user",
        resourceId: userId,
        correlationId: req.id,
        metadata: { accountTier: detail.accountTier },
      }).catch(() => null);

      return reply.code(200).send(detail);
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/admin/lifecycle-requests — ADM-031.
  //
  // `AccountClosureRequest` and `AccountDataExportRequest` are both real, both
  // driven by existing state machines, and both were invisible to Platform
  // Admin: an operator could not see who had asked for erasure or for their
  // data, which is a compliance-relevant blind spot rather than a convenience
  // gap.
  //
  // READ-ONLY, and deliberately so. Both machines are owned by their own
  // services with cooling-off windows, blocker preflights and cron execution;
  // an admin button that wrote a status directly would be exactly the "direct DB
  // state hacking from UI" this remediation forbids.
  // ---------------------------------------------------------------------------
  const LifecycleQuery = z.object({
    kind: z.enum(["CLOSURE", "DATA_EXPORT", "ALL"]).optional().default("ALL"),
    status: z.string().trim().max(32).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  });

  app.get(
    "/v1/admin/lifecycle-requests",
    { preHandler: requirePlatformAdmin },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = LifecycleQuery.safeParse(req.query ?? {});
      if (!parsed.success) {
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            req.id,
            { reason: parsed.error.message },
            "Invalid lifecycle-requests query",
          ),
        );
      }
      const { kind, status, limit } = parsed.data;

      const wantClosure = kind === "ALL" || kind === "CLOSURE";
      const wantExport = kind === "ALL" || kind === "DATA_EXPORT";

      const [closures, exports] = await Promise.all([
        wantClosure
          ? prisma.accountClosureRequest.findMany({
              where: { ...(status ? { status } : {}) },
              orderBy: { requestedAtUtc: "desc" },
              take: limit,
              select: {
                id: true,
                userId: true,
                status: true,
                reason: true,
                requestedAtUtc: true,
                coolingOffEndsAtUtc: true,
                completedAtUtc: true,
                cancelledAtUtc: true,
                failureCode: true,
                blockersJson: true,
                user: { select: { email: true } },
              },
            })
          : Promise.resolve([]),
        wantExport
          ? prisma.accountDataExportRequest.findMany({
              where: { ...(status ? { status } : {}) },
              orderBy: { requestedAtUtc: "desc" },
              take: limit,
              // packageJson / packageSha256 DELIBERATELY omitted — the export
              // package is the user's own data and a queue view has no business
              // carrying it.
              select: {
                id: true,
                userId: true,
                status: true,
                requestedAtUtc: true,
                startedAtUtc: true,
                completedAtUtc: true,
                expiresAtUtc: true,
                failureCode: true,
                downloadCount: true,
                user: { select: { email: true } },
              },
            })
          : Promise.resolve([]),
      ]);

      return reply.code(200).send({
        closure: closures.map((c) => ({
          id: c.id,
          userId: c.userId,
          userEmail: c.user?.email ?? null,
          status: c.status,
          reason: c.reason ?? null,
          requestedAtUtc: c.requestedAtUtc.toISOString(),
          coolingOffEndsAtUtc: c.coolingOffEndsAtUtc?.toISOString() ?? null,
          completedAtUtc: c.completedAtUtc?.toISOString() ?? null,
          cancelledAtUtc: c.cancelledAtUtc?.toISOString() ?? null,
          failureCode: c.failureCode ?? null,
          blockers: c.blockersJson ?? null,
        })),
        dataExport: exports.map((e) => ({
          id: e.id,
          userId: e.userId,
          userEmail: e.user?.email ?? null,
          status: e.status,
          requestedAtUtc: e.requestedAtUtc.toISOString(),
          startedAtUtc: e.startedAtUtc?.toISOString() ?? null,
          completedAtUtc: e.completedAtUtc?.toISOString() ?? null,
          expiresAtUtc: e.expiresAtUtc?.toISOString() ?? null,
          failureCode: e.failureCode ?? null,
          downloadCount: e.downloadCount,
        })),
      });
    },
  );
}
