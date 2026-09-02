"use client";

/**
 * Phase 26.5 — Identity Event Timeline admin page.
 *
 * Single chronological feed of every identity-governance event:
 * SSO logins, SCIM syncs, session revocations, suspicious sessions,
 * temporary elevations, access reviews, trusted-device changes,
 * step-up events, privilege changes.
 *
 * Operator-safe: each row carries the eventType + a humanised label.
 * No private notes, no raw IPs, no secrets.
 */

import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { useTeamId } from "../../../../../lib/platform-context";
import {
  errorBoxStyle,
  formatDateTime,
  mutedStyle,
  statusBadgeStyle,
} from "../ui-tokens";
import { PageShell, PageHeader, PageSection } from "../../../../../components/ui/PageShell";
import { Button } from "../../../../../components/ui/Button";
import { FilterBar } from "../../../../../components/ui/FilterBar";
import { EmptyState } from "../../../../../components/ui/EmptyState";
import { DataTable, type DataTableColumn } from "../../../../../components/ui/DataTable";
import { ResultCount } from "../../../../../components/ui/ResultCount";

type TimelineEvent = {
  id: string;
  kind: string;
  severity: "INFO" | "WARNING" | "HIGH";
  occurredAtUtc: string;
  actorUserId: string | null;
  summary: string;
};

const FILTERS: { label: string; kinds: string }[] = [
  { label: "All identity events", kinds: "" },
  {
    label: "SSO",
    kinds: [
      "sso_login_started",
      "sso_login_succeeded",
      "sso_login_failed",
      "sso_jit_provisioned",
      "sso_jit_denied",
      "sso_callback_replay_detected",
      "sso_state_expired",
      "sso_connection_created",
      "sso_connection_revoked",
      "idp_outage_detected",
      "idp_outage_cleared",
    ].join(","),
  },
  {
    label: "SCIM",
    kinds: [
      "scim_token_created",
      "scim_token_revoked",
      "scim_user_created",
      "scim_user_deactivated",
      "scim_group_created",
      "scim_group_updated",
      "scim_group_synced",
      "scim_group_deleted",
      "scim_group_membership_changed",
    ].join(","),
  },
  {
    label: "Sessions",
    kinds: [
      "session_revoked_admin",
      "all_sessions_revoked_admin",
      "session_inventory_viewed",
      "suspicious_session_detected",
      "forced_reauthentication",
      "session_replay_detected",
      "session_heartbeat_timeout",
      "stale_session_swept",
    ].join(","),
  },
  {
    label: "Adaptive auth + RBAC",
    kinds: [
      "adaptive_step_up_triggered",
      "adaptive_block_triggered",
      "rbac_temporary_elevation_granted",
      "rbac_temporary_elevation_expired",
      "rbac_permission_matrix_viewed",
    ].join(","),
  },
  {
    label: "Access reviews",
    kinds: ["access_review_initiated", "access_review_completed", "access_review_decided"].join(","),
  },
  {
    label: "High severity only",
    kinds: "", // server-side severity filter handled below
  },
];

export default function IdentityTimelinePage() {
  const teamId = useTeamId();
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filterIdx, setFilterIdx] = useState(0);
  const [severityFilter, setSeverityFilter] = useState<"" | "INFO" | "WARNING" | "HIGH">("");

  
const load = useCallback(() => {
    if (!teamId) return;
    const filter = FILTERS[filterIdx];
    const qs = new URLSearchParams();
    qs.set("teamId", teamId);
    if (filter.kinds) qs.set("kinds", filter.kinds);
    qs.set("limit", "250");
    apiFetch(`/v1/admin/identity/timeline?${qs.toString()}`, { method: "GET" })
      .then((r: { events: TimelineEvent[] }) => {
        const all = r.events ?? [];
        setEvents(
          severityFilter ? all.filter((e) => e.severity === severityFilter) : all,
        );
        setError(null);
      })
      .catch((err: { message?: string }) =>
        setError(toSafeUserError(err, { message: "Could not load timeline." }).message),
      );
  }, [teamId, filterIdx, severityFilter]);

  useEffect(() => {
    load();
  }, [load]);

  if (!teamId) {
    return (
      <PageShell header={<PageHeader eyebrow="Identity operations" title="Identity Audit" />}>
        <EmptyState
          framed
          title="No workspace selected"
          purpose="Switch to a workspace to view its identity-governance event timeline."
        />
      </PageShell>
    );
  }

  const columns: DataTableColumn<TimelineEvent>[] = [
    {
      key: "when",
      header: "When",
      nowrap: true,
      render: (e) => (
        <span style={mutedStyle}>{formatDateTime(e.occurredAtUtc)}</span>
      ),
    },
    {
      key: "severity",
      header: "Severity",
      render: (e) => (
        <span style={statusBadgeStyle(e.severity)}>{e.severity}</span>
      ),
    },
    {
      key: "kind",
      header: "Event",
      render: (e) => (
        <code
          style={{
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            fontSize: 12,
          }}
        >
          {e.kind}
        </code>
      ),
    },
    {
      key: "summary",
      header: "Summary",
      render: (e) => <span style={{ fontSize: 12 }}>{e.summary}</span>,
    },
  ];

  return (
    <PageShell
      header={
        <PageHeader
          eyebrow="Identity operations"
          title="Identity Audit"
          subtitle="Workspace-wide identity events: SSO logins, SCIM syncs, session revocations, suspicious sessions, temporary elevations, access reviews, and adaptive auth decisions. Sourced from the Phase 21 SecurityEvent table — operator-safe projections only."
          secondaryActions={
            <Button variant="secondary" onClick={load}>
              Refresh
            </Button>
          }
        />
      }
    >
      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      <PageSection>
        <FilterBar>
          <FilterBar.Select
            label="Event category"
            value={String(filterIdx)}
            onChange={(v) => setFilterIdx(Number(v))}
            options={FILTERS.map((f, i) => ({
              value: String(i),
              label: f.label,
            }))}
          />
          <FilterBar.Select
            label="Severity"
            value={severityFilter}
            onChange={(v) =>
              setSeverityFilter(v as "" | "INFO" | "WARNING" | "HIGH")
            }
            options={[
              { value: "", label: "All severities" },
              { value: "INFO", label: "Info" },
              { value: "WARNING", label: "Warning" },
              { value: "HIGH", label: "High" },
            ]}
          />
        </FilterBar>
        <div style={{ marginTop: 12 }}>
          <DataTable
            columns={columns}
            rows={events ?? []}
            getRowId={(e) => e.id}
            loading={events === null}
            ariaLabel="Identity event timeline"
            emptyState={
              <EmptyState
                title="No identity events"
                purpose="No events match the selected category and severity. Adjust the filters or refresh."
              />
            }
          />
          {/* The identity audit asks for 250 events. A bare count on a capped feed reads as the total. */}
          <ResultCount
            shown={events?.length ?? 0}
            cap={250}
            noun="event"
            filtered={filterIdx !== 0 || severityFilter !== ""}
            loading={events === null}
            data-testid="admin-identity-timeline-count"
          />
        </div>
      </PageSection>
    </PageShell>
  );
}
