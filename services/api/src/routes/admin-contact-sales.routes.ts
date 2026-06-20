// Read-only admin surface for Contact Sales submissions.
//
// Mirrors the demo-requests admin shape but intentionally minimal in
// this phase: list + detail + status patch only. No follow-up, no
// routing, no re-send. Operators triage from the table view.
//
// TENANT_SCOPE_EXCEPTION: platform_admin_global
//   These routes are the platform-admin-only global lead queue for
//   the marketing-side Contact Sales form. They are intentionally NOT
//   workspace / team scoped — `contact_sales_requests` rows have no
//   `team_id` foreign key by design (the visitor is anonymous at
//   submission time and no workspace exists yet). Every endpoint is
//   gated by `requirePlatformAdmin`, which restricts access to
//   PROOVRA platform operators identified by their global admin role
//   on the user record. The handlers never read tenant evidence,
//   cases, reports, or any per-team data — only the standalone
//   `contact_sales_requests` table. Every PATCH writes a
//   `platform_audit_log` entry with the canonical chain hash so
//   admin actions remain auditable. Cross-team data exposure is
//   structurally impossible because the schema has no tenant
//   dimension for this table.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
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
    .transform((v) => (v === undefined ? undefined : v === "true")),
  search: z.string().trim().max(200).optional(),
});

const updateBodySchema = z.object({
  status: z
    .enum(["NEW", "REVIEWED", "CONTACTED", "QUALIFIED", "REJECTED", "ARCHIVED"])
    .optional(),
  priority: z.enum(["LOW", "NORMAL", "HIGH"]).optional(),
  notes: z.string().max(5000).nullable().optional(),
});

function readUserAgent(req: FastifyRequest): string | undefined {
  const value = req.headers["user-agent"];
  return Array.isArray(value) ? value[0] : value;
}

export async function adminContactSalesRoutes(app: FastifyInstance) {
  app.get(
    "/v1/admin/contact-sales",
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const query = listQuerySchema.safeParse(req.query);
      if (!query.success) {
        return reply
          .code(400)
          .send(createErrorResponse(ErrorCode.VALIDATION_ERROR, "Invalid query"));
      }

      const where: Record<string, unknown> = {};
      if (query.data.status) where.status = query.data.status;
      if (query.data.priority) where.priority = query.data.priority;
      if (typeof query.data.isSpam === "boolean") where.isSpam = query.data.isSpam;
      if (query.data.search) {
        const s = query.data.search;
        where.OR = [
          { workEmail: { contains: s.toLowerCase() } },
          { fullName: { contains: s, mode: "insensitive" } },
          { organization: { contains: s, mode: "insensitive" } },
        ];
      }

      const [rows, total, summary] = await Promise.all([
        prisma.contactSalesRequest.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: query.data.limit,
          select: {
            id: true,
            fullName: true,
            workEmail: true,
            organization: true,
            jobTitle: true,
            country: true,
            teamSize: true,
            discussionTopic: true,
            stage: true,
            deploymentTimeline: true,
            estimatedUsers: true,
            sourcePage: true,
            sourcePath: true,
            status: true,
            priority: true,
            isSpam: true,
            emailSentAt: true,
            reviewedAt: true,
            reviewedByUserId: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
        prisma.contactSalesRequest.count({ where }),
        prisma.contactSalesRequest.groupBy({
          by: ["status"],
          _count: { status: true },
        }),
      ]);

      const summaryByStatus = {
        NEW: 0,
        REVIEWED: 0,
        CONTACTED: 0,
        QUALIFIED: 0,
        REJECTED: 0,
        ARCHIVED: 0,
      } as Record<string, number>;
      for (const row of summary) {
        summaryByStatus[row.status] = row._count.status;
      }

      return reply.send({
        ok: true,
        data: {
          items: rows,
          total,
          summary: summaryByStatus,
        },
      });
    }
  );

  app.get(
    "/v1/admin/contact-sales/:id",
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const params = z
        .object({ id: z.string().uuid() })
        .safeParse(req.params);
      if (!params.success) {
        return reply
          .code(400)
          .send(createErrorResponse(ErrorCode.VALIDATION_ERROR, "Invalid id"));
      }

      const row = await prisma.contactSalesRequest.findUnique({
        where: { id: params.data.id },
      });
      if (!row) {
        return reply
          .code(404)
          .send(createErrorResponse(ErrorCode.NOT_FOUND, "Not found"));
      }

      return reply.send({ ok: true, data: row });
    }
  );

  app.patch(
    "/v1/admin/contact-sales/:id",
    { preHandler: requirePlatformAdmin },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z
        .object({ id: z.string().uuid() })
        .safeParse(req.params);
      if (!params.success) {
        return reply
          .code(400)
          .send(createErrorResponse(ErrorCode.VALIDATION_ERROR, "Invalid id"));
      }
      const body = updateBodySchema.safeParse(req.body);
      if (!body.success) {
        return reply
          .code(400)
          .send(createErrorResponse(ErrorCode.VALIDATION_ERROR, "Invalid body"));
      }

      const existing = await prisma.contactSalesRequest.findUnique({
        where: { id: params.data.id },
      });
      if (!existing) {
        return reply
          .code(404)
          .send(createErrorResponse(ErrorCode.NOT_FOUND, "Not found"));
      }

      const userId = (req as FastifyRequest & { userId?: string }).userId;

      const reviewed =
        body.data.status && body.data.status !== "NEW"
          ? { reviewedAt: new Date(), reviewedByUserId: userId ?? null }
          : {};

      const updated = await prisma.contactSalesRequest.update({
        where: { id: params.data.id },
        data: {
          status: body.data.status,
          priority: body.data.priority,
          notes: body.data.notes ?? undefined,
          ...reviewed,
        },
      });

      await appendPlatformAuditLog({
        userId: userId ?? null,
        action: "ADMIN_CONTACT_SALES_UPDATE",
        resourceType: "contact_sales_request",
        resourceId: existing.id,
        ipAddress: req.ip ?? null,
        userAgent: readUserAgent(req) ?? null,
        metadata: {
          previous: {
            status: existing.status,
            priority: existing.priority,
          },
          next: {
            status: updated.status,
            priority: updated.priority,
          },
        },
      });

      return reply.send({ ok: true, data: updated });
    }
  );
}
