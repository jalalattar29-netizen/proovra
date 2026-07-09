"use client";

/**
 * Phase 26 + Phase P1.1 — Active Sessions admin page.
 *
 * Workspace-wide active session inventory with per-session revoke +
 * per-user revoke-all. Shows IP / UA previews (no raw values).
 *
 * Phase P1.1 addition — Bounded session identity timeline drawer.
 * Click "View timeline" on any session to open a drawer that lists
 * the identity-security events that occurred during the session's
 * lifecycle (login, MFA, step-up, quarantine, revoke). This is NOT
 * surveillance: only the bounded event-type allowlist is surfaced;
 * page views, mouse activity, evidence content reads are never
 * included. IP/UA/device telemetry is omitted from the timeline.
 */

import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { useTeamId } from "../../../../../lib/platform-context";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import {
  badgeStyle,
  errorBoxStyle,
  formatDateTime,
  ghostButtonStyle,
  mutedStyle,
  sectionTitleStyle,
  statusBadgeStyle,
  tableStyle,
  tdStyle,
  TOKENS,
} from "../ui-tokens";
import { PageShell, PageHeader, PageSection } from "../../../../../components/ui/PageShell";
import { Button } from "../../../../../components/ui/Button";
import { EmptyState } from "../../../../../components/ui/EmptyState";
import { DataTable, type DataTableColumn } from "../../../../../components/ui/DataTable";

type ActiveSession = {
  id: string;
  teamId: string | null;
  userId: string;
  ssoConnectionId: string | null;
  issuedAtUtc: string;
  expiresAtUtc: string;
  lastSeenAtUtc: string;
  ipPreview: string | null;
  uaPreview: string | null;
  revoked: boolean;
  revokedAtUtc: string | null;
  revokedReason: string | null;
};

type IdentityTimelineEvent = {
  id: string;
  occurredAtUtc: string;
  eventType: string;
  severity: "INFO" | "WARNING" | "HIGH";
  summary: string;
};

type IdentitySessionTimeline = {
  sessionId: string;
  teamId: string;
  session: {
    issuedAtUtc: string;
    expiresAtUtc: string | null;
    lastSeenAtUtc: string | null;
    revokedAtUtc: string | null;
    revocationReason: string | null;
    ssoConnectionId: string | null;
  };
  events: ReadonlyArray<IdentityTimelineEvent>;
  truncated: boolean;
};

export default function SessionsPage() {
  const teamId = useTeamId();
  const [sessions, setSessions] = useState<ActiveSession[] | null>(null);
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const [includeExpired, setIncludeExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [timelineFor, setTimelineFor] = useState<string | null>(null);
  const { confirm } = useConfirmAction();

  const load = useCallback(() => {
    if (!teamId) return;
    const qs = new URLSearchParams();
    qs.set("teamId", teamId);
    qs.set("includeRevoked", String(includeRevoked));
    qs.set("includeExpired", String(includeExpired));
    qs.set("limit", "200");
    apiFetch(`/v1/admin/identity/sessions?${qs.toString()}`, {
      method: "GET",
    })
      .then((r: { sessions: ActiveSession[] }) => {
        setSessions(r.sessions ?? []);
        setError(null);
      })
      .catch((err: { message?: string }) =>
        setError(toSafeUserError(err, { message: "Could not load sessions." }).message),
      );
  }, [teamId, includeRevoked, includeExpired]);

  useEffect(() => {
    load();
  }, [load]);

  const revoke = useCallback(
    async (id: string) => {
      if (!teamId) return;
      const ok = await confirm({
        title: "Revoke this session?",
        description:
          "The user will be signed out from this device immediately. They can sign back in if their account is otherwise active.",
        confirmLabel: "Revoke session",
        tone: "danger",
        testId: "identity-session-revoke",
      });
      if (!ok) return;
      setBusy(id);
      try {
        await apiFetch(
          `/v1/admin/identity/sessions/${encodeURIComponent(id)}/revoke`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              teamId,
              reason: "OPERATOR_REVOKED",
            }),
          },
        );
        load();
      } catch (err) {
        setError(
          toSafeUserError(err, { message: "Revoke failed." }).message,
        );
      } finally {
        setBusy(null);
      }
    },
    [teamId, load],
  );

  const revokeAllForUser = useCallback(
    async (userId: string) => {
      if (!teamId) return;
      const ok = await confirm({
        title: "Revoke ALL sessions for this user?",
        description: `User ${userId.slice(0, 12)}… will be signed out from every device. This requires step-up authentication on the next request.`,
        confirmLabel: "Revoke all sessions",
        tone: "danger",
        testId: "identity-session-revoke-all-for-user",
      });
      if (!ok) return;
      setBusy(`all-${userId}`);
      try {
        await apiFetch(
          `/v1/admin/identity/sessions/user/${encodeURIComponent(
            userId,
          )}/revoke-all`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              teamId,
              reason: "OPERATOR_REVOKED",
            }),
          },
        );
        load();
      } catch (err) {
        setError(
          toSafeUserError(err, { message: "Bulk revoke failed (step-up required?)." }).message,
        );
      } finally {
        setBusy(null);
      }
    },
    [teamId, load],
  );

  if (!teamId) {
    return (
      <PageShell header={<PageHeader eyebrow="Identity operations" title="Active Sessions" />}>
        <EmptyState
          framed
          title="No workspace selected"
          purpose="Switch to a workspace to view and revoke its active session inventory."
        />
      </PageShell>
    );
  }

  const columns: DataTableColumn<ActiveSession>[] = [
    {
      key: "user",
      header: "User",
      render: (s) => (
        <code
          style={{
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            fontSize: 12,
          }}
        >
          {s.userId.slice(0, 12)}…
        </code>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (s) =>
        s.revoked ? (
          <span style={statusBadgeStyle("REVOKED")}>revoked</span>
        ) : new Date(s.expiresAtUtc) < new Date() ? (
          <span style={statusBadgeStyle("DISABLED")}>expired</span>
        ) : (
          <span style={statusBadgeStyle("ACTIVE")}>active</span>
        ),
    },
    {
      key: "sso",
      header: "SSO",
      render: (s) => (
        <span style={{ ...mutedStyle, fontSize: 11 }}>
          {s.ssoConnectionId ? s.ssoConnectionId.slice(0, 8) + "…" : "—"}
        </span>
      ),
    },
    {
      key: "lastseen",
      header: "Last seen",
      nowrap: true,
      render: (s) => <span style={mutedStyle}>{formatDateTime(s.lastSeenAtUtc)}</span>,
    },
    {
      key: "issued",
      header: "Issued",
      nowrap: true,
      render: (s) => <span style={mutedStyle}>{formatDateTime(s.issuedAtUtc)}</span>,
    },
    {
      key: "expires",
      header: "Expires",
      nowrap: true,
      render: (s) => <span style={mutedStyle}>{formatDateTime(s.expiresAtUtc)}</span>,
    },
    {
      key: "device",
      header: "Device",
      render: (s) => (
        <div style={{ fontSize: 11 }}>
          <div>{s.ipPreview ?? "—"}</div>
          <div style={mutedStyle}>{s.uaPreview ?? "—"}</div>
        </div>
      ),
    },
  ];

  return (
    <PageShell
      header={
        <PageHeader
          eyebrow="Identity operations"
          title="Active Sessions"
          subtitle={
            <>
              Workspace session inventory. IP + device previews shown; raw
              values never persisted. Revoke goes through the Phase 19
              session-revocation registry — JWT middleware rejects on the
              next request. Click <strong>View timeline</strong> on any row
              for the bounded identity-event reconstruction (login, MFA,
              step-up, quarantine, revoke).
            </>
          }
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
        <div
          style={{
            display: "flex",
            gap: 16,
            alignItems: "center",
            flexWrap: "wrap",
            marginBottom: 12,
          }}
        >
          <label style={{ fontSize: 12 }}>
            <input
              type="checkbox"
              checked={includeRevoked}
              onChange={(e) => setIncludeRevoked(e.target.checked)}
            />{" "}
            Show revoked
          </label>
          <label style={{ fontSize: 12 }}>
            <input
              type="checkbox"
              checked={includeExpired}
              onChange={(e) => setIncludeExpired(e.target.checked)}
            />{" "}
            Show expired
          </label>
        </div>
        <DataTable
          columns={columns}
          rows={sessions ?? []}
          getRowId={(s) => s.id}
          loading={sessions === null}
          ariaLabel="Active sessions inventory"
          emptyState={
            <EmptyState
              title="No active sessions"
              purpose="No sessions match the current filters. Toggle Show revoked / Show expired or refresh to broaden the view."
            />
          }
          rowActions={(s) => (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setTimelineFor(s.id)}
              >
                View timeline
              </Button>
              {!s.revoked ? (
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy === s.id}
                  onClick={() => revoke(s.id)}
                >
                  Revoke
                </Button>
              ) : null}
              <Button
                variant="destructive"
                size="sm"
                disabled={busy === `all-${s.userId}`}
                onClick={() => revokeAllForUser(s.userId)}
              >
                Revoke all for user
              </Button>
            </div>
          )}
        />
      </PageSection>

      {timelineFor ? (
        <SessionTimelineDrawer
          teamId={teamId}
          sessionId={timelineFor}
          onClose={() => setTimelineFor(null)}
        />
      ) : null}
    </PageShell>
  );
}

// ============================================================================
// Session Timeline Drawer (Phase P1.1)
// ============================================================================

function severityBadge(s: "INFO" | "WARNING" | "HIGH") {
  if (s === "HIGH")
    return badgeStyle({ bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" });
  if (s === "WARNING")
    return badgeStyle({ bg: "#fef3c7", fg: "#78350f", border: "#fde68a" });
  return badgeStyle({ bg: "#f1f5f9", fg: "#475569", border: "#cbd5e1" });
}

function SessionTimelineDrawer({
  teamId,
  sessionId,
  onClose,
}: {
  teamId: string;
  sessionId: string;
  onClose: () => void;
}) {
  const [timeline, setTimeline] = useState<IdentitySessionTimeline | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch(
      `/v1/identity/sessions/${encodeURIComponent(
        sessionId,
      )}/timeline?teamId=${encodeURIComponent(teamId)}`,
      { method: "GET" },
    )
      .then((r: { timeline: IdentitySessionTimeline }) =>
        setTimeline(r.timeline),
      )
      .catch((err: { message?: string }) =>
        setError(toSafeUserError(err, { message: "Could not load timeline." }).message),
      );
  }, [teamId, sessionId]);

  return (
    <div
      role="dialog"
      aria-label="Session identity timeline"
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        height: "100vh",
        width: "min(560px, 100vw)",
        background: TOKENS.surface,
        borderLeft: `1px solid ${TOKENS.border}`,
        boxShadow: "0 0 40px rgba(15, 23, 42, 0.1)",
        zIndex: 50,
        overflowY: "auto",
        padding: 20,
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <h2 style={{ fontSize: 16, margin: 0 }}>Session timeline</h2>
        <button
          type="button"
          style={ghostButtonStyle}
          onClick={onClose}
          aria-label="Close timeline drawer"
        >
          Close
        </button>
      </header>

      <p style={mutedStyle}>
        Bounded reconstruction of identity events that occurred during this
        session's lifecycle. Excludes page views, mouse activity, and
        evidence-content reads.
      </p>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {!timeline ? (
        <p style={mutedStyle}>Loading…</p>
      ) : (
        <>
          <section style={{ marginTop: 12 }}>
            <h3 style={sectionTitleStyle}>Session</h3>
            <table style={tableStyle}>
              <tbody>
                <tr>
                  <td style={tdStyle}>Issued</td>
                  <td style={tdStyle}>
                    {formatDateTime(timeline.session.issuedAtUtc)}
                  </td>
                </tr>
                <tr>
                  <td style={tdStyle}>Expires</td>
                  <td style={tdStyle}>
                    {formatDateTime(timeline.session.expiresAtUtc)}
                  </td>
                </tr>
                <tr>
                  <td style={tdStyle}>Last seen</td>
                  <td style={tdStyle}>
                    {formatDateTime(timeline.session.lastSeenAtUtc)}
                  </td>
                </tr>
                {timeline.session.revokedAtUtc ? (
                  <tr>
                    <td style={tdStyle}>Revoked</td>
                    <td style={tdStyle}>
                      {formatDateTime(timeline.session.revokedAtUtc)} (
                      {timeline.session.revocationReason ?? "unspecified"})
                    </td>
                  </tr>
                ) : null}
                {timeline.session.ssoConnectionId ? (
                  <tr>
                    <td style={tdStyle}>SSO connection</td>
                    <td style={tdStyle}>
                      <code
                        style={{
                          fontFamily: "monospace",
                          fontSize: 12,
                        }}
                      >
                        {timeline.session.ssoConnectionId.slice(0, 8)}…
                      </code>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </section>

          <section style={{ marginTop: 16 }}>
            <h3 style={sectionTitleStyle}>
              Identity events ({timeline.events.length}
              {timeline.truncated ? " of 200+" : ""})
            </h3>
            {timeline.events.length === 0 ? (
              <p style={mutedStyle}>
                No bounded identity events recorded for this session.
              </p>
            ) : (
              <ol
                style={{
                  margin: 0,
                  padding: 0,
                  listStyle: "none",
                  borderLeft: `2px solid ${TOKENS.border}`,
                }}
              >
                {timeline.events.map((e) => (
                  <li
                    key={e.id}
                    style={{
                      marginLeft: 12,
                      paddingLeft: 12,
                      paddingBottom: 12,
                      position: "relative",
                    }}
                  >
                    <span
                      style={{
                        position: "absolute",
                        left: -7,
                        top: 4,
                        width: 10,
                        height: 10,
                        borderRadius: 999,
                        background: TOKENS.surface,
                        border: `2px solid ${TOKENS.borderStrong}`,
                      }}
                    />
                    <div
                      style={{
                        display: "flex",
                        gap: 6,
                        alignItems: "center",
                        marginBottom: 2,
                      }}
                    >
                      <span style={severityBadge(e.severity)}>{e.severity}</span>
                      <code
                        style={{
                          ...mutedStyle,
                          fontFamily: "monospace",
                          fontSize: 11,
                        }}
                      >
                        {e.eventType}
                      </code>
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>
                      {e.summary}
                    </div>
                    <div style={{ ...mutedStyle, fontSize: 11 }}>
                      {formatDateTime(e.occurredAtUtc)}
                    </div>
                  </li>
                ))}
              </ol>
            )}
            {timeline.truncated ? (
              <p style={{ ...mutedStyle, marginTop: 8 }}>
                ⚠ More than 200 events recorded for this session — older
                events have been truncated. Use Audit Center for the full
                event history.
              </p>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}
