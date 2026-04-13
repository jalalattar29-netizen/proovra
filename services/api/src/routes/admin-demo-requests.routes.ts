import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { createErrorResponse, ErrorCode } from "../errors.js";
import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";
import { appendPlatformAuditLog } from "../services/platform-audit-log.service.js";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  status: z
    .enum(["NEW", "REVIEWED", "CONTACTED", "QUALIFIED", "REJECTED", "ARCHIVED"])
    .optional(),
  priority: z.enum(["LOW", "NORMAL", "HIGH"]).optional(),
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

      const { limit, status, priority, isSpam, search } = parsed.data;

      const where = {
        ...(status ? { status } : {}),
        ...(priority ? { priority } : {}),
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

      const shouldStampReview =
        parsed.data.status !== undefined &&
        parsed.data.status !== "NEW" &&
        existing.reviewedAt == null;

      const updated = await prisma.demoRequest.update({
        where: { id },
        data: {
          status: nextStatus,
          priority: nextPriority,
          notes: nextNotes,
          ...(shouldStampReview
            ? {
                reviewedAt: new Date(),
                reviewedByUserId: req.user!.sub,
              }
            : {}),
        },
        select: {
          id: true,
          status: true,
          priority: true,
          notes: true,
          reviewedAt: true,
          reviewedByUserId: true,
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
}