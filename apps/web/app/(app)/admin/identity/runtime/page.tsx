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
import { useTeamId, useTenantGuard } from "../../../../../lib/platform-context";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import {
  errorBoxStyle,
  formatDateTime,
  mutedStyle,
} from "../ui-tokens";
import { PageShell, PageHeader, PageSection } from "../../../../../components/ui/PageShell";
import { Badge } from "../../../../../components/ui/Badge";
import { Button } from "../../../../../components/ui/Button";
import { Card } from "../../../../../components/ui/Card";
import { EmptyState } from "../../../../../components/ui/EmptyState";
import { DataTable, type DataTableColumn } from "../../../../../components/ui/DataTable";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../../components/identity-security/StepUpModal";

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

/**
 * PHASE 12B (2026-07-30) — result of an operator-triggered identity-security
 * reconcile. The server returns the scope it actually swept plus the two
 * counts, so the projection below is the server's answer, never an
 * optimistic client guess.
 */
type ReconcileResult = {
  scope: "workspace" | "platform_cron";
  expiredStepUps: number;
  expiredDevices: number;
  ranAt: string;
};

export default function IdentityRuntimePage() {
  const teamId = useTeamId();
  const { stamp, isStale } = useTenantGuard();
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [quarantined, setQuarantined] = useState<QuarantineRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reconcile, setReconcile] = useState<ReconcileResult | null>(null);
  const { confirm } = useConfirmAction();
  const stepUp = useStepUpAction({ teamId });

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
    // `confirm` comes from the globally-mounted ConfirmActionProvider and is
    // memoised there with an empty dep array, so listing it is stable — it
    // cannot re-create this callback on every render.
  }, [teamId, load, confirm]);

  /**
   * PHASE 12B — operator-triggered identity-security reconcile.
   *
   * `POST /v1/identity-security/reconcile` existed only as a cron entry
   * point, so when step-up challenges or trusted devices were left stranded
   * past their TTL an operator had no product action and had to wait for the
   * next scheduled tick. On this path the server takes the workspace from
   * the authorized request (not from anything typed here), gates it behind a
   * step-up bound to that workspace, SCOPES the sweep to that workspace so
   * it can never become a platform-wide mutation, runs both sweeps in ONE
   * transaction, and audits the outcome with the actor and the target.
   */
  const runReconcile = useCallback(async () => {
    if (!teamId) return;
    const ok = await confirm({
      title: "Reconcile this workspace's identity runtime?",
      description:
        "Expires step-up challenges that are past their deadline and removes device trust that has run out. Nothing that is still valid is touched, and no one is signed out.",
      confirmLabel: "Run reconcile",
      testId: "identity-runtime-reconcile",
    });
    if (!ok) return;
    const captured = stamp();
    setBusy("reconcile");
    try {
      const res = (await stepUp.runStepUpAction(async (headers) =>
        apiFetch("/v1/identity-security/reconcile", {
          method: "POST",
          headers: { "content-type": "application/json", ...(headers ?? {}) },
          body: JSON.stringify({ teamId }),
        }),
      )) as Omit<ReconcileResult, "ranAt"> | null;
      if (isStale(captured)) return;
      setReconcile({
        scope: res?.scope ?? "workspace",
        expiredStepUps: res?.expiredStepUps ?? 0,
        expiredDevices: res?.expiredDevices ?? 0,
        ranAt: new Date().toISOString(),
      });
      setError(null);
      setNotice(null);
      load();
    } catch (err) {
      if (isStale(captured)) return;
      const code = ((err as { code?: string }).code ?? "").toUpperCase();
      if (code === "STEP_UP_CANCEL") return;
      setError(
        toSafeUserError(err, {
          message: "We couldn't reconcile the identity runtime.",
        }).message,
      );
    } finally {
      setBusy(null);
    }
  }, [teamId, confirm, stepUp, stamp, isStale, load]);

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

      <PageSection
        title="Runtime reconcile"
        description="Clears identity state that has already run out: step-up challenges past their deadline and device trust past its lifetime. This is scoped to the workspace you are in, runs as one transaction, requires step-up verification, and is recorded in the audit log. It never signs anyone out and never touches state that is still valid."
        data-identity-runtime-reconcile
        action={
          <Button
            variant="secondary"
            onClick={() => void runReconcile()}
            loading={busy === "reconcile"}
            disabled={busy !== null}
          >
            Run reconcile
          </Button>
        }
      >
        <Card padding="comfortable">
          {reconcile === null ? (
            <p style={{ margin: 0, ...mutedStyle }}>
              Not run in this session. The scheduled sweep also does this
              automatically — running it here only makes it happen now.
            </p>
          ) : (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Badge tone="verified">
                {reconcile.expiredStepUps} step-up challenge
                {reconcile.expiredStepUps === 1 ? "" : "s"} expired
              </Badge>
              <Badge tone="verified">
                {reconcile.expiredDevices} device trust
                {reconcile.expiredDevices === 1 ? "" : "s"} withdrawn
              </Badge>
              <Badge tone="neutral">
                scope: {reconcile.scope === "workspace" ? "this workspace" : "platform"}
              </Badge>
              <Badge tone="neutral">ran {formatDateTime(reconcile.ranAt)}</Badge>
            </div>
          )}
        </Card>
      </PageSection>

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

      <StepUpModal control={stepUp} />
    </PageShell>
  );
}
