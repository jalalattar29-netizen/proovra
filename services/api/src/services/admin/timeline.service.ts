/**
 * PROOVRA Platform Admin (item J) — Global PLATFORM Timeline service.
 *
 * READ-ONLY chronological aggregation over EXISTING platform-operational
 * models. This service adds NO writers and mutates NO state. It merges a
 * bounded, recency-ordered feed from five platform-operational sources into a
 * single normalised shape:
 *
 *   - AdminAuditLog          — privileged admin actions (role/token/key changes)
 *   - OrganizationAuditEvent — org-level lifecycle events (cross-tenant)
 *   - SecurityEvent          — suspicious logins / MFA / SSO / SCIM failures
 *   - OperationalIncident    — platform incidents (open/ack/resolved)
 *   - AnalyticsEvent         — a SELECTED, bounded set of billing/team event
 *                              types only (billing_payment_failed,
 *                              team_plan_activated, ...). NOT a general
 *                              analytics firehose.
 *
 * SEPARATION CONTRACT (the reason this file exists):
 *   This is the PLATFORM operational timeline. It is DELIBERATELY separate
 *   from evidence custody chains. It does NOT read Evidence, custody events,
 *   verification chains, or any per-item custody ledger. Do not add such a
 *   source here — custody timelines live in the evidence surfaces.
 *
 * HONESTY / SAFETY CONTRACT (mirrors admin-security.routes.ts):
 *   - NO secrets, NO raw tokens, NO raw IP addresses, NO hashed IPs.
 *     SecurityEvent.ipAddressHash / userAgent / details are NOT selected.
 *     AdminAuditLog.ipAddress / userAgent / metadata / hash are NOT selected.
 *   - Only bounded, operator-safe columns are surfaced. Every row is a REAL
 *     row; nothing is fabricated.
 */

import { prisma } from "../../db.js";

// The four operator-facing severity buckets. Mirrors the vocabulary used by
// admin-security.routes.ts so the platform surfaces agree.
export type TimelineSeverity = "critical" | "high" | "medium" | "low";

export type TimelineSource =
  | "admin_audit"
  | "organization_audit"
  | "security_event"
  | "operational_incident"
  | "analytics_event";

export type TimelineEntry = {
  /** ISO-8601 UTC timestamp of the event. */
  at: string;
  source: TimelineSource;
  /** Best-effort actor id (user id / org id). May be null. No email/PII. */
  actor: string | null;
  /** Canonical event-type / action string. */
  eventType: string;
  severity: TimelineSeverity;
  organizationId: string | null;
  /** Short operator-safe label describing the target. May be null. */
  targetLabel: string | null;
  /** In-app deep link for the operator, when one is derivable. */
  href: string | null;
};

// Selected billing/team AnalyticsEvent types that belong on the platform
// operational timeline. This is an ALLOW-LIST — no other analytics event
// type is surfaced, so the timeline never becomes a product-analytics dump.
export const TIMELINE_ANALYTICS_EVENT_TYPES = [
  "billing_payment_failed",
  "billing_payment_succeeded",
  "team_plan_activated",
  "team_plan_downgraded",
  "subscription_canceled",
  "subscription_past_due",
] as const;

const ANALYTICS_TYPES: readonly string[] = TIMELINE_ANALYTICS_EVENT_TYPES;

function normaliseSeverity(
  raw: string | null | undefined,
): TimelineSeverity {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "critical") return "critical";
  if (v === "high") return "high";
  if (v === "medium" || v === "warning" || v === "warn") return "medium";
  return "low";
}

export type TimelineFilters = {
  source?: TimelineSource | null;
  severity?: TimelineSeverity | null;
  organizationId?: string | null;
  limit?: number | null;
  /** Recency cursor: only entries strictly older than this ISO timestamp. */
  cursor?: string | null;
};

