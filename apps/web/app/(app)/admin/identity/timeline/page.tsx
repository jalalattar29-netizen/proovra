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

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { useTeamId } from "../../../../../lib/platform-context";
import {
  cardStyle,
  errorBoxStyle,
  formatDateTime,
  ghostButtonStyle,
  headerRowStyle,
  mutedStyle,
  pageStyle,
  selectStyle,
  statusBadgeStyle,
  subtitleStyle,
  tableStyle,
  tdStyle,
  thStyle,
  titleStyle,
  TOKENS,
} from "../ui-tokens";

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

const SEVERITY_BORDER: Record<TimelineEvent["severity"], string> = {
  INFO: TOKENS.border,
  WARNING: "#fde68a",
  HIGH: "#fecaca",
};

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
        setError(err?.message ?? "Could not load timeline."),
      );
  }, [teamId, filterIdx, severityFilter]);

  useEffect(() => {
    load();
  }, [load]);

  if (!teamId) {
    return (
      <main style={pageStyle}>
        <p style={mutedStyle}>Switch to a workspace.</p>
      </main>
    );
  }

  return (
    <main style={pageStyle}>
      <header style={headerRowStyle}>
        <div>
          <h1 style={titleStyle}>Identity Audit</h1>
          <p style={subtitleStyle}>
            Workspace-wide identity events: SSO logins, SCIM syncs,
            session revocations, suspicious sessions, temporary
            elevations, access reviews, and adaptive auth decisions.
            Sourced from the Phase 21 SecurityEvent table — operator-
            safe projections only.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select
            style={selectStyle}
            value={filterIdx}
            onChange={(e) => setFilterIdx(Number(e.target.value))}
          >
            {FILTERS.map((f, i) => (
              <option key={f.label} value={i}>
                {f.label}
              </option>
            ))}
          </select>
          <select
            style={selectStyle}
            value={severityFilter}
            onChange={(e) =>
              setSeverityFilter(e.target.value as "" | "INFO" | "WARNING" | "HIGH")
            }
          >
            <option value="">All severities</option>
            <option value="INFO">Info</option>
            <option value="WARNING">Warning</option>
            <option value="HIGH">High</option>
          </select>
          <button type="button" style={ghostButtonStyle} onClick={load}>
            Refresh
          </button>
        </div>
      </header>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      <section style={{ ...cardStyle, marginTop: 16, padding: 0 }}>
        {events === null ? (
          <p style={{ ...mutedStyle, padding: 16 }}>Loading…</p>
        ) : events.length === 0 ? (
          <p style={{ ...mutedStyle, padding: 24 }}>No events match.</p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>When</th>
                <th style={thStyle}>Severity</th>
                <th style={thStyle}>Event</th>
                <th style={thStyle}>Summary</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr
                  key={e.id}
                  style={{
                    borderLeft: `3px solid ${SEVERITY_BORDER[e.severity]}`,
                  }}
                >
                  <td style={tdStyle}>
                    <span style={mutedStyle}>
                      {formatDateTime(e.occurredAtUtc)}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <span style={statusBadgeStyle(e.severity)}>
                      {e.severity}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <code
                      style={{
                        fontFamily:
                          "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                        fontSize: 12,
                      }}
                    >
                      {e.kind}
                    </code>
                  </td>
                  <td style={tdStyle}>
                    <span style={{ fontSize: 12 }}>{e.summary}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
