"use client";

/**
 * Phase 26 — Active Sessions admin page.
 *
 * Workspace-wide active session inventory with per-session revoke +
 * per-user revoke-all. Shows IP / UA previews (no raw values).
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import {
  cardStyle,
  errorBoxStyle,
  formatDateTime,
  ghostButtonStyle,
  headerRowStyle,
  mutedStyle,
  pageStyle,
  statusBadgeStyle,
  subtitleStyle,
  tableStyle,
  tdStyle,
  thStyle,
  titleStyle,
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

export default function SessionsPage() {
  const [teamId, setTeamId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ActiveSession[] | null>(null);
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const [includeExpired, setIncludeExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/v1/users/me", { method: "GET" })
      .then((r: { user?: { currentWorkspaceId?: string | null } }) => {
        if (!cancelled) setTeamId(r?.user?.currentWorkspaceId ?? null);
      })
      .catch(() => {
        if (!cancelled) setTeamId(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
            next request.
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
    </main>
  );
}
