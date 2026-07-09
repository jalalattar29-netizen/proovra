import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { prisma } from "../db.js";
import { createErrorResponse, ErrorCode } from "../errors.js";
import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";
import { projectIncident } from "../services/observability/incident.service.js";

/**
 * Platform Control Center P1 — Platform Security & Incidents aggregate.
 *
 * READ-ONLY aggregation over EXISTING models. This plugin adds NO writers,
 * mutates NO security state, and duplicates NO security logic. It merely
 * projects two existing tables — `SecurityEvent` and `AdminAuditLog` — into a
 * single platform-wide (cross-tenant) operator feed, plus a platform-wide
 * `OperationalIncident` list reusing the operator-safe `projectIncident`
 * projection from the observability incident service.
 *
 * HONESTY / SAFETY CONTRACT (mirrors the workspace-scoped security surfaces):
 *   - NO secrets, NO raw tokens, NO raw IP addresses. `SecurityEvent` already
 *     stores only a hashed IP (never a raw IP) and `AdminAuditLog`'s raw IP
 *     column is DELIBERATELY not selected here.
 *   - `AdminAuditLog.metadata` is free-form JSON that may carry sensitive
 *     detail — it is DELIBERATELY not selected. Only the bounded,
 *     operator-safe columns (action, category, severity, outcome, source,
 *     resourceType, createdAt) are surfaced.
 *   - Severity counts are computed from the REAL rows, never fabricated.
 */

// Canonical operator-facing severity buckets. `SecurityEvent.severity` is a
// free VARCHAR in production (see schema note) and `AdminAuditLog.severity`
// uses a lowercase info/warning/critical vocabulary; both are normalised into
// the same four buckets here so the breakdown is a single honest count.
const SEVERITY_BUCKETS = ["CRITICAL", "HIGH", "WARNING", "INFO"] as const;
type SeverityBucket = (typeof SEVERITY_BUCKETS)[number];

function normaliseSeverity(raw: string | null | undefined): SeverityBucket {
  const v = (raw ?? "").trim().toUpperCase();
  if (v === "CRITICAL") return "CRITICAL";
  if (v === "HIGH") return "HIGH";
  if (v === "WARNING" || v === "MEDIUM" || v === "WARN") return "WARNING";
  return "INFO";
}

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().uuid().optional(),
  // Free-form (bounded) canonical event-type string filter — applies to
  // SecurityEvent.eventType.
  eventType: z.string().trim().min(1).max(64).optional(),
  severity: z
    .enum(["CRITICAL", "HIGH", "WARNING", "INFO"])
    .optional(),
});

const incidentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  status: z
    .enum(["OPEN", "ACKNOWLEDGED", "RESOLVED", "SUPPRESSED"])
    .optional(),
  severity: z.enum(["INFO", "WARNING", "HIGH", "CRITICAL"]).optional(),
  category: z.string().trim().min(1).max(64).optional(),
});

type UnifiedSecurityEvent = {
  id: string;
  origin: "SECURITY_EVENT" | "ADMIN_AUDIT";
  eventType: string;
  severity: SeverityBucket;
  outcome: string | null;
  category: string | null;
  source: string | null;
  resourceType: string | null;
  teamId: string | null;
  userId: string | null;
  createdAt: string;
};

