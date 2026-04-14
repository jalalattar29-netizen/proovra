import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { createErrorResponse, ErrorCode } from "../errors.js";
import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";
import { appendPlatformAuditLog } from "../services/platform-audit-log.service.js";
import {
  processDueDemoFollowUps,
  sendDemoFollowUpById,
} from "../services/demo-follow-up.service.js";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  status: z
    .enum(["NEW", "REVIEWED", "CONTACTED", "QUALIFIED", "REJECTED", "ARCHIVED"])
    .optional(),
  priority: z.enum(["LOW", "NORMAL", "HIGH"]).optional(),
  leadQuality: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
  leadTrack: z.enum(["DISCOVERY", "SALES", "ENTERPRISE"]).optional(),
  recommendedAction: z
    .enum(["reply_with_resources", "offer_demo", "route_enterprise"])
    .optional(),
  routingTarget: z
    .enum(["AUTO_RESOURCES", "AUTO_BOOKING", "MANUAL_SALES", "ENTERPRISE_DESK"])
    .optional(),
  followUpStatus: z
    .enum(["ACTIVE", "PAUSED", "COMPLETED", "REPLIED", "STOPPED"])
    .optional(),
  isSpam: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      return value === "true";
    }),
  search: z.string().trim().max(200).optional(),
});

const updateBodySchema = z.object({
  status: z
    .enum(["NEW", "REVIEWED", "CONTACTED", "QUALIFIED", "REJECTED", "ARCHIVED"])
    .optional(),
  priority: z.enum(["LOW", "NORMAL", "HIGH"]).optional(),
  notes: z.string().max(5000).nullable().optional(),
  followUpStatus: z
    .enum(["ACTIVE", "PAUSED", "COMPLETED", "REPLIED", "STOPPED"])
    .optional(),
  nextFollowUpAt: z.string().datetime().nullable().optional(),
});

const routeBodySchema = z.object({
  routingTarget: z.enum([
    "AUTO_RESOURCES",
    "AUTO_BOOKING",
    "MANUAL_SALES",
    "ENTERPRISE_DESK",
  ]),
  routingReason: z.string().trim().max(255).optional().nullable(),
});

const followUpSendBodySchema = z.object({
  step: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
});

const runFollowUpBodySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
});

function readUserAgent(req: {
  headers: Record<string, string | string[] | undefined>;
}): string | undefined {
  const value = req.headers["user-agent"];
  return Array.isArray(value) ? value[0] : value;
}

function readIp(req: { ip?: string }): string | undefined {
  return req.ip;
}

