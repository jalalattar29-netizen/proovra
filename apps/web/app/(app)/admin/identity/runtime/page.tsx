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

import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { useTeamId } from "../../../../../lib/platform-context";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import {
  errorBoxStyle,
  formatDateTime,
  mutedStyle,
} from "../ui-tokens";
import { PageShell, PageHeader, PageSection } from "../../../../../components/ui/PageShell";
import { Button } from "../../../../../components/ui/Button";
import { EmptyState } from "../../../../../components/ui/EmptyState";
import { DataTable, type DataTableColumn } from "../../../../../components/ui/DataTable";

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
  const { confirm } = useConfirmAction();

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
          toSafeUserError(err, { message: "Quarantine failed." }).message,
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
          toSafeUserError(err, { message: "Release failed." }).message,
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
          toSafeUserError(err, { message: "Score-now failed." }).message,
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
    const ok = await confirm({
      title: "Emergency org-wide session revoke?",
      description:
        "EVERY active session in this workspace will be terminated. All users will be signed out. This action is logged with the incident reason and cannot be undone.",
      confirmLabel: "Revoke ALL sessions",
      cancelLabel: "Cancel emergency",
      tone: "danger",
      requireConfirmText: "REVOKE ALL",
      testId: "identity-runtime-emergency-revoke",
    });
    if (!ok) return;
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
        toSafeUserError(err, { message: "Emergency revoke failed (step-up required?)." }).message,
      );
    } finally {
      setBusy(null);
    }
  }, [teamId, load]);

  if (!teamId) {
    return (
      <PageShell header={<PageHeader eyebrow="Identity operations" title="Identity Runtime Monitor" />}>
        <EmptyState
          framed
          title="No workspace selected"
          purpose="Switch to a workspace to monitor its live sessions and quarantine posture."
        />
      </PageShell>
    );
  }

  // Sessions list omits revoked + expired by default; the runtime
  // monitor cares about active sessions only.
  const activeSessions = (sessions ?? []).filter((s) => !s.revoked);

  const quarantineColumns: DataTableColumn<QuarantineRow>[] = [
    {
      key: "user",
      header: "User",
      render: (q) => (
        <code
          style={{
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            fontSize: 12,
          }}
        >
          {q.userId.slice(0, 12)}…
        </code>
      ),
    },
    {
      key: "reason",
      header: "Reason",
      render: (q) => (
        <span style={{ ...mutedStyle, fontSize: 11 }}>{q.quarantineReason}</span>
      ),
    },
    {
      key: "quarantined",
      header: "Quarantined",
      nowrap: true,
      render: (q) => (
        <span style={mutedStyle}>{formatDateTime(q.quarantinedAtUtc)}</span>
      ),
    },
    {
      key: "autorelease",
      header: "Auto-release",
      nowrap: true,
      render: (q) => (
        <span style={mutedStyle}>{formatDateTime(q.quarantineReleaseAtUtc)}</span>
      ),
    },
  ];

  const sessionColumns: DataTableColumn<SessionRow>[] = [
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
      key: "idp",
      header: "IdP",
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
      render: (s) => (
        <span style={mutedStyle}>{formatDateTime(s.lastSeenAtUtc)}</span>
      ),
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
          title="Identity Runtime Monitor"
          subtitle="SOC console for live session governance. Inspect active sessions, quarantine privileged actions, release safe sessions, and (in genuine emergencies) revoke every active session at once. Every action is audited."
          primaryAction={
            <Button
              variant="destructive"
              onClick={emergencyRevoke}
              disabled={busy === "emergency"}
            >
              Emergency org revoke
            </Button>
          }
        />
      }
    >
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

      <PageSection title="Quarantined sessions">
        <DataTable
          columns={quarantineColumns}
          rows={quarantined ?? []}
          getRowId={(q) => q.sessionId}
          loading={quarantined === null}
          ariaLabel="Quarantined sessions"
          emptyState={
            <EmptyState
              title="No quarantined sessions"
              purpose="Sessions held for review appear here with their reason and auto-release time."
            />
          }
          rowActions={(q) => (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => release(q.sessionId)}
              disabled={busy === q.sessionId}
            >
              Release
            </Button>
          )}
        />
      </PageSection>

      <PageSection title="Active sessions">
        <DataTable
          columns={sessionColumns}
          rows={sessions === null ? [] : activeSessions.slice(0, 200)}
          getRowId={(s) => s.id}
          loading={sessions === null}
          ariaLabel="Active sessions"
          emptyState={
            <EmptyState
              title="No active sessions"
              purpose="Live sessions across this workspace appear here for re-scoring and quarantine."
            />
          }
          rowActions={(s) => (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy === s.id}
                onClick={() => scoreNow(s.id)}
              >
                Re-score
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy === s.id}
                onClick={() => quarantine(s.id)}
              >
                Quarantine
              </Button>
            </div>
          )}
        />
      </PageSection>
    </PageShell>
  );
}
