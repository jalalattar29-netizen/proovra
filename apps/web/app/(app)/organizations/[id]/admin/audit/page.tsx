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
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { PageRouteGate } from "../../../../../../components/navigation/PageRouteGate";
import { apiFetch, ApiError } from "../../../../../../lib/api";
import { formatUtcAuditDateTime } from "../../../../../../lib/date";

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
    <section data-testid="org-admin-audit" data-org-id={orgId}>
      <section
        data-section="audit-timeline"
        style={{
          padding: "1rem 1.1rem",
          border: "1px solid rgba(127,127,127,0.3)",
          borderRadius: 8,
          marginBottom: "1rem",
        }}
      >
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            marginBottom: "0.5rem",
            flexWrap: "wrap",
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: 16 }}>Audit timeline</h2>
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>
              Org governance events. Requires ORG_AUDITOR or higher.
            </div>
          </div>
          <div
            style={{
              display: "flex",
              gap: 6,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <select
              data-testid="audit-type-filter"
              aria-label="Filter by event type"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{ fontSize: 12, padding: "0.25rem 0.4rem" }}
            >
              <option value="">All event types</option>
              {KNOWN_EVENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <input
              data-testid="audit-actor-filter"
              aria-label="Filter by actor"
              placeholder="Actor (name / email)"
              value={actor}
              onChange={(e) => setActor(e.target.value)}
              style={{ fontSize: 12, padding: "0.25rem 0.4rem", minWidth: 140 }}
            />
            <input
              data-testid="audit-from-filter"
              aria-label="From date"
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              style={{ fontSize: 12, padding: "0.2rem 0.4rem" }}
            />
            <input
              data-testid="audit-to-filter"
              aria-label="To date"
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              style={{ fontSize: 12, padding: "0.2rem 0.4rem" }}
            />
            <button
              type="button"
              data-testid="audit-export-csv"
              onClick={exportCsv}
              disabled={audit.kind !== "ready" || visibleEvents.length === 0}
              className="cases-filter-chip"
              style={{ fontSize: 12 }}
            >
              Export CSV
            </button>
          </div>
        </header>
        {audit.kind === "loading" ? (
          <div data-state="loading" style={{ fontSize: 13, opacity: 0.7 }}>
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
                  opacity: 0.7,
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
              <li
                data-empty-state="no-audit-events"
                style={{ padding: "0.5rem 0", fontSize: 13, opacity: 0.75 }}
              >
                {filter || actor || fromDate || toDate
                  ? "No events match the current filters."
                  : "No audit events yet."}
              </li>
            ) : null}
            {visibleEvents.map((e) => (
              <li
                key={e.id}
                data-audit-event-id={e.id}
                data-audit-event-type={e.eventType}
                style={{
                  padding: "0.45rem 0",
                  borderBottom: "1px solid rgba(127,127,127,0.18)",
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
                    <span style={{ opacity: 0.7 }}>
                      ({e.targetType}
                      {e.targetId ? ` ${e.targetId.slice(0, 8)}…` : ""})
                    </span>
                  </div>
                  <div style={{ opacity: 0.75, fontSize: 12 }}>
                    {formatUtcAuditDateTime(e.createdAt)}
                  </div>
                </div>
                <div style={{ fontSize: 12, opacity: 0.75 }}>
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
      </section>

      <section
        data-section="audit-deep-links"
        style={{
          padding: "1rem 1.1rem",
          border: "1px solid rgba(127,127,127,0.3)",
          borderRadius: 8,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16 }}>Federated audit surface</h2>
        <ul style={{ listStyle: "none", padding: 0, margin: "0.5rem 0 0" }}>
          <DeepLink
            testId="audit-deep-link-transparency"
            label="Audit &amp; Transparency Center"
            description="Cross-organization audit feed with verification manifests."
            href="/audit-transparency"
          />
        </ul>
      </section>
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
        padding: "0.5rem 0",
        borderBottom: "1px solid rgba(127,127,127,0.18)",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div style={{ minWidth: 0, flex: "1 1 auto" }}>
        <div style={{ fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: 12, opacity: 0.75 }}>{description}</div>
      </div>
      <Link
        href={href}
        data-testid={testId}
        className="cases-filter-chip"
      >
        Open →
      </Link>
    </li>
  );
}
