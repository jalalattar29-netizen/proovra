"use client";
import { toSafeUserError } from "../../../../../../lib/feedback/toSafeUserError";

/**
 * Phase 8 — Org admin / Audit tab.
 *
 * Renders the canonical org-scoped audit timeline
 * (/v1/orgs/:id/audit-events) with an event-type filter, plus a
 * deep-link to the federated /audit-transparency surface.
 *
 * Constitutional checks satisfied:
 *
 *   - Wrapped in <PageRouteGate routeId="account.organization-detail">.
 *   - No raw window.confirm (read-only).
 *   - No platform-context workspace-fragment reads — apiFetch only.
 *   - Strong TypeScript types throughout.
 *   - 403 maps to honest "Auditor-only" empty state.
 *
 * Phase 7 (Enterprise UX): presentation migrated to the shared design
 * system (Card / FilterBar / Button / EmptyState). This tab renders INSIDE
 * the org admin layout shell (which owns the org title + tab bar), so it
 * uses Card headings — not a second PageHeader. All data reads, gating,
 * filter testids, CSV export, and data-* markers are unchanged.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { PageRouteGate } from "../../../../../../components/navigation/PageRouteGate";
import { apiFetch, ApiError } from "../../../../../../lib/api";
import { formatUtcAuditDateTime } from "../../../../../../lib/date";
import { Card } from "../../../../../../components/ui/Card";
import { Button } from "../../../../../../components/ui/Button";
import { FilterBar } from "../../../../../../components/ui/FilterBar";
import { EmptyState } from "../../../../../../components/ui/EmptyState";

interface AuditEvent {
  id: string;
  actorUserId: string | null;
  actorEmail: string | null;
  actorDisplayName: string | null;
  eventType: string;
  targetType: string;
  targetId: string | null;
  metadata: unknown;
  createdAt: string;
}

interface AuditResponse {
  organizationId: string;
  summary: {
    totalEvents: number;
    nextCursor?: string | null;
    appliedTake?: number;
    appliedEventTypeFilter?: string[] | null;
  };
  events: AuditEvent[];
}

type Loadable<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "error"; message: string; status: number; requestId?: string };

const KNOWN_EVENT_TYPES: ReadonlyArray<string> = [
  "ORG_CREATED",
  "ORG_UPDATED",
  "ORG_INVITE_CREATED",
  "ORG_INVITE_ACCEPTED",
  "ORG_INVITE_REVOKED",
  "ORG_INVITE_RESENT",
  "ORG_MEMBER_ROLE_CHANGED",
  "ORG_MEMBER_REMOVED",
];

export default function OrganizationAdminAuditPage() {
  return (
    <PageRouteGate routeId="account.organization-detail">
      <AuditTab />
    </PageRouteGate>
  );
}

function AuditTab() {
  const params = useParams<{ id: string }>();
  const orgId = params?.id ?? "";

  // `filter` (event type / action) is applied SERVER-side — the
  // audit-events endpoint supports an `eventType` query param. `actor`
  // and the from/to date window are applied CLIENT-side over the loaded
  // page, because the endpoint does not expose actor/date filters. This
  // keeps the surface honest: we never claim a server capability that
  // isn't there.
  const [filter, setFilter] = useState<string>("");
  const [actor, setActor] = useState<string>("");
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [audit, setAudit] = useState<Loadable<AuditResponse>>({
    kind: "loading",
  });

  const load = useCallback(async () => {
    if (!orgId) return;
    setAudit({ kind: "loading" });
    const path = filter
      ? `/v1/orgs/${orgId}/audit-events?eventType=${encodeURIComponent(filter)}`
      : `/v1/orgs/${orgId}/audit-events`;
    try {
      const data = (await apiFetch(path)) as AuditResponse;
      setAudit({ kind: "ready", data });
    } catch (err) {
      if (err instanceof ApiError) {
        setAudit({
          kind: "error",
          message: err.message,
          status: err.statusCode ?? 0,
          requestId: err.requestId,
        });
      } else {
        const message = toSafeUserError(err, { message: "Failed to load." }).message;
        setAudit({ kind: "error", message, status: 0 });
      }
    }
  }, [orgId, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  // Client-side actor + date-window filtering over the loaded page.
  const visibleEvents =
    audit.kind === "ready"
      ? audit.data.events.filter((e) =>
          matchesClientFilters(e, actor, fromDate, toDate),
        )
      : [];

  const exportCsv = useCallback(() => {
    const rows = visibleEvents.map((e) => [
      e.createdAt,
      e.eventType,
      e.actorDisplayName ?? e.actorEmail ?? e.actorUserId ?? "",
      e.targetType,
      e.targetId ?? "",
    ]);
    const header = ["createdAt", "eventType", "actor", "targetType", "targetId"];
    const csv = [header, ...rows]
      .map((r) => r.map(csvCell).join(","))
      .join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `org-audit-${orgId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [visibleEvents, orgId]);

  return (
    <section
      data-testid="org-admin-audit"
      data-org-id={orgId}
      style={{ display: "flex", flexDirection: "column", gap: 24 }}
    >
      <Card
        variant="summary"
        data-section="audit-timeline"
        header={
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div>
              <h2
                style={{
                  margin: 0,
                  fontSize: 15,
                  fontWeight: 650,
                  color: "var(--ink-primary, #0f172a)",
                }}
              >
                Audit timeline
              </h2>
              <div
                style={{
                  fontSize: 12.5,
                  color: "var(--ink-muted, #94a3b8)",
                  marginTop: 2,
                }}
              >
                Org governance events. Requires ORG_AUDITOR or higher.
              </div>
            </div>
          </div>
        }
      >
        <FilterBar
          style={{ marginBottom: 14 }}
          actions={
            <Button
              type="button"
              data-testid="audit-export-csv"
              variant="secondary"
              size="sm"
              onClick={exportCsv}
              disabled={audit.kind !== "ready" || visibleEvents.length === 0}
            >
              Export CSV
            </Button>
          }
        >
          <FilterBar.Select
            data-testid="audit-type-filter"
            label="Filter by event type"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "", label: "All event types" },
              ...KNOWN_EVENT_TYPES.map((t) => ({ value: t, label: t })),
            ]}
          />
          <FilterBar.Search
            data-testid="audit-actor-filter"
            label="Filter by actor"
            placeholder="Actor (name / email)"
            value={actor}
            onChange={setActor}
          />
          <input
            data-testid="audit-from-filter"
            aria-label="From date"
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            style={dateInputStyle}
          />
          <input
            data-testid="audit-to-filter"
            aria-label="To date"
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            style={dateInputStyle}
          />
        </FilterBar>

        {audit.kind === "loading" ? (
          <div data-state="loading" style={mutedText}>
            Loading…
          </div>
        ) : audit.kind === "error" ? (
          <div data-state="error" role="alert" style={{ fontSize: 13 }}>
            {audit.status === 403
              ? "You don't have access to the audit timeline (requires ORG_AUDITOR or higher)."
              : audit.message}
            {audit.requestId ? (
              <div
                style={{
                  marginTop: 4,
                  fontSize: 11,
                  fontFamily: "monospace",
                  color: "var(--ink-muted, #94a3b8)",
                }}
              >
                Request id: {audit.requestId}
              </div>
            ) : null}
          </div>
        ) : (
          <ul
            data-testid="audit-events-list"
            data-total-events={audit.data.summary.totalEvents}
            data-visible-events={visibleEvents.length}
            style={{ listStyle: "none", padding: 0, margin: 0 }}
          >
            {visibleEvents.length === 0 ? (
              <li data-empty-state="no-audit-events">
                <EmptyState
                  compact
                  title={
                    filter || actor || fromDate || toDate
                      ? "No events match the current filters"
                      : "No audit events yet"
                  }
                  purpose={
                    filter || actor || fromDate || toDate
                      ? "Adjust or clear the filters above to see more of this organization's governance activity."
                      : "Governance events for this organization — invites, role changes, and org updates — are recorded here as they happen."
                  }
                />
              </li>
            ) : null}
            {visibleEvents.map((e) => (
              <li
                key={e.id}
                data-audit-event-id={e.id}
                data-audit-event-type={e.eventType}
                style={{
                  padding: "10px 0",
                  borderBottom:
                    "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
                  fontSize: 13,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    flexWrap: "wrap",
                  }}
                >
                  <div>
                    <strong>{e.eventType}</strong>{" "}
                    <span style={{ color: "var(--ink-muted, #94a3b8)" }}>
                      ({e.targetType}
                      {e.targetId ? ` ${e.targetId.slice(0, 8)}…` : ""})
                    </span>
                  </div>
                  <div
                    style={{ color: "var(--ink-muted, #94a3b8)", fontSize: 12 }}
                  >
                    {formatUtcAuditDateTime(e.createdAt)}
                  </div>
                </div>
                <div
                  style={{ fontSize: 12, color: "var(--ink-secondary, #475569)" }}
                >
                  by{" "}
                  {e.actorDisplayName ??
                    e.actorEmail ??
                    e.actorUserId ??
                    "(unknown)"}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        variant="admin"
        data-section="audit-deep-links"
        title="Federated audit surface"
      >
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          <DeepLink
            testId="audit-deep-link-transparency"
            label="Audit &amp; Transparency Center"
            description="Cross-organization audit feed with verification manifests."
            href="/audit-transparency"
          />
        </ul>
      </Card>
    </section>
  );
}

/**
 * Client-side filter predicate for actor + date window. Event-type
 * filtering is applied SERVER-side (the endpoint supports it), so it is
 * not repeated here.
 */
