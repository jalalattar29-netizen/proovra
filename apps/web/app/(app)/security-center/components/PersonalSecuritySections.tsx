"use client";

/**
 * D-5 closure — Security Center personal sections.
 *
 * Three real-backend cards rendered at the top of the Security Center:
 *
 *   1. Change password (POST /v1/identity-security/password)
 *      - Requires current password.
 *      - Client-side strength check mirrors the server-side floor.
 *      - Optional "Sign out other sessions" checkbox fans out to the
 *        server's `revokeOtherSessions: true` branch.
 *      - Surfaces every server error code precisely; no placeholder.
 *
 *   2. Active sessions (GET /v1/identity-security/my-sessions +
 *      POST /v1/identity-security/my-sessions/revoke-others).
 *      - Shows IP/UA preview, country, last seen.
 *      - Current session marked clearly.
 *      - "Sign out other sessions" routes through ConfirmActionModal.
 *
 *   3. Security events (GET /v1/identity-security/security-events).
 *      - Bounded timeline (50 most recent identity_security / auth
 *        events for the current user).
 *      - Severity dot + outcome badge for each row.
 *      - No raw IPs / UAs beyond the already-bounded preview from the
 *        audit log writer.
 *
 * This file is self-contained so the existing SecurityCenter page
 * structure is unchanged; we only mount the component once.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { useConfirmAction } from "../../../../components/ui/ConfirmActionModal";
import { formatUtcAuditDateTime } from "../../../../lib/date";

// -----------------------------------------------------------------------------
// Shared styles (kept inline so this card doesn't pull in unrelated tokens).
// -----------------------------------------------------------------------------

const cardStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 14,
  padding: 18,
  marginBottom: 14,
};

const sectionTitleStyle: React.CSSProperties = {
  margin: 0,
  marginBottom: 8,
  fontSize: 14,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: "uppercase" as const,
  color: "#dce1de",
};

const mutedStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: "rgba(220,225,222,0.7)",
};

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.15)",
  background: "rgba(0,0,0,0.30)",
  color: "#dce1de",
  fontSize: 13,
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  color: "rgba(220,225,222,0.75)",
  marginTop: 8,
  marginBottom: 4,
};

const primaryButton: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 999,
  border: "1px solid rgba(125, 200, 175, 0.45)",
  background: "rgba(125, 200, 175, 0.20)",
  color: "#dce1de",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 700,
};

const secondaryButton: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 999,
  border: "1px solid rgba(255,255,255,0.15)",
  background: "rgba(255,255,255,0.06)",
  color: "#dce1de",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 600,
};

const errorBox: React.CSSProperties = {
  marginTop: 8,
  padding: "8px 10px",
  borderRadius: 8,
  background: "rgba(179,38,30,0.18)",
  border: "1px solid rgba(179,38,30,0.45)",
  color: "#f7d4d1",
  fontSize: 12,
};

const okBox: React.CSSProperties = {
  marginTop: 8,
  padding: "8px 10px",
  borderRadius: 8,
  background: "rgba(125, 200, 175, 0.15)",
  border: "1px solid rgba(125, 200, 175, 0.45)",
  color: "#d2efe5",
  fontSize: 12,
};

// -----------------------------------------------------------------------------
// Password change
// -----------------------------------------------------------------------------

function meetsPolicy(pw: string): boolean {
  if (pw.length < 12) return false;
  if (!/[a-z]/.test(pw)) return false;
  if (!/[A-Z]/.test(pw)) return false;
  if (!/\d/.test(pw)) return false;
  return true;
}

const ERROR_MESSAGES: Record<string, string> = {
  rate_limited:
    "Too many attempts. Please wait a minute before trying again.",
  current_password_invalid:
    "The current password is incorrect.",
  sso_user_password_unsupported:
    "Your account signs in through an identity provider. Change your password there.",
  no_password_set:
    "No password is set on this account. Use the password reset flow to create one.",
  same_as_current:
    "Your new password must be different from your current password.",
  weak_new_password:
    "Use at least 12 characters with upper- and lower-case letters and a number.",
};

function PasswordChangeCard() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [revokeOthers, setRevokeOthers] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const canSubmit =
    currentPassword.length > 0 &&
    meetsPolicy(newPassword) &&
    newPassword === confirmPassword &&
    !busy;

  const submit = useCallback(async () => {
    setError(null);
    setOk(null);
    if (newPassword !== confirmPassword) {
      setError("The new password and confirmation must match.");
      return;
    }
    if (!meetsPolicy(newPassword)) {
      setError(ERROR_MESSAGES.weak_new_password!);
      return;
    }
    setBusy(true);
    try {
      const res = (await apiFetch("/v1/identity-security/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentPassword,
          newPassword,
          revokeOtherSessions: revokeOthers,
        }),
      })) as { ok: true; revokedOtherSessions: number };
      setOk(
        revokeOthers
          ? `Password updated. ${res.revokedOtherSessions} other session(s) signed out.`
          : "Password updated.",
      );
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      const e = err as {
        status?: number;
        body?: { error?: { code?: string } };
      };
      const code = e.body?.error?.code ?? "error";
      setError(
        ERROR_MESSAGES[code] ??
          "We could not change your password. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }, [currentPassword, newPassword, confirmPassword, revokeOthers]);

  return (
    <section style={cardStyle} data-cc-password-change-card>
      <h2 style={sectionTitleStyle}>Change password</h2>
      <p style={mutedStyle}>
        Use at least 12 characters with upper- and lower-case letters and a
        number. Your current password is required.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        autoComplete="off"
      >
        <label style={labelStyle}>
          Current password
          <input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            disabled={busy}
            style={inputStyle}
            data-cc-password-current
          />
        </label>
        <label style={labelStyle}>
          New password
          <input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={busy}
            style={inputStyle}
            data-cc-password-new
          />
        </label>
        <label style={labelStyle}>
          Confirm new password
          <input
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={busy}
            style={inputStyle}
            data-cc-password-confirm
          />
        </label>
        <label
          style={{
            ...labelStyle,
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 12,
            marginBottom: 0,
          }}
        >
          <input
            type="checkbox"
            checked={revokeOthers}
            onChange={(e) => setRevokeOthers(e.target.checked)}
            disabled={busy}
          />
          Sign out my other sessions
        </label>
        <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
          <button
            type="submit"
            disabled={!canSubmit}
            style={{
              ...primaryButton,
              opacity: canSubmit ? 1 : 0.55,
              cursor: canSubmit ? "pointer" : "not-allowed",
            }}
            data-cc-password-submit
          >
            {busy ? "Updating…" : "Update password"}
          </button>
        </div>
        {error ? <div style={errorBox}>{error}</div> : null}
        {ok ? <div style={okBox}>{ok}</div> : null}
      </form>
    </section>
  );
}

// -----------------------------------------------------------------------------
// Active sessions
// -----------------------------------------------------------------------------

interface MySession {
  id: string;
  sessionIdHash: string;
  isCurrent: boolean;
  issuedAtUtc: string;
  expiresAtUtc: string;
  lastSeenAtUtc: string;
  ipPreview: string | null;
  uaPreview: string | null;
  countryCode: string | null;
  quarantined: boolean;
}

function fmt(ts: string): string {
  return formatUtcAuditDateTime(ts);
}

function ActiveSessionsCard() {
  const [sessions, setSessions] = useState<MySession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const { confirm } = useConfirmAction();

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = (await apiFetch("/v1/identity-security/my-sessions", {
        method: "GET",
      })) as { sessions: MySession[] };
      setSessions(res.sessions ?? []);
    } catch (err) {
      setError(
        (err as { message?: string })?.message ?? "Could not load sessions.",
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revokeOthers = useCallback(async () => {
    const otherCount = (sessions ?? []).filter((s) => !s.isCurrent).length;
    if (otherCount === 0) {
      setNotice("You have no other active sessions.");
      return;
    }
    const ok = await confirm({
      title: "Sign out other sessions?",
      description: `Every active session except this one will be terminated (${otherCount} session(s)). You will not be signed out from this device.`,
      confirmLabel: "Sign out others",
      tone: "warning",
      testId: "security-center-self-revoke-others",
    });
    if (!ok) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = (await apiFetch(
        "/v1/identity-security/my-sessions/revoke-others",
        { method: "POST" },
      )) as { revoked: number };
      setNotice(`${res.revoked} other session(s) signed out.`);
      await load();
    } catch (err) {
      setError(
        (err as { message?: string })?.message ?? "Could not revoke sessions.",
      );
    } finally {
      setBusy(false);
    }
  }, [confirm, load, sessions]);

  return (
    <section style={cardStyle} data-cc-active-sessions-card>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <h2 style={{ ...sectionTitleStyle, marginBottom: 0 }}>
          Your active sessions
        </h2>
        <button
          type="button"
          onClick={() => void revokeOthers()}
          disabled={busy || sessions === null}
          style={secondaryButton}
          data-cc-revoke-others
        >
          {busy ? "Working…" : "Sign out other sessions"}
        </button>
      </div>
      <p style={mutedStyle}>
        Sessions you are signed into right now. Each row shows where the
        session was issued from. Your current session is highlighted.
      </p>

      {sessions === null ? (
        <p style={mutedStyle}>Loading…</p>
      ) : sessions.length === 0 ? (
        <p style={mutedStyle}>No active sessions found.</p>
      ) : (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            marginTop: 10,
          }}
        >
          {sessions.map((s) => (
            <li
              key={s.id}
              data-cc-session-row={s.id}
              data-cc-session-current={s.isCurrent ? "true" : "false"}
              style={{
                padding: "10px 12px",
                marginBottom: 6,
                borderRadius: 10,
                border: s.isCurrent
                  ? "1px solid rgba(125,200,175,0.55)"
                  : "1px solid rgba(255,255,255,0.10)",
                background: s.isCurrent
                  ? "rgba(125,200,175,0.10)"
                  : "rgba(255,255,255,0.03)",
                fontSize: 12,
              }}
            >
              <div style={{ fontWeight: 700, color: "#dce1de" }}>
                {s.isCurrent ? "This device" : s.uaPreview ?? "Unknown device"}
                {s.quarantined ? (
                  <span
                    style={{
                      marginLeft: 8,
                      padding: "1px 8px",
                      borderRadius: 999,
                      fontSize: 10,
                      background: "rgba(241,162,58,0.20)",
                      border: "1px solid rgba(241,162,58,0.45)",
                      color: "#f0d2a0",
                    }}
                  >
                    QUARANTINED
                  </span>
                ) : null}
              </div>
              <div style={mutedStyle}>
                {s.ipPreview ?? "IP unknown"} · {s.countryCode ?? "??"} · last
                seen {fmt(s.lastSeenAtUtc)}
              </div>
              <div style={{ ...mutedStyle, marginTop: 2 }}>
                Issued {fmt(s.issuedAtUtc)} · expires {fmt(s.expiresAtUtc)}
              </div>
            </li>
          ))}
        </ul>
      )}

      {error ? <div style={errorBox}>{error}</div> : null}
      {notice ? <div style={okBox}>{notice}</div> : null}
    </section>
  );
}

// -----------------------------------------------------------------------------
// Security events feed
// -----------------------------------------------------------------------------

interface SecurityEvent {
  id: string;
  action: string;
  severity: string | null;
  outcome: string | null;
  occurredAtUtc: string;
  resourceType: string | null;
  resourceId: string | null;
  ipPreview: string | null;
  uaPreview: string | null;
  metadata: unknown;
}

function severityDot(sev: string | null): React.CSSProperties {
  const color =
    sev === "critical"
      ? "#b3261e"
      : sev === "warning"
        ? "#f1a23a"
        : "rgba(220,225,222,0.55)";
  return {
    display: "inline-block",
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: color,
    marginRight: 8,
  };
}

function SecurityEventsCard() {
  const [events, setEvents] = useState<SecurityEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = (await apiFetch(
          "/v1/identity-security/security-events?limit=50",
          { method: "GET" },
        )) as { events: SecurityEvent[] };
        setEvents(res.events ?? []);
      } catch (err) {
        setError(
          (err as { message?: string })?.message ??
            "Could not load security events.",
        );
      }
    })();
  }, []);

  const rows = useMemo(() => events ?? [], [events]);

  return (
    <section style={cardStyle} data-cc-security-events-card>
      <h2 style={sectionTitleStyle}>Recent security events</h2>
      <p style={mutedStyle}>
        Bounded timeline of identity and auth events tied to your account.
        Older events live in the platform audit log.
      </p>

      {error ? <div style={errorBox}>{error}</div> : null}

      {events === null ? (
        <p style={mutedStyle}>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={mutedStyle}>No security events in the recent window.</p>
      ) : (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            marginTop: 10,
            maxHeight: 320,
            overflowY: "auto",
          }}
        >
          {rows.map((ev) => (
            <li
              key={ev.id}
              data-cc-security-event-row={ev.id}
              style={{
                padding: "8px 10px",
                borderBottom: "1px solid rgba(255,255,255,0.06)",
                fontSize: 12,
                color: "#dce1de",
              }}
            >
              <div style={{ display: "flex", alignItems: "center" }}>
                <span aria-hidden style={severityDot(ev.severity)} />
                <strong style={{ fontWeight: 700 }}>{ev.action}</strong>
                {ev.outcome ? (
                  <span
                    style={{
                      marginLeft: 8,
                      padding: "1px 6px",
                      borderRadius: 999,
                      fontSize: 10,
                      background: "rgba(255,255,255,0.08)",
                      border: "1px solid rgba(255,255,255,0.12)",
                      color: "rgba(220,225,222,0.85)",
                      textTransform: "uppercase",
                      letterSpacing: 0.4,
                    }}
                  >
                    {ev.outcome}
                  </span>
                ) : null}
              </div>
              <div style={{ ...mutedStyle, marginTop: 2 }}>
                {fmt(ev.occurredAtUtc)}
                {ev.ipPreview ? ` · ${ev.ipPreview}` : ""}
                {ev.resourceType ? ` · ${ev.resourceType}` : ""}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// -----------------------------------------------------------------------------
// Combined export
// -----------------------------------------------------------------------------

export function PersonalSecuritySections() {
  return (
    <>
      <PasswordChangeCard />
      <ActiveSessionsCard />
      <SecurityEventsCard />
    </>
  );
}
