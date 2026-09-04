import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createErrorResponse, ErrorCode } from "../errors.js";
import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";
import { trustedClientIp } from "../middleware/client-ip.js";
import { enforceRateLimit } from "../services/rate-limit.js";
import {
  listAdminAuditLogs,
  verifyAdminAuditChain,
} from "../services/platform-audit-log.service.js";
import { emitPlatformAudit, emitAdminManualAudit } from "../services/audit/tenant-audit.service.js";

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

/**
 * The list read's query, validated like the writer's body above.
 *
 * `limit` was parsed by hand and silently fell back to 20 on garbage; the
 * filters were read straight off `req.query` with no bound at all. Bounded
 * here so a pathological value is a 400 rather than an unbounded scan.
 * `cursor` is the id of the last row shown — the shape the list has always
 * accepted — and the response now says whether there is anything past it.
 */
const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  cursor: z.string().trim().max(128).optional(),
  // An empty filter is "no filter", exactly as it was; only the length is new.
  action: z.string().trim().max(128).optional(),
  category: z.string().trim().max(64).optional(),
  severity: z.string().trim().max(32).optional(),
  outcome: z.string().trim().max(32).optional(),
  source: z.string().trim().max(64).optional(),
  search: z.string().trim().max(128).optional(),
  // PHASE 5 §11 — the investigation filters the page could not ask for.
  //
  // "Which of these were people and which were jobs" and "what did THIS
  // operator do" are the first two questions of an incident review, and
  // neither had a parameter: an operator could narrow by action or category
  // and then read UUIDs. Both are DB-side, like every other filter here, so
  // the screen and the export can never disagree about what was matched.
  actorType: z
    .enum(["HUMAN", "SERVICE", "WORKER", "SYSTEM", "SUPPORT_CONTEXT", "UNKNOWN_LEGACY"])
    .optional(),
  actorUserId: z.string().trim().uuid().optional(),
  workspaceId: z.string().trim().uuid().optional(),
  organizationId: z.string().trim().uuid().optional(),
  requestId: z.string().trim().max(64).optional(),
  /** Inclusive UTC bounds. */
  from: z.string().trim().datetime({ offset: true }).optional(),
  until: z.string().trim().datetime({ offset: true }).optional(),
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
  const outcome =
    params.outcome === "failure" ? "error" : params.outcome === "blocked" ? "denied" : "success";
  void emitPlatformAudit({
    action: params.action,
    outcome,
    denialReason: outcome === "denied" ? params.action : null,
    sourceApp: "API",
    actorUserId: req.user?.sub ?? null,
    resourceType: "admin_audit",
    resourceId: null,
    correlationId: req.id,
    metadata: {
      ...(params.metadata ?? {}),
      severity: params.severity ?? "info",
      ipAddress: (req as { ip?: string }).ip,
      userAgent: readUserAgent(req),
    },
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
      // PHASE 13 §1 (NEW-022) — FORENSIC_METADATA: record the SAME resolved
      // client identity the security bounds use, not the leftmost (forgeable)
      // forwarded entry, so the audit trail cannot be poisoned with a
      // caller-chosen address.
      const ip = trustedClientIp(req) ?? undefined;

      try {
        // §2 — the ONE sanctioned passthrough (admin manual audit entry with a
        // caller-chosen category); routed through the canonical audit authority,
        // never the low-level writer directly.
        await emitAdminManualAudit({
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
        // §3 — hardened manual-audit validation (invalid action shape).
        if (err instanceof Error && (err as { code?: string }).code === "INVALID_ADMIN_MANUAL_AUDIT") {
          return reply.code(400).send(
            createErrorResponse(ErrorCode.INVALID_REQUEST, req.id, { reason: "invalid_action" }, "Invalid manual audit action"),
          );
        }
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

      const parsedQuery = ListQuerySchema.safeParse(req.query ?? {});
      if (!parsedQuery.success) {
        return reply.code(400).send(
          createErrorResponse(ErrorCode.VALIDATION_ERROR, req.id, {
            reason: parsedQuery.error.message,
          })
        );
      }
      const query = parsedQuery.data;
      const limit = query.limit;
      const cursorId = query.cursor || null;

      // Item L (additive) — optional list filters. `action`, `category`, and
      // `severity` are pushed into the tamper-evident query via
      // listAdminAuditLogs (backward compatible — omitted → no filter). The
      // `source` column is not a listAdminAuditLogs parameter, so it is
      // applied here as a bounded, exact-match post-filter over the returned
      // page. The verify + pagination paths are untouched.
      const sourceFilter =
        typeof query.source === "string" && query.source.trim().length > 0
          ? query.source.trim()
          : null;

      const filters = {
        action: query.action ?? null,
        category: query.category ?? null,
        severity: query.severity ?? null,
        outcome: query.outcome ?? null,
        source: query.source ?? null,
        search: query.search ?? null,
        actorType: query.actorType ?? null,
        actorUserId: query.actorUserId ?? null,
        workspaceId: query.workspaceId ?? null,
        organizationId: query.organizationId ?? null,
        requestId: query.requestId ?? null,
        occurredFromUtc: query.from ? new Date(query.from) : null,
        occurredUntilUtc: query.until ? new Date(query.until) : null,
      };

      const { items: rawItems } = await listAdminAuditLogs({
        limit,
        cursorId,
        ...filters,
      });

      const items = sourceFilter
        ? rawItems.filter((item) => item.source === sourceFilter)
        : rawItems;

      // Whether another page exists is ASKED of the chain, not inferred from
      // a full page: one row past the last one shown, under the same filters.
      // The cursor is the row id — the SAME cursor the list has always
      // accepted — so an existing caller that passes `cursor=` keeps working
      // and now also learns when to stop.
      const last = rawItems[rawItems.length - 1];
      const hasMore =
        rawItems.length >= limit && last
          ? (
              await listAdminAuditLogs({
                limit: 1,
                cursorId: last.id,
                ...filters,
              })
            ).items.length > 0
          : false;
      const nextCursor = hasMore && last ? last.id : null;

      auditAdminAuditAccess(req, {
        action: "admin.audit_log_list_view",
        outcome: "success",
        metadata: {
          limit,
          cursorId,
          action: query.action ?? null,
          category: query.category ?? null,
          severity: query.severity ?? null,
          source: sourceFilter,
          outcomeFilter: query.outcome ?? null,
          search: query.search ?? null,
          resultCount: items.length,
        },
      });

      return reply.code(200).send({ items, nextCursor, hasMore });
    }
  );

  app.get(
    "/v1/admin/audit-log/export",
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      // PHASE 12 VERTICAL A (2026-07-30) — the export was the ONLY read on
      // this router without a rate limit, while it is the most expensive one
      // (full row projection + CSV serialization). A compromised platform-
      // admin session could stream the whole audit chain unthrottled. Bounded
      // at a lower ceiling than the list read for the same reason.
      const rate = await enforceRateLimit({
        key: `ratelimit:admin_audit_export:${req.user!.sub}`,
        max: 20,
        windowSec: 60,
      });

      if (!rate.allowed) {
        auditAdminAuditAccess(req, {
          action: "admin.audit_log_export",
          outcome: "blocked",
          severity: "warning",
          metadata: { reason: "rate_limited" },
        });
        return reply.code(429).send(
          createErrorResponse(
            ErrorCode.RATE_LIMIT_EXCEEDED,
            req.id,
            undefined,
            "Too many export requests"
          )
        );
      }

      const query = req.query as Record<string, string | undefined>;
      const { items } = await listAdminAuditLogs({
        limit: 100,
        action: query.action ?? null,
        category: query.category ?? null,
        severity: query.severity ?? null,
        outcome: query.outcome ?? null,
        source: query.source ?? null,
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