import type { FastifyInstance } from "fastify";
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
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

function readUserAgent(req: {
  headers: Record<string, string | string[] | undefined>;
}): string | undefined {
  const value = req.headers["user-agent"];
  return Array.isArray(value) ? value[0] : value;
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

      const query = req.query as { limit?: string; cursor?: string };
      const limitRaw = query.limit ? Number.parseInt(query.limit, 10) : 20;
      const limit = Number.isFinite(limitRaw) ? limitRaw : 20;
      const cursorId =
        typeof query.cursor === "string" && query.cursor.length > 0
          ? query.cursor
          : null;

      const { items } = await listAdminAuditLogs({
        limit,
        cursorId,
      });

      return reply.code(200).send({ items });
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

      return reply.code(200).send(result);
    }
  );
}