export type TimelineResult = {
  items: TimelineEntry[];
  /** Cursor for the next (older) page, or null when the page is the tail. */
  nextCursor: string | null;
  filters: {
    source: TimelineSource | null;
    severity: TimelineSeverity | null;
    organizationId: string | null;
  };
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * Build the merged, bounded, recency-ordered PLATFORM timeline.
 *
 * We over-fetch each source by `limit` (bounded), normalise, merge, sort by
 * `at` DESC, then slice to `limit`. Cursor is an ISO timestamp — the next
 * page is everything strictly older than the last returned entry.
 */
export async function buildPlatformTimeline(
  filters: TimelineFilters = {},
): Promise<TimelineResult> {
  const limit = Math.min(
    Math.max(filters.limit ?? DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );
  const source = filters.source ?? null;
  const severity = filters.severity ?? null;
  const organizationId = filters.organizationId ?? null;

  let cursorDate: Date | null = null;
  if (filters.cursor) {
    const d = new Date(filters.cursor);
    if (!Number.isNaN(d.getTime())) cursorDate = d;
  }
  const beforeClause = cursorDate ? { lt: cursorDate } : undefined;

  const wants = (s: TimelineSource) => source === null || source === s;

  const entries: TimelineEntry[] = [];

  // ---------------------------------------------------------------------------
  // AdminAuditLog — privileged admin actions.
  // NOTE: ipAddress / userAgent / metadata / hash are DELIBERATELY not selected.
  // ---------------------------------------------------------------------------
  const adminAuditRows =
    wants("admin_audit") && organizationId === null
      ? await prisma.adminAuditLog.findMany({
          where: {
            ...(beforeClause ? { createdAt: beforeClause } : {}),
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
            resourceId: true,
            userId: true,
            createdAt: true,
          },
        })
      : [];

  for (const r of adminAuditRows) {
    entries.push({
      at: r.createdAt.toISOString(),
      source: "admin_audit",
      actor: r.userId ?? null,
      eventType: r.action,
      severity: normaliseSeverity(r.severity),
      organizationId: null,
      targetLabel: r.resourceType
        ? `${r.resourceType}${r.resourceId ? ` · ${r.resourceId}` : ""}`
        : r.category ?? null,
      href: "/admin/audit",
    });
  }

  // ---------------------------------------------------------------------------
  // OrganizationAuditEvent — org-level lifecycle (cross-tenant).
  // ---------------------------------------------------------------------------
  const orgAuditRows = wants("organization_audit")
    ? await prisma.organizationAuditEvent.findMany({
        where: {
          ...(organizationId ? { organizationId } : {}),
          ...(beforeClause ? { createdAt: beforeClause } : {}),
        },
        orderBy: [{ createdAt: "desc" }],
        take: limit,
        select: {
          id: true,
          organizationId: true,
          actorUserId: true,
          eventType: true,
          targetType: true,
          targetId: true,
          createdAt: true,
          // NOTE: metadata is DELIBERATELY not selected (free-form JSON).
        },
      })
    : [];

  for (const r of orgAuditRows) {
    entries.push({
      at: r.createdAt.toISOString(),
      source: "organization_audit",
      actor: r.actorUserId ?? null,
      eventType: r.eventType,
      // Org lifecycle events have no severity column; treat as low by default.
      severity: "low",
      organizationId: r.organizationId,
      targetLabel: r.targetType
        ? `${r.targetType}${r.targetId ? ` · ${r.targetId}` : ""}`
        : null,
      href: `/admin/organizations/${encodeURIComponent(r.organizationId)}`,
    });
  }

  // ---------------------------------------------------------------------------
  // SecurityEvent — suspicious logins / MFA / SSO / SCIM failures.
  // NOTE: ipAddressHash / userAgent / details are DELIBERATELY not selected.
  // SecurityEvent has no organizationId column (workspace-scoped via teamId),
  // so when an organizationId filter is active it is excluded.
  // ---------------------------------------------------------------------------
  const securityRows =
    wants("security_event") && organizationId === null
      ? await prisma.securityEvent.findMany({
          where: {
            ...(beforeClause ? { createdAt: beforeClause } : {}),
          },
          orderBy: [{ createdAt: "desc" }],
          take: limit,
          select: {
            id: true,
            eventType: true,
            severity: true,
            teamId: true,
            userId: true,
            createdAt: true,
          },
        })
      : [];

  for (const r of securityRows) {
    entries.push({
      at: r.createdAt.toISOString(),
      source: "security_event",
      actor: r.userId ?? null,
      eventType: r.eventType,
      severity: normaliseSeverity(r.severity),
      organizationId: null,
      targetLabel: r.teamId ? `workspace · ${r.teamId}` : null,
      href: "/admin/security",
    });
  }

  // ---------------------------------------------------------------------------
  // OperationalIncident — platform incidents.
  // ---------------------------------------------------------------------------
  const incidentRows = wants("operational_incident")
    ? await prisma.operationalIncident.findMany({
        where: {
          ...(beforeClause ? { createdAt: beforeClause } : {}),
        },
        orderBy: [{ createdAt: "desc" }],
        take: limit,
        select: {
          id: true,
          category: true,
          severity: true,
          status: true,
          title: true,
          teamId: true,
          createdAt: true,
        },
      })
    : [];

  for (const r of incidentRows) {
    entries.push({
      at: r.createdAt.toISOString(),
      source: "operational_incident",
      actor: null,
      eventType: `incident_${String(r.status).toLowerCase()}`,
      severity: normaliseSeverity(r.severity),
      organizationId: null,
      targetLabel: r.title,
      href: "/admin/security",
    });
  }

  // ---------------------------------------------------------------------------
  // AnalyticsEvent — SELECTED billing/team event types only (allow-list).
  // ---------------------------------------------------------------------------
  const analyticsRows =
    wants("analytics_event") && organizationId === null
      ? await prisma.analyticsEvent.findMany({
          where: {
            eventType: { in: ANALYTICS_TYPES as string[] },
            ...(beforeClause ? { createdAt: beforeClause } : {}),
          },
          orderBy: [{ createdAt: "desc" }],
          take: limit,
          select: {
            id: true,
            eventType: true,
            userId: true,
            severity: true,
            displayLabel: true,
            entityType: true,
            createdAt: true,
            // NOTE: metadata / path / referrer / geo columns NOT selected.
          },
        })
      : [];

  for (const r of analyticsRows) {
    entries.push({
      at: r.createdAt.toISOString(),
      source: "analytics_event",
      actor: r.userId ?? null,
      eventType: r.eventType,
      severity: normaliseSeverity(r.severity ?? "low"),
      organizationId: null,
      targetLabel: r.displayLabel ?? r.entityType ?? null,
      href: "/admin/billing",
    });
  }

  // Merge + sort by recency (DESC).
  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  // In-process severity filter (each source normalises differently, so the
  // filter is applied uniformly here rather than per-source at the DB level).
  const filtered = severity
    ? entries.filter((e) => e.severity === severity)
    : entries;

  const items = filtered.slice(0, limit);
  const nextCursor =
    filtered.length > limit && items.length > 0
      ? items[items.length - 1].at
      : null;

  return {
    items,
    nextCursor,
    filters: { source, severity, organizationId },
  };
}