function matchesClientFilters(
  e: AuditEvent,
  actor: string,
  fromDate: string,
  toDate: string,
): boolean {
  if (actor.trim()) {
    const needle = actor.trim().toLowerCase();
    const haystack = [e.actorDisplayName, e.actorEmail, e.actorUserId]
      .filter((x): x is string => !!x)
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  const created = Date.parse(e.createdAt);
  if (fromDate) {
    const from = Date.parse(`${fromDate}T00:00:00.000Z`);
    if (Number.isFinite(from) && created < from) return false;
  }
  if (toDate) {
    // Inclusive of the whole `toDate` day (end-of-day UTC).
    const to = Date.parse(`${toDate}T23:59:59.999Z`);
    if (Number.isFinite(to) && created > to) return false;
  }
  return true;
}

/** RFC-4180-safe CSV cell escaping. */
function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

const mutedText: React.CSSProperties = {
  fontSize: 13,
  color: "var(--ink-secondary, #475569)",
};

const dateInputStyle: React.CSSProperties = {
  minHeight: 40,
  fontSize: 13.5,
  padding: "0 12px",
  color: "var(--ink-primary, #0f172a)",
  background: "var(--surface-card, #ffffff)",
  border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
  borderRadius: "var(--radius-md, 8px)",
  outline: "none",
};

function DeepLink({
  testId,
  label,
  description,
  href,
}: {
  testId: string;
  label: string;
  description: string;
  href: string;
}) {
  return (
    <li
      style={{
        padding: "10px 0",
        borderBottom: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div style={{ minWidth: 0, flex: "1 1 auto" }}>
        <div style={{ fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 12, color: "var(--ink-secondary, #475569)" }}>
          {description}
        </div>
      </div>
      <Link href={href} data-testid={testId} style={{ textDecoration: "none", flexShrink: 0 }}>
        <Button variant="secondary" size="sm">
          Open →
        </Button>
      </Link>
    </li>
  );
}