function envString(name: string): string | undefined {
  const value = process.env[name];
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

function readHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

function isValidInternalKey(req: FastifyRequest): boolean {
  const configured = envString("INTERNAL_API_KEY");
  if (!configured) return false;

  const provided = readHeaderValue(
    req.headers as Record<string, string | string[] | undefined>,
    "x-internal-key"
  )?.trim();

  return !!provided && provided === configured;
}

async function requirePlatformAdminOrInternalKey(
  req: FastifyRequest,
  reply: FastifyReply
) {
  if (isValidInternalKey(req)) {
    return;
  }

  return requirePlatformAdmin(req, reply);
}

function isTerminalStatus(status: string): boolean {
  return (
    status === "QUALIFIED" ||
    status === "REJECTED" ||
    status === "ARCHIVED"
  );
}

export async function adminDemoRequestsRoutes(app: FastifyInstance) {
  app.get(
    "/v1/admin/demo-requests",
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const parsed = listQuerySchema.safeParse(req.query ?? {});
      if (!parsed.success) {
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            req.id,
            { reason: parsed.error.message },
            "Invalid demo requests query"
          )
        );
      }

      const {
        limit,
        status,
        priority,
        leadQuality,
        leadTrack,
        recommendedAction,
        routingTarget,
        followUpStatus,
        isSpam,
        search,
      } = parsed.data;

      const where = {
        ...(status ? { status } : {}),
        ...(priority ? { priority } : {}),
        ...(leadQuality ? { leadQuality } : {}),
        ...(leadTrack ? { leadTrack } : {}),
        ...(recommendedAction ? { recommendedAction } : {}),
        ...(routingTarget ? { routingTarget } : {}),
        ...(followUpStatus ? { followUpStatus } : {}),
        ...(typeof isSpam === "boolean" ? { isSpam } : {}),
        ...(search
          ? {
              OR: [
                { fullName: { contains: search, mode: "insensitive" as const } },
                { workEmail: { contains: search, mode: "insensitive" as const } },
                { organization: { contains: search, mode: "insensitive" as const } },
                { jobTitle: { contains: search, mode: "insensitive" as const } },
                { country: { contains: search, mode: "insensitive" as const } },
                { source: { contains: search, mode: "insensitive" as const } },
                { useCase: { contains: search, mode: "insensitive" as const } },
                {
                  routingReason: {
                    contains: search,
                    mode: "insensitive" as const,
                  },
                },
              ],
            }
          : {}),
      };

      const [items, counts] = await Promise.all([
        prisma.demoRequest.findMany({
          where,
          orderBy: [{ createdAt: "desc" }],
          take: limit,
          select: {
            id: true,
            fullName: true,
            workEmail: true,
            organization: true,
            jobTitle: true,
            country: true,
            teamSize: true,
            source: true,
            sourcePath: true,
            status: true,
            priority: true,
            leadQuality: true,
            leadTrack: true,
            recommendedAction: true,
            responseSlaHours: true,
            qualificationScore: true,
            routingTarget: true,
            routingReason: true,
            routedAt: true,
            followUpStatus: true,
            followUpStep: true,
            nextFollowUpAt: true,
            lastFollowUpSentAt: true,
            lastFollowUpTemplateKey: true,
            firstRespondedAt: true,
            contactedAt: true,
            contactedByUserId: true,
            spamScore: true,
            isSpam: true,
            emailSentAt: true,
            autoReplySentAt: true,
            reviewedAt: true,
            reviewedByUserId: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
        prisma.demoRequest.groupBy({
          by: ["status"],
          _count: { _all: true },
        }),
      ]);

      void appendPlatformAuditLog({
        userId: req.user?.sub ?? null,
        action: "admin.demo_requests.list",
        category: "demo_requests",
        severity: "info",
        source: "api_admin_demo_requests",
        outcome: "success",
        resourceType: "demo_request",
        resourceId: null,
        requestId: req.id,
        metadata: {
          limit,
          status: status ?? null,
          priority: priority ?? null,
          leadQuality: leadQuality ?? null,
          leadTrack: leadTrack ?? null,
          recommendedAction: recommendedAction ?? null,
          routingTarget: routingTarget ?? null,
          followUpStatus: followUpStatus ?? null,
          isSpam: typeof isSpam === "boolean" ? isSpam : null,
          search: search ?? null,
          resultCount: items.length,
        },
        ipAddress: readIp(req),
        userAgent: readUserAgent(req),
      }).catch(() => null);

      const statusSummary = {
        NEW: 0,
        REVIEWED: 0,
        CONTACTED: 0,
        QUALIFIED: 0,
        REJECTED: 0,
        ARCHIVED: 0,
      };

      for (const row of counts) {
        statusSummary[row.status] = row._count._all;
      }

      return reply.code(200).send({
        items,
        summary: statusSummary,
      });
    }
  );

  app.get(
    "/v1/admin/demo-requests/:id",
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const params = req.params as { id?: string };
      const id = typeof params.id === "string" ? params.id : "";

      if (!id) {
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            req.id,
            { field: "id", reason: "Missing demo request id" },
            "Missing demo request id"
          )
        );
      }

      const item = await prisma.demoRequest.findUnique({
        where: { id },
        select: {
          id: true,
          fullName: true,
          workEmail: true,
          organization: true,
          jobTitle: true,
          country: true,
          teamSize: true,
          useCase: true,
          message: true,
          source: true,
          sourcePath: true,
          referrer: true,
          utmSource: true,
          utmMedium: true,
          utmCampaign: true,
          utmTerm: true,
          utmContent: true,
          status: true,
          priority: true,
          leadQuality: true,
          leadTrack: true,
          recommendedAction: true,
          responseSlaHours: true,
          qualificationScore: true,
          qualificationReasons: true,
          routingTarget: true,
          routingReason: true,
          routedAt: true,
          routedByUserId: true,
          followUpStatus: true,
          followUpStep: true,
          nextFollowUpAt: true,
          lastFollowUpSentAt: true,
          lastFollowUpTemplateKey: true,
          followUpStoppedAt: true,
          firstRespondedAt: true,
          contactedAt: true,
          contactedByUserId: true,
          spamScore: true,
          spamReasons: true,
          isSpam: true,
          emailSentAt: true,
          autoReplySentAt: true,
          webhookSentAt: true,
          reviewedAt: true,
          reviewedByUserId: true,
          notes: true,
          ipAddress: true,
          userAgent: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      if (!item) {
        return reply.code(404).send(
          createErrorResponse(
            ErrorCode.NOT_FOUND,
            req.id,
            undefined,
            "Demo request not found"
          )
        );
      }

      void appendPlatformAuditLog({
        userId: req.user?.sub ?? null,
        action: "admin.demo_requests.view",
        category: "demo_requests",
        severity: "info",
        source: "api_admin_demo_requests",
        outcome: "success",
        resourceType: "demo_request",
        resourceId: item.id,
        requestId: req.id,
        metadata: {
          demoRequestId: item.id,
          status: item.status,
          priority: item.priority,
          leadQuality: item.leadQuality,
          leadTrack: item.leadTrack,
          recommendedAction: item.recommendedAction,
          routingTarget: item.routingTarget,
          followUpStatus: item.followUpStatus,
          isSpam: item.isSpam,
        },
        ipAddress: readIp(req),
        userAgent: readUserAgent(req),
      }).catch(() => null);

      return reply.code(200).send({ item });
    }
  );

  app.patch(
    "/v1/admin/demo-requests/:id",
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const params = req.params as { id?: string };
      const id = typeof params.id === "string" ? params.id : "";

      if (!id) {
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            req.id,
            { field: "id", reason: "Missing demo request id" },
            "Missing demo request id"
          )
        );
      }

      const parsed = updateBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            req.id,
            { reason: parsed.error.message },
            "Invalid demo request update payload"
          )
        );
      }

      const existing = await prisma.demoRequest.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          priority: true,
          notes: true,
          reviewedAt: true,
          reviewedByUserId: true,
          contactedAt: true,
          contactedByUserId: true,
          firstRespondedAt: true,
          followUpStatus: true,
          followUpStoppedAt: true,
          nextFollowUpAt: true,
        },
      });

      if (!existing) {
        return reply.code(404).send(
          createErrorResponse(
            ErrorCode.NOT_FOUND,
            req.id,
            undefined,
            "Demo request not found"
          )
        );
      }

      const nextStatus = parsed.data.status ?? existing.status;
      const nextPriority = parsed.data.priority ?? existing.priority;
      const nextNotes =
        parsed.data.notes === undefined ? existing.notes : parsed.data.notes;

      const now = new Date();

      const data: Record<string, unknown> = {
        status: nextStatus,
        priority: nextPriority,
        notes: nextNotes,
      };

      const shouldStampReviewed =
        parsed.data.status !== undefined &&
        parsed.data.status !== "NEW" &&
        existing.reviewedAt == null;

      if (shouldStampReviewed) {
        data.reviewedAt = now;
        data.reviewedByUserId = req.user!.sub;
      }

      if (nextStatus === "CONTACTED" && existing.contactedAt == null) {
        data.contactedAt = now;
        data.contactedByUserId = req.user!.sub;
        data.firstRespondedAt = existing.firstRespondedAt ?? now;
      }

      if (parsed.data.followUpStatus !== undefined) {
        data.followUpStatus = parsed.data.followUpStatus;

        if (parsed.data.followUpStatus === "STOPPED") {
          data.followUpStoppedAt = existing.followUpStoppedAt ?? now;
          data.nextFollowUpAt = null;
        } else if (parsed.data.followUpStatus === "ACTIVE") {
          data.followUpStoppedAt = null;
        } else if (
          parsed.data.followUpStatus === "PAUSED" ||
          parsed.data.followUpStatus === "COMPLETED" ||
          parsed.data.followUpStatus === "REPLIED"
        ) {
          data.nextFollowUpAt = null;
        }
      }

      if (parsed.data.nextFollowUpAt !== undefined) {
        data.nextFollowUpAt = parsed.data.nextFollowUpAt
          ? new Date(parsed.data.nextFollowUpAt)
          : null;
      }

      if (isTerminalStatus(nextStatus)) {
        if (nextStatus === "QUALIFIED") {
          data.followUpStatus = "COMPLETED";
          data.nextFollowUpAt = null;
          data.followUpStoppedAt = null;
        } else {
          data.followUpStatus = "STOPPED";
          data.nextFollowUpAt = null;
          data.followUpStoppedAt = existing.followUpStoppedAt ?? now;
        }
      }

      const updated = await prisma.demoRequest.update({
        where: { id },
        data,
        select: {
          id: true,
          status: true,
          priority: true,
          notes: true,
          reviewedAt: true,
          reviewedByUserId: true,
          contactedAt: true,
          contactedByUserId: true,
          firstRespondedAt: true,
          followUpStatus: true,
          nextFollowUpAt: true,
          followUpStoppedAt: true,
          updatedAt: true,
        },
      });

      void appendPlatformAuditLog({
        userId: req.user?.sub ?? null,
        action: "admin.demo_requests.update",
        category: "demo_requests",
        severity: "info",
        source: "api_admin_demo_requests",
        outcome: "success",
        resourceType: "demo_request",
        resourceId: updated.id,
        requestId: req.id,
        metadata: {
          demoRequestId: updated.id,
          previousStatus: existing.status,
          nextStatus: updated.status,
          previousPriority: existing.priority,
          nextPriority: updated.priority,
          previousFollowUpStatus: existing.followUpStatus,
          nextFollowUpStatus: updated.followUpStatus,
          notesChanged: existing.notes !== updated.notes,
        },
        ipAddress: readIp(req),
        userAgent: readUserAgent(req),
      }).catch(() => null);

      return reply.code(200).send({
        ok: true,
        item: updated,
      });
    }
  );

  app.post(
    "/v1/admin/demo-requests/:id/route",
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const params = req.params as { id?: string };
      const id = typeof params.id === "string" ? params.id : "";

      if (!id) {
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            req.id,
            { field: "id", reason: "Missing demo request id" },
            "Missing demo request id"
          )
        );
      }

      const parsed = routeBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            req.id,
            { reason: parsed.error.message },
            "Invalid routing payload"
          )
        );
      }

      const existing = await prisma.demoRequest.findUnique({
        where: { id },
        select: {
          id: true,
          routingTarget: true,
          routingReason: true,
        },
      });

      if (!existing) {
        return reply.code(404).send(
          createErrorResponse(
            ErrorCode.NOT_FOUND,
            req.id,
            undefined,
            "Demo request not found"
          )
        );
      }

      const updated = await prisma.demoRequest.update({
        where: { id },
        data: {
          routingTarget: parsed.data.routingTarget,
          routingReason: parsed.data.routingReason ?? null,
          routedAt: new Date(),
          routedByUserId: req.user!.sub,
        },
        select: {
          id: true,
          routingTarget: true,
          routingReason: true,
          routedAt: true,
          routedByUserId: true,
          updatedAt: true,
        },
      });

      void appendPlatformAuditLog({
        userId: req.user?.sub ?? null,
        action: "admin.demo_requests.route",
        category: "demo_requests",
        severity: "info",
        source: "api_admin_demo_requests",
        outcome: "success",
        resourceType: "demo_request",
        resourceId: updated.id,
        requestId: req.id,
        metadata: {
          demoRequestId: updated.id,
          previousRoutingTarget: existing.routingTarget,
          nextRoutingTarget: updated.routingTarget,
          previousRoutingReason: existing.routingReason,
          nextRoutingReason: updated.routingReason,
        },
        ipAddress: readIp(req),
        userAgent: readUserAgent(req),
      }).catch(() => null);

      return reply.code(200).send({
        ok: true,
        item: updated,
      });
    }
  );

  app.post(
    "/v1/admin/demo-requests/:id/follow-up/send",
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const params = req.params as { id?: string };
      const id = typeof params.id === "string" ? params.id : "";

      if (!id) {
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            req.id,
            { field: "id", reason: "Missing demo request id" },
            "Missing demo request id"
          )
        );
      }

      const parsed = followUpSendBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            req.id,
            { reason: parsed.error.message },
            "Invalid follow-up payload"
          )
        );
      }

      try {
        const item = await sendDemoFollowUpById({
          demoRequestId: id,
          actorUserId: req.user!.sub,
          forceStep: parsed.data.step,
        });

        void appendPlatformAuditLog({
          userId: req.user?.sub ?? null,
          action: "admin.demo_requests.follow_up_send",
          category: "demo_requests",
          severity: "info",
          source: "api_admin_demo_requests",
          outcome: "success",
          resourceType: "demo_request",
          resourceId: item.id,
          requestId: req.id,
          metadata: {
            demoRequestId: item.id,
            followUpStep: item.followUpStep,
            followUpStatus: item.followUpStatus,
            nextFollowUpAt: item.nextFollowUpAt,
            templateKey: item.lastFollowUpTemplateKey,
          },
          ipAddress: readIp(req),
          userAgent: readUserAgent(req),
        }).catch(() => null);

        return reply.code(200).send({
          ok: true,
          item,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "UNKNOWN_ERROR";
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.INVALID_REQUEST,
            req.id,
            { reason },
            "Unable to send follow-up"
          )
        );
      }
    }
  );

  app.post(
    "/v1/admin/demo-requests/follow-up/run",
    { preHandler: requirePlatformAdminOrInternalKey },
    async (req, reply) => {
      const parsed = runFollowUpBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            req.id,
            { reason: parsed.error.message },
            "Invalid follow-up run payload"
          )
        );
      }

      const internalCall = isValidInternalKey(req);
      const actorUserId = internalCall ? null : (req.user?.sub ?? null);

      const result = await processDueDemoFollowUps({
        limit: parsed.data.limit,
        actorUserId,
      });

      void appendPlatformAuditLog({
        userId: actorUserId,
        action: "admin.demo_requests.follow_up_run",
        category: "demo_requests",
        severity: result.failed > 0 ? "warning" : "info",
        source: internalCall
          ? "api_admin_demo_requests_internal"
          : "api_admin_demo_requests",
        outcome: result.failed > 0 ? "failure" : "success",
        resourceType: "demo_request",
        resourceId: null,
        requestId: req.id,
        metadata: {
          processed: result.processed,
          sent: result.sent,
          failed: result.failed,
          limit: parsed.data.limit,
          trigger: internalCall ? "internal_worker" : "admin_manual",
        },
        ipAddress: readIp(req),
        userAgent: readUserAgent(req),
      }).catch(() => null);

      return reply.code(200).send({
        ok: true,
        result,
      });
    }
  );
}