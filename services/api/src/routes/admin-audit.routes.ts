import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createErrorResponse, ErrorCode } from "../errors.js";
import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";
import { enforceRateLimit } from "../services/rate-limit.js";
import {
  appendPlatformAuditLog,
  listAdminAuditLogs,
  verifyAdminAuditChain,
} from "../services/platform-audit-log.service.js";

const PostBodySchema = z.object({
  action: z.string().min(1).max(128),
  category: z.string().max(64).optional(),
  severity: z.enum(["info", "warning", "critical"]).optional(),
  source: z.string().max(64).optional(),
  outcome: z.enum(["success", "failure", "blocked"]).optional(),
  resourceType: z.string().max(64).optional(),
  resourceId: z.string().max(128).optional(),
  requestId: z.string().max(64).optional(),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

function readUserAgent(req: {
  headers: Record<string, string | string[] | undefined>;
}): string | undefined {
  const value = req.headers["user-agent"];
  return Array.isArray(value) ? value[0] : value;
}

function csvEscape(value: string | null | undefined): string {
  const safe = value ?? "";
  if (/[",\n\r]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

function auditAdminAuditAccess(
  req: FastifyRequest,
  params: {
    action: string;
    outcome?: "success" | "failure" | "blocked";
    severity?: "info" | "warning" | "critical";
    metadata?: Record<string, unknown>;
  }
): void {
  void appendPlatformAuditLog({
    userId: req.user?.sub ?? null,
    action: params.action,
    category: "admin_audit_access",
    severity: params.severity ?? "info",
    source: "api_admin_audit",
    outcome: params.outcome ?? "success",
    resourceType: "admin_audit",
    resourceId: null,
    requestId: req.id,
    metadata: params.metadata ?? {},
    ipAddress: (req as { ip?: string }).ip,
    userAgent: readUserAgent(req),
  }).catch(() => null);
}

export async function adminAuditRoutes(app: FastifyInstance) {
  app.post(
    "/v1/admin/audit-log",
    {
      preHandler: requirePlatformAdmin,
      bodyLimit: 12_288,
    },
    async (req, reply) => {
      const parsed = PostBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send(
          createErrorResponse(ErrorCode.VALIDATION_ERROR, req.id, {
            reason: parsed.error.message,
          })
        );
      }

      const rate = await enforceRateLimit({
        key: `ratelimit:admin_audit_post:${req.user!.sub}`,
        max: 120,
        windowSec: 60,
      });

      if (!rate.allowed) {
        return reply.code(429).send(
          createErrorResponse(
            ErrorCode.RATE_LIMIT_EXCEEDED,
            req.id,
            undefined,
            "Too many audit log requests"
          )
        );
      }

      const userId = req.user!.sub;
      const ip =
        (req as { ip?: string }).ip ??
        (typeof req.headers["x-forwarded-for"] === "string"
          ? req.headers["x-forwarded-for"].split(",")[0]?.trim()
          : undefined);

      try {
        await appendPlatformAuditLog({
          userId,
          action: parsed.data.action,
          category: parsed.data.category ?? null,
          severity: parsed.data.severity ?? "info",
          source: parsed.data.source ?? "admin_console",
          outcome: parsed.data.outcome ?? "success",
          resourceType: parsed.data.resourceType ?? null,
          resourceId: parsed.data.resourceId ?? null,
          requestId: parsed.data.requestId ?? req.id,
          metadata: parsed.data.metadata ?? {},
          ipAddress: ip,
          userAgent: readUserAgent(req),
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === "METADATA_TOO_LARGE") {
          return reply.code(400).send(
            createErrorResponse(
              ErrorCode.INVALID_REQUEST,
              req.id,
              { reason: "metadata exceeds maximum size" },
              "Metadata too large"
            )
          );
        }

        if (err instanceof Error && err.message === "METADATA_DEPTH_EXCEEDED") {
          return reply.code(400).send(
            createErrorResponse(
              ErrorCode.INVALID_REQUEST,
              req.id,
              { reason: "metadata nesting exceeds maximum depth" },
              "Metadata too deeply nested"
            )
          );
        }

        throw err;
      }

      return reply.code(201).send({ ok: true });
    }
  );

  app.get(
    "/v1/admin/audit-log",
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const rate = await enforceRateLimit({
        key: `ratelimit:admin_audit_list:${req.user!.sub}`,
        max: 120,
        windowSec: 60,
      });

      if (!rate.allowed) {
        return reply.code(429).send(
          createErrorResponse(
            ErrorCode.RATE_LIMIT_EXCEEDED,
            req.id,
            undefined,
            "Too many audit log requests"
          )
        );
      }

      const query = req.query as Record<string, string | undefined>;
      const limitRaw = query.limit ? Number.parseInt(query.limit, 10) : 20;
      const limit = Number.isFinite(limitRaw) ? limitRaw : 20;
      const cursorId =
        typeof query.cursor === "string" && query.cursor.length > 0
          ? query.cursor
          : null;

      const { items } = await listAdminAuditLogs({
        limit,
        cursorId,
        action: query.action ?? null,
        category: query.category ?? null,
        severity: query.severity ?? null,
        outcome: query.outcome ?? null,
        search: query.search ?? null,
      });

      auditAdminAuditAccess(req, {
        action: "admin.audit_log_list_view",
        outcome: "success",
        metadata: {
          limit,
          cursorId,
          action: query.action ?? null,
          category: query.category ?? null,
          severity: query.severity ?? null,
          outcomeFilter: query.outcome ?? null,
          search: query.search ?? null,
          resultCount: items.length,
        },
      });

      return reply.code(200).send({ items });
    }
  );

  app.get(
    "/v1/admin/audit-log/export",
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const query = req.query as Record<string, string | undefined>;
      const { items } = await listAdminAuditLogs({
        limit: 100,
        action: query.action ?? null,
        category: query.category ?? null,
        severity: query.severity ?? null,
        outcome: query.outcome ?? null,
        search: query.search ?? null,
      });

      auditAdminAuditAccess(req, {
        action: "admin.audit_log_export",
        outcome: "success",
        metadata: {
          action: query.action ?? null,
          category: query.category ?? null,
          severity: query.severity ?? null,
          outcomeFilter: query.outcome ?? null,
          search: query.search ?? null,
          resultCount: items.length,
        },
      });

      const lines = [
        [
          "createdAt",
          "action",
          "category",
          "severity",
          "source",
          "outcome",
          "userId",
          "resourceType",
          "resourceId",
          "requestId",
          "ipAddress",
        ].join(","),
        ...items.map((item) =>
          [
            csvEscape(item.createdAt),
            csvEscape(item.action),
            csvEscape(item.category),
            csvEscape(item.severity),
            csvEscape(item.source),
            csvEscape(item.outcome),
            csvEscape(item.userId),
            csvEscape(item.resourceType),
            csvEscape(item.resourceId),
            csvEscape(item.requestId),
            csvEscape(item.ipAddress),
          ].join(",")
        ),
      ];

      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header(
          "content-disposition",
          `attachment; filename="admin-audit-export.csv"`
        )
        .send(lines.join("\r\n"));
    }
  );

  app.get(
    "/v1/admin/audit-log/verify",
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const rate = await enforceRateLimit({
        key: `ratelimit:admin_audit_verify:${req.user!.sub}`,
        max: 60,
        windowSec: 60,
      });

      if (!rate.allowed) {
        return reply.code(429).send(
          createErrorResponse(
            ErrorCode.RATE_LIMIT_EXCEEDED,
            req.id,
            undefined,
            "Too many verify requests"
          )
        );
      }

      const query = req.query as { limit?: string };
      const limitRaw = query.limit ? Number.parseInt(query.limit, 10) : NaN;
      const tailLimit =
        Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : null;

      const result = await verifyAdminAuditChain(
        tailLimit != null ? { tailLimit } : undefined
      );

      auditAdminAuditAccess(req, {
        action: "admin.audit_log_verify",
        outcome: result.valid ? "success" : "failure",
        severity: result.valid ? "info" : "warning",
        metadata: {
          tailLimit,
          valid: result.valid,
          ...(result.valid
            ? {}
            : { brokenAt: "brokenAt" in result ? result.brokenAt : null }),
          ...(result.valid && "partial" in result ? { partial: result.partial } : {}),
          ...(result.valid && "verifiedCount" in result
            ? { verifiedCount: result.verifiedCount }
            : {}),
        },
      });

      return reply.code(200).send(result);
    }
  );
}