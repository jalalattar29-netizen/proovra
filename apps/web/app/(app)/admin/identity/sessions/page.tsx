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

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { useTeamId } from "../../../../../lib/platform-context";
import {
  badgeStyle,
  cardStyle,
  errorBoxStyle,
  formatDateTime,
  ghostButtonStyle,
  headerRowStyle,
  mutedStyle,
  pageStyle,
  sectionTitleStyle,
  statusBadgeStyle,
  subtitleStyle,
  tableStyle,
  tdStyle,
  thStyle,
  titleStyle,
  TOKENS,
} from "../ui-tokens";

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
        setError(err?.message ?? "Could not load sessions."),
      );
  }, [teamId, includeRevoked, includeExpired]);

  useEffect(() => {
    load();
  }, [load]);

  const revoke = useCallback(
    async (id: string) => {
      if (!teamId) return;
      if (!window.confirm("Revoke this session?")) return;
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
          (err as { message?: string })?.message ?? "Revoke failed.",
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
      if (
        !window.confirm(
          `Revoke ALL sessions for user ${userId.slice(0, 12)}…? This will require step-up.`,
        )
      ) {
        return;
      }
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
          (err as { message?: string })?.message ??
            "Bulk revoke failed (step-up required?).",
        );
      } finally {
        setBusy(null);
      }
    },
    [teamId, load],
  );

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
          <h1 style={titleStyle}>Active Sessions</h1>
          <p style={subtitleStyle}>
            Workspace session inventory. IP + device previews shown; raw
            values never persisted. Revoke goes through the Phase 19
            session-revocation registry — JWT middleware rejects on the
            next request. Click <strong>View timeline</strong> on any row
            for the bounded identity-event reconstruction (login, MFA,
            step-up, quarantine, revoke).
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
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
          <button type="button" style={ghostButtonStyle} onClick={load}>
            Refresh
          </button>
        </div>
      </header>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      <section style={{ ...cardStyle, marginTop: 16, padding: 0 }}>
        {sessions === null ? (
          <p style={{ ...mutedStyle, padding: 16 }}>Loading…</p>
        ) : sessions.length === 0 ? (
          <p style={{ ...mutedStyle, padding: 24 }}>No sessions match.</p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>User</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>SSO</th>
                <th style={thStyle}>Last seen</th>
                <th style={thStyle}>Issued</th>
                <th style={thStyle}>Expires</th>
                <th style={thStyle}>Device</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td style={tdStyle}>
                    <code
                      style={{
                        fontFamily:
                          "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                        fontSize: 12,
                      }}
                    >
                      {s.userId.slice(0, 12)}…
                    </code>
                  </td>
                  <td style={tdStyle}>
                    {s.revoked ? (
                      <span style={statusBadgeStyle("REVOKED")}>revoked</span>
                    ) : new Date(s.expiresAtUtc) < new Date() ? (
                      <span style={statusBadgeStyle("DISABLED")}>expired</span>
                    ) : (
                      <span style={statusBadgeStyle("ACTIVE")}>active</span>
                    )}
                  </td>
                  <td style={tdStyle}>
                    <span style={{ ...mutedStyle, fontSize: 11 }}>
                      {s.ssoConnectionId
                        ? s.ssoConnectionId.slice(0, 8) + "…"
                        : "—"}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <span style={mutedStyle}>
                      {formatDateTime(s.lastSeenAtUtc)}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <span style={mutedStyle}>
                      {formatDateTime(s.issuedAtUtc)}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <span style={mutedStyle}>
                      {formatDateTime(s.expiresAtUtc)}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <div style={{ fontSize: 11 }}>
                      <div>{s.ipPreview ?? "—"}</div>
                      <div style={mutedStyle}>{s.uaPreview ?? "—"}</div>
                    </div>
                  </td>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      <button
                        type="button"
                        style={ghostButtonStyle}
                        onClick={() => setTimelineFor(s.id)}
                      >
                        View timeline
                      </button>
                      {!s.revoked ? (
                        <button
                          type="button"
                          style={ghostButtonStyle}
                          disabled={busy === s.id}
                          onClick={() => revoke(s.id)}
                        >
                          Revoke
                        </button>
                      ) : null}
                      <button
                        type="button"
                        style={ghostButtonStyle}
                        disabled={busy === `all-${s.userId}`}
                        onClick={() => revokeAllForUser(s.userId)}
                      >
                        Revoke all for user
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {timelineFor ? (
        <SessionTimelineDrawer
          teamId={teamId}
          sessionId={timelineFor}
          onClose={() => setTimelineFor(null)}
        />
      ) : null}
    </main>
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
        setError(err?.message ?? "Could not load timeline."),
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
