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

  const [filter, setFilter] = useState<string>("");
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
          <select
            data-testid="audit-type-filter"
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
            style={{ listStyle: "none", padding: 0, margin: 0 }}
          >
            {audit.data.events.length === 0 ? (
              <li
                data-empty-state="no-audit-events"
                style={{ padding: "0.5rem 0", fontSize: 13, opacity: 0.75 }}
              >
                {filter
                  ? `No events matching ${filter}.`
                  : "No audit events yet."}
              </li>
            ) : null}
            {audit.data.events.map((e) => (
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
