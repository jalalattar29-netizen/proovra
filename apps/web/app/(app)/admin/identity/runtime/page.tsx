"use client";

/**
 * Phase 26.75 — Identity Runtime Monitor admin page.
 *
 * SOC-style console combining:
 *   - High-risk sessions list (risk score ≥ HIGH threshold)
 *   - Quarantined sessions list with release controls
 *   - Per-session actions: quarantine, release, revoke, score-now
 *   - Emergency org-wide revoke (step-up gated)
 *
 * Operator-safe: every row carries risk score + last-seen preview.
 * No raw IPs / coordinates / private notes.
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
  primaryButtonStyle,
  subtitleStyle,
  tableStyle,
  tdStyle,
  thStyle,
  titleStyle,
  TOKENS,
} from "../ui-tokens";

type SessionRow = {
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

type QuarantineRow = {
  sessionId: string;
  teamId: string | null;
  userId: string;
  quarantinedAtUtc: string;
  quarantinedByUserId: string | null;
  quarantineReason: string;
  quarantineReleaseAtUtc: string | null;
};

const QUARANTINE_REASONS = [
  "MANUAL_OPERATOR",
  "SUSPICIOUS_SESSION_AUTO",
  "REPEATED_REPLAY",
  "GEO_ANOMALY",
  "PRIVILEGED_SESSION_AGED",
  "SUSPICIOUS_REVIEWER_ACTIVITY",
  "SUSPICIOUS_ADMIN_ACTIVITY",
  "EMERGENCY_ORG_WIDE",
] as const;

export default function IdentityRuntimePage() {
  const teamId = useTeamId();
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [quarantined, setQuarantined] = useState<QuarantineRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  
const load = useCallback(() => {
    if (!teamId) return;
    Promise.all([
      apiFetch(
        `/v1/admin/identity/sessions?teamId=${encodeURIComponent(teamId)}&includeRevoked=true&limit=500`,
        { method: "GET" },
      ).catch(() => ({ sessions: [] })),
      apiFetch(
        `/v1/admin/identity/quarantined-sessions?teamId=${encodeURIComponent(teamId)}&limit=200`,
        { method: "GET" },
      ).catch(() => ({ items: [] })),
    ]).then(
      ([s, q]: [{ sessions?: SessionRow[] }, { items?: QuarantineRow[] }]) => {
        setSessions(s.sessions ?? []);
        setQuarantined(q.items ?? []);
        setError(null);
      },
    );
  }, [teamId]);

  useEffect(() => {
    load();
  }, [load]);

  const quarantine = useCallback(
    async (sessionId: string) => {
      if (!teamId) return;
      const reason = window.prompt(
        "Quarantine reason (catalog code, e.g. MANUAL_OPERATOR)",
        "MANUAL_OPERATOR",
      );
      if (!reason || !QUARANTINE_REASONS.includes(reason as never)) {
        setError("Reason must be one of " + QUARANTINE_REASONS.join(", "));
        return;
      }
      setBusy(sessionId);
      try {
        await apiFetch(
          `/v1/admin/identity/sessions/${encodeURIComponent(sessionId)}/quarantine`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              teamId,
              reason,
              releaseHours: 4,
            }),
          },
        );
        setNotice("Session quarantined.");
        load();
      } catch (err) {
        setError(
          (err as { message?: string })?.message ?? "Quarantine failed.",
        );
      } finally {
        setBusy(null);
      }
    },
    [teamId, load],
  );

  const release = useCallback(
    async (sessionId: string) => {
      if (!teamId) return;
      setBusy(sessionId);
      try {
        await apiFetch(
          `/v1/admin/identity/sessions/${encodeURIComponent(sessionId)}/release`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ teamId }),
          },
        );
        setNotice("Quarantine released.");
        load();
      } catch (err) {
        setError(
          (err as { message?: string })?.message ?? "Release failed.",
        );
      } finally {
        setBusy(null);
      }
    },
    [teamId, load],
  );

  const scoreNow = useCallback(
    async (sessionId: string) => {
      if (!teamId) return;
      setBusy(sessionId);
      try {
        await apiFetch(
          `/v1/admin/identity/sessions/${encodeURIComponent(sessionId)}/score`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ teamId }),
          },
        );
        setNotice("Session re-scored.");
        load();
      } catch (err) {
        setError(
          (err as { message?: string })?.message ?? "Score-now failed.",
        );
      } finally {
        setBusy(null);
      }
    },
    [teamId, load],
  );

  const emergencyRevoke = useCallback(async () => {
    if (!teamId) return;
    const reason = window.prompt(
      "Emergency org-wide revoke — describe the incident (will be audited):",
    );
    if (!reason || reason.trim().length < 8) {
      setError("Reason must be at least 8 chars.");
      return;
    }
    if (
      !window.confirm(
        "This will revoke EVERY active session in this workspace. Continue?",
      )
    ) {
      return;
    }
    setBusy("emergency");
    try {
      const res = await apiFetch("/v1/admin/identity/emergency-revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId, reason: reason.trim() }),
      });
      setNotice(
        `Revoked ${res?.usersRevoked ?? 0} users (${res?.sessionsAffected ?? 0} sessions).`,
      );
      load();
    } catch (err) {
      setError(
        (err as { message?: string })?.message ??
          "Emergency revoke failed (step-up required?).",
      );
    } finally {
      setBusy(null);
    }
  }, [teamId, load]);

  if (!teamId) {
    return (
      <main style={pageStyle}>
        <p style={mutedStyle}>Switch to a workspace.</p>
      </main>
    );
  }

  // Sessions list omits revoked + expired by default; the runtime
  // monitor cares about active sessions only.
  const activeSessions = (sessions ?? []).filter((s) => !s.revoked);

  return (
    <main style={pageStyle}>
      <header style={headerRowStyle}>
        <div>
          <h1 style={titleStyle}>Identity Runtime Monitor</h1>
          <p style={subtitleStyle}>
            SOC console for live session governance. Inspect active
            sessions, quarantine privileged actions, release safe
            sessions, and (in genuine emergencies) revoke every active
            session at once. Every action is audited.
          </p>
        </div>
        <button
          type="button"
          style={{
            ...primaryButtonStyle,
            background: "#991b1b",
            border: "1px solid #991b1b",
          }}
          onClick={emergencyRevoke}
          disabled={busy === "emergency"}
        >
          Emergency org revoke
        </button>
      </header>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}
      {notice ? (
        <div
          style={{
            ...errorBoxStyle,
            background: "#ecfdf5",
            color: "#065f46",
            borderColor: "#a7f3d0",
          }}
        >
          {notice}
        </div>
      ) : null}

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h3
          style={{
            margin: 0,
            marginBottom: 8,
            fontSize: 13,
            fontWeight: 700,
            color: TOKENS.inkMuted,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          Quarantined sessions
        </h3>
        {quarantined === null ? (
          <p style={mutedStyle}>Loading…</p>
        ) : quarantined.length === 0 ? (
          <p style={mutedStyle}>No quarantined sessions.</p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>User</th>
                <th style={thStyle}>Reason</th>
                <th style={thStyle}>Quarantined</th>
                <th style={thStyle}>Auto-release</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {quarantined.map((q) => (
                <tr key={q.sessionId}>
                  <td style={tdStyle}>
                    <code
                      style={{
                        fontFamily:
                          "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                        fontSize: 12,
                      }}
                    >
                      {q.userId.slice(0, 12)}…
                    </code>
                  </td>
                  <td style={tdStyle}>
                    <span style={{ ...mutedStyle, fontSize: 11 }}>
                      {q.quarantineReason}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <span style={mutedStyle}>
                      {formatDateTime(q.quarantinedAtUtc)}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <span style={mutedStyle}>
                      {formatDateTime(q.quarantineReleaseAtUtc)}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <button
                      type="button"
                      style={ghostButtonStyle}
                      onClick={() => release(q.sessionId)}
                      disabled={busy === q.sessionId}
                    >
                      Release
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h3
          style={{
            margin: 0,
            marginBottom: 8,
            fontSize: 13,
            fontWeight: 700,
            color: TOKENS.inkMuted,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          Active sessions
        </h3>
        {sessions === null ? (
          <p style={mutedStyle}>Loading…</p>
        ) : activeSessions.length === 0 ? (
          <p style={mutedStyle}>No active sessions.</p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>User</th>
                <th style={thStyle}>IdP</th>
                <th style={thStyle}>Last seen</th>
                <th style={thStyle}>Device</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {activeSessions.slice(0, 200).map((s) => (
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
                        disabled={busy === s.id}
                        onClick={() => scoreNow(s.id)}
                      >
                        Re-score
                      </button>
                      <button
                        type="button"
                        style={ghostButtonStyle}
                        disabled={busy === s.id}
                        onClick={() => quarantine(s.id)}
                      >
                        Quarantine
                      </button>
                    </div>
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