export async function adminSecurityRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /v1/admin/security-events — platform-wide unified security feed.
  //
  // Sources (READ-ONLY):
  //   - SecurityEvent  — suspicious logins, MFA/step-up/SSO/SCIM failures,
  //     permission-denied bursts, etc. (whatever writers already record).
  //   - AdminAuditLog  — admin role changes, external-reviewer token actions,
  //     API-key changes, webhook-failure audit entries, etc.
  //
  // Both are surfaced through a single bounded, operator-safe projection.
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/admin/security-events",
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const parsed = listQuerySchema.safeParse(req.query ?? {});
      if (!parsed.success) {
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            req.id,
            { reason: parsed.error.message },
            "Invalid security-events query"
          )
        );
      }

      const { limit, eventType, severity } = parsed.data;

      // We over-fetch each source by `limit` then merge + sort by createdAt so
      // the unified page is a true recency merge. Severity filtering on
      // SecurityEvent is applied at the DB level; AdminAuditLog severity is
      // normalised in-process (lowercase vocabulary) so it is filtered here.
      const securityWhere: Record<string, unknown> = {};
      if (eventType) securityWhere.eventType = eventType;
      if (severity) {
        // SecurityEvent.severity is stored as an upper-case-ish VARCHAR; match
        // the canonical bucket plus the common aliases that map to it.
        if (severity === "WARNING") {
          securityWhere.severity = { in: ["WARNING", "MEDIUM", "WARN"] };
        } else {
          securityWhere.severity = severity;
        }
      }

      const [securityRows, auditRows, securitySeverityGroups] =
        await Promise.all([
          prisma.securityEvent.findMany({
            where: securityWhere,
            orderBy: [{ createdAt: "desc" }],
            take: limit,
            select: {
              id: true,
              eventType: true,
              severity: true,
              teamId: true,
              userId: true,
              createdAt: true,
              // NOTE: hashed-IP / user-agent / free-form detail columns are
              // DELIBERATELY not selected.
            },
          }),
          // AdminAuditLog rows are the privileged-action stream. When an
          // eventType filter is supplied we match it against `action` so the
          // filter is meaningful across both sources.
          prisma.adminAuditLog.findMany({
            where: {
              ...(eventType ? { action: { contains: eventType } } : {}),
            },
            orderBy: [{ createdAt: "desc" }],
            take: limit,
            select: {
              id: true,
              action: true,
              category: true,
              severity: true,
              outcome: true,
              source: true,
              resourceType: true,
              userId: true,
              createdAt: true,
              // NOTE: metadata / ipAddress / userAgent / hash DELIBERATELY
              // omitted — they can carry sensitive detail.
            },
          }),
          prisma.securityEvent.groupBy({
            by: ["severity"],
            _count: { severity: true },
          }),
        ]);

      const unified: UnifiedSecurityEvent[] = [];

      for (const r of securityRows) {
        unified.push({
          id: r.id,
          origin: "SECURITY_EVENT",
          eventType: r.eventType,
          severity: normaliseSeverity(r.severity),
          outcome: null,
          category: null,
          source: null,
          resourceType: null,
          teamId: r.teamId,
          userId: r.userId,
          createdAt: r.createdAt.toISOString(),
        });
      }

      for (const r of auditRows) {
        const bucket = normaliseSeverity(r.severity);
        // Apply the requested severity filter to normalised audit rows.
        if (severity && bucket !== severity) continue;
        unified.push({
          id: r.id,
          origin: "ADMIN_AUDIT",
          eventType: r.action,
          severity: bucket,
          outcome: r.outcome,
          category: r.category,
          source: r.source,
          resourceType: r.resourceType,
          teamId: null,
          userId: r.userId,
          createdAt: r.createdAt.toISOString(),
        });
      }

      unified.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      const items = unified.slice(0, limit);

      // Severity breakdown across the SecurityEvent table (platform-wide,
      // REAL counts). AdminAuditLog high/critical counts are added on top so
      // the breakdown reflects both streams.
      const severityBreakdown: Record<SeverityBucket, number> = {
        CRITICAL: 0,
        HIGH: 0,
        WARNING: 0,
        INFO: 0,
      };
      for (const g of securitySeverityGroups) {
        severityBreakdown[normaliseSeverity(g.severity)] +=
          g._count.severity;
      }

      // Elevated-severity admin-audit counts (role changes, token actions,
      // etc.) — a real count, computed separately so we do not double-scan.
      const [auditWarning, auditCritical] = await Promise.all([
        prisma.adminAuditLog.count({ where: { severity: "warning" } }),
        prisma.adminAuditLog.count({ where: { severity: "critical" } }),
      ]);
      severityBreakdown.WARNING += auditWarning;
      severityBreakdown.CRITICAL += auditCritical;

      const totalEvents = SEVERITY_BUCKETS.reduce(
        (sum, b) => sum + severityBreakdown[b],
        0
      );

      return reply.code(200).send({
        items,
        severityBreakdown,
        totalEvents,
        filters: {
          eventType: eventType ?? null,
          severity: severity ?? null,
        },
      });
    }
  );

  // ---------------------------------------------------------------------------
  // GET /v1/admin/incidents — platform-wide OperationalIncident feed.
  //
  // The existing `/v1/ops/incidents` route + `listIncidents` service are
  // WORKSPACE-scoped (they require a teamId). For the PLATFORM aggregate we
  // query `prisma.operationalIncident` directly across all tenants but reuse
  // the operator-safe `projectIncident` projection so the exposed field set is
  // identical (no metadata / raw context leakage).
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/admin/incidents",
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const parsed = incidentsQuerySchema.safeParse(req.query ?? {});
      if (!parsed.success) {
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            req.id,
            { reason: parsed.error.message },
            "Invalid incidents query"
          )
        );
      }

      const { limit, status, severity, category } = parsed.data;

      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (severity) where.severity = severity;
      if (category) where.category = category;

      const [rows, severityGroups, statusGroups] = await Promise.all([
        prisma.operationalIncident.findMany({
          where,
          orderBy: [{ status: "asc" }, { lastSeenAtUtc: "desc" }],
          take: limit,
        }),
        prisma.operationalIncident.groupBy({
          by: ["severity"],
          _count: { severity: true },
        }),
        prisma.operationalIncident.groupBy({
          by: ["status"],
          _count: { status: true },
        }),
      ]);

      const severityBreakdown: Record<string, number> = {
        CRITICAL: 0,
        HIGH: 0,
        WARNING: 0,
        INFO: 0,
      };
      for (const g of severityGroups) {
        const key = String(g.severity).toUpperCase();
        if (key in severityBreakdown) {
          severityBreakdown[key] = g._count.severity;
        }
      }

      // Unresolved = OPEN + ACKNOWLEDGED (real counts from the status groups).
      let unresolvedCount = 0;
      const statusBreakdown: Record<string, number> = {
        OPEN: 0,
        ACKNOWLEDGED: 0,
        RESOLVED: 0,
        SUPPRESSED: 0,
      };
      for (const g of statusGroups) {
        const key = String(g.status).toUpperCase();
        if (key in statusBreakdown) statusBreakdown[key] = g._count.status;
        if (key === "OPEN" || key === "ACKNOWLEDGED") {
          unresolvedCount += g._count.status;
        }
      }

      return reply.code(200).send({
        items: rows.map(projectIncident),
        severityBreakdown,
        statusBreakdown,
        unresolvedCount,
        totalIncidents: rows.length,
        filters: {
          status: status ?? null,
          severity: severity ?? null,
          category: category ?? null,
        },
      });
    }
  );
}

export default adminSecurityRoutes;
