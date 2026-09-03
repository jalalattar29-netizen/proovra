import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { prisma } from "../db.js";
import { createErrorResponse, ErrorCode } from "../errors.js";
import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";
import { emitPlatformAudit } from "../services/audit/tenant-audit.service.js";
// The ONE keyset-cursor authority. Both sources of the merged feed are read
// newest-first under the same `(createdAt, id)` predicate, so the page
// boundary is a position in the merged ORDER rather than an offset into
// either table.
import {
  decodeKeysetCursor,
  keysetAfter,
  keysetPage,
} from "../services/pagination/keyset-cursor.js";
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
  /**
   * Opaque keyset cursor from a previous page's `nextCursor`. It used to be
   * validated as a uuid and then never read — the feed accepted a cursor and
   * served page one regardless.
   */
  cursor: z.string().trim().min(1).max(512).optional(),
  // Free-form (bounded) canonical event-type string filter — applies to
  // SecurityEvent.eventType.
  eventType: z.string().trim().min(1).max(64).optional(),
  severity: z
    .enum(["CRITICAL", "HIGH", "WARNING", "INFO"])
    .optional(),
});

/**
 * The AdminAuditLog spellings that normalise into each bucket.
 *
 * The audit stream's severity was filtered in-process AFTER the read, so a
 * `severity=CRITICAL` page fetched `limit` audit rows of any severity and then
 * threw most of them away — the page came back short, and with a cursor that
 * would have meant "there are fewer critical audit rows than there are". The
 * predicate now runs in the database, so a page is `limit` matching rows.
 */
const AUDIT_SEVERITY_SPELLINGS: Record<SeverityBucket, string[]> = {
  CRITICAL: ["critical"],
  HIGH: ["high"],
  WARNING: ["warning", "medium", "warn"],
  INFO: [],
};

function auditSeverityWhere(bucket: SeverityBucket): Record<string, unknown> {
  if (bucket === "INFO") {
    // INFO is the residual bucket: anything that is not one of the named
    // spellings, including a null severity.
    const named = [
      ...AUDIT_SEVERITY_SPELLINGS.CRITICAL,
      ...AUDIT_SEVERITY_SPELLINGS.HIGH,
      ...AUDIT_SEVERITY_SPELLINGS.WARNING,
    ];
    return {
      OR: [
        { severity: null },
        { NOT: { severity: { in: named, mode: "insensitive" } } },
      ],
    };
  }
  return {
    severity: { in: AUDIT_SEVERITY_SPELLINGS[bucket], mode: "insensitive" },
  };
}

const incidentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  status: z
    .enum(["OPEN", "ACKNOWLEDGED", "RESOLVED", "SUPPRESSED"])
    .optional(),
  severity: z.enum(["INFO", "WARNING", "HIGH", "CRITICAL"]).optional(),
  category: z.string().trim().min(1).max(64).optional(),
  /** ADM-010 — narrow the platform feed to one affected tenant. */
  teamId: z.string().uuid().optional(),
  organizationId: z.string().uuid().optional(),
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

      const after = decodeKeysetCursor(parsed.data.cursor);
      if (after === null) {
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            req.id,
            { reason: "cursor does not decode" },
            "Invalid security-events cursor"
          )
        );
      }

      // Each source is read `limit + 1` deep, from the cursor position, then
      // merged and sorted by (createdAt, id). The extra row is how the page
      // KNOWS whether another exists rather than guessing from "we asked for
      // N and got N". Severity filtering runs in the database on BOTH
      // sources (see auditSeverityWhere).
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
      if (after) Object.assign(securityWhere, keysetAfter("createdAt", after));

      const auditWhere: Record<string, unknown> = {
        ...(eventType ? { action: { contains: eventType } } : {}),
        ...(severity ? auditSeverityWhere(severity) : {}),
      };
      if (after) {
        // `auditSeverityWhere` may already own the top-level OR, so the
        // keyset predicate is AND-ed beside it rather than merged over it.
        auditWhere.AND = [keysetAfter("createdAt", after)];
      }

      const [securityRows, auditRows, securitySeverityGroups] =
        await Promise.all([
          prisma.securityEvent.findMany({
            where: securityWhere,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: limit + 1,
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
            where: auditWhere,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: limit + 1,
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
        // The database predicate already narrowed the audit rows; this is
        // the same rule applied once more in-process so a spelling the
        // predicate does not know about can never leak into the wrong bucket.
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

      // (createdAt desc, id desc) — the SAME order the cursor encodes, so the
      // last row of this page is exactly the row the next page starts after.
      unified.sort((a, b) =>
        a.createdAt === b.createdAt
          ? a.id < b.id
            ? 1
            : a.id > b.id
              ? -1
              : 0
          : a.createdAt < b.createdAt
            ? 1
            : -1
      );
      const {
        rows: items,
        hasMore,
        nextCursor,
      } = keysetPage(unified, limit, (row) => ({ at: row.createdAt, id: row.id }));

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
        // The page's own completeness, stated by the server: `hasMore` is
        // whether a further row exists past this page under the same filters,
        // and `nextCursor` is how to ask for it. Null when this is the end.
        nextCursor,
        hasMore,
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

      const { limit, status, severity, category, teamId, organizationId } =
        parsed.data;

      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (severity) where.severity = severity;
      if (category) where.category = category;
      // ADM-010 — an operator must be able to narrow to ONE affected tenant,
      // which was impossible while the projection did not even carry the id.
      if (teamId) where.teamId = teamId;
      if (organizationId) where.team = { organizationId };

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

      // ADM-010 — resolve the AFFECTED SUBJECT for every row on this page, in
      // one batched query. `projectIncident` now carries `teamId`; a platform
      // operator additionally needs the human names, because a UUID does not
      // answer "which customer is this?" any better than a missing field did.
      const subjectTeamIds = Array.from(
        new Set(
          rows
            .map((r) => r.teamId)
            .filter((id): id is string => typeof id === "string"),
        ),
      );
      const subjects = subjectTeamIds.length
        ? await prisma.team.findMany({
            where: { id: { in: subjectTeamIds } },
            select: {
              id: true,
              name: true,
              workspaceKind: true,
              closedAtUtc: true,
              organization: { select: { id: true, name: true, kind: true } },
            },
          })
        : [];
      const subjectById = new Map(subjects.map((s) => [s.id, s] as const));

      return reply.code(200).send({
        items: rows.map((row) => {
          const projected = projectIncident(row);
          const subject = row.teamId ? subjectById.get(row.teamId) : undefined;
          return {
            ...projected,
            affected: subject
              ? {
                  workspaceId: subject.id,
                  workspaceName: subject.name,
                  workspaceKind: String(subject.workspaceKind),
                  workspaceLifecycle: subject.closedAtUtc ? "CLOSED" : "LIVE",
                  // Only a CUSTOMER organization is a customer. A SYSTEM
                  // container is the workspace's own bootstrap row and naming it
                  // here would put an internal artefact in front of an operator
                  // as though it were an account.
                  customer:
                    subject.organization &&
                    String(subject.organization.kind) === "CUSTOMER"
                      ? {
                          id: subject.organization.id,
                          name: subject.organization.name,
                        }
                      : null,
                }
              : null,
          };
        }),
        severityBreakdown,
        statusBreakdown,
        unresolvedCount,
        totalIncidents: rows.length,
        filters: {
          status: status ?? null,
          severity: severity ?? null,
          category: category ?? null,
          teamId: teamId ?? null,
          organizationId: organizationId ?? null,
        },
      });
    }
  );

  // ---------------------------------------------------------------------------
  // ADM-011 — PLATFORM-SCOPE INCIDENT ACTIONS.
  //
  // The console could see every incident on the platform and act on none of
  // them: acknowledge / resolve / assign live at `/v1/ops/incidents/:id/*`,
  // which are `requireAuth` + workspace-scoped by construction, so a
  // cross-workspace id is a 404 there by design.
  //
  // These routes do NOT introduce a second lifecycle. They resolve the actor
  // and delegate to the SAME canonical mutators the tenant surface calls, with
  // `scope: "PLATFORM_ADMIN"` changing only WHICH rows can be located. Every
  // transition rule, the source-truth resolution probe, the SLA-cycle close and
  // the incident event are shared and unmodified. Nothing here weakens the
  // tenant endpoints, and a tenant admin gains no platform-global authority:
  // `requirePlatformAdmin` is the only door in.
  // ---------------------------------------------------------------------------
  const IncidentIdParam = z.string().uuid();

  const ActionBody = z.object({
    note: z.string().trim().max(2000).optional(),
  });

  const AssignBody = z.object({
    /** NULL unassigns — one column, one transition, one gate. */
    assigneeUserId: z.string().uuid().nullable(),
  });

  async function runIncidentAction(
    req: FastifyRequest,
    reply: FastifyReply,
    action: "acknowledge" | "resolve" | "assign",
  ) {
    const idParse = IncidentIdParam.safeParse(
      (req.params as { id?: unknown }).id,
    );
    if (!idParse.success) {
      return reply.code(400).send(
        createErrorResponse(
          ErrorCode.VALIDATION_ERROR,
          req.id,
          { reason: "invalid incident id" },
          "Invalid incident id"
        )
      );
    }
    const incidentId = idParse.data;
    const actorUserId = req.user!.sub;

    const incidents = await import(
      "../services/observability/incident.service.js"
    );

    try {
      let updated;
      if (action === "assign") {
        const body = AssignBody.safeParse(req.body ?? {});
        if (!body.success) {
          return reply.code(400).send(
            createErrorResponse(
              ErrorCode.VALIDATION_ERROR,
              req.id,
              { reason: body.error.message },
              "Invalid assignment payload"
            )
          );
        }
        updated = await incidents.assignIncident({
          scope: "PLATFORM_ADMIN",
          incidentId,
          assigneeUserId: body.data.assigneeUserId,
          actorUserId,
        });
      } else {
        const body = ActionBody.safeParse(req.body ?? {});
        const note = body.success ? body.data.note ?? null : null;
        const fn =
          action === "acknowledge"
            ? incidents.acknowledgeIncident
            : incidents.resolveIncident;
        updated = await fn({
          scope: "PLATFORM_ADMIN",
          incidentId,
          actorUserId,
          resolutionNote: note,
        });
      }

      await emitPlatformAudit({
        action: `admin.incident_${action}`,
        outcome: "success",
        sourceApp: "API",
        actorUserId,
        resourceType: "operational_incident",
        resourceId: incidentId,
        correlationId: req.id,
        metadata: {
          incidentTeamId: updated.teamId ?? null,
          incidentScope: String(updated.scope),
          status: String(updated.status),
        },
      }).catch(() => null);

      return reply.code(200).send({ incident: projectIncident(updated) });
    } catch (err) {
      const code = (err as { code?: string })?.code ?? "incident_action_failed";
      await emitPlatformAudit({
        action: `admin.incident_${action}`,
        outcome: "error",
        sourceApp: "API",
        actorUserId,
        resourceType: "operational_incident",
        resourceId: incidentId,
        correlationId: req.id,
        metadata: { reason: code },
      }).catch(() => null);

      // `incident_not_found` is a genuine 404; a refused resolution (the source
      // still says the condition is live) is a 409 — the operator's request was
      // understood and declined, which is a different thing from a bad id.
      const status = code === "incident_not_found" ? 404 : 409;
      return reply
        .code(status)
        .send({ error: { code, message: "Incident action refused" } });
    }
  }

  for (const action of ["acknowledge", "resolve", "assign"] as const) {
    app.post(
      `/v1/admin/incidents/:id/${action}`,
      { preHandler: requirePlatformAdmin },
      async (req: FastifyRequest, reply: FastifyReply) =>
        runIncidentAction(req, reply, action),
    );
  }
}

export default adminSecurityRoutes;
