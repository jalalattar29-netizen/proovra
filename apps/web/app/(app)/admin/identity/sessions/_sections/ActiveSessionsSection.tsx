"use client";

/**
 * PHASE 12B — Active sessions console section.
 *
 * Extracted from the former monolithic sessions page and completed:
 *
 *   GET  /v1/admin/identity/sessions?teamId&…            (inventory)
 *   POST /v1/admin/identity/sessions/:id/revoke          (revoke ONE)
 *   POST /v1/admin/identity/sessions/user/:id/revoke-all (revoke OTHERS)
 *   POST /v1/admin/identity/sessions/:id/quarantine      (hold for review)
 *   POST /v1/admin/identity/sessions/:id/release         (release a hold)
 *   GET  /v1/identity/sessions/:id/timeline?teamId       (bounded reconstruction)
 *
 * WHAT WAS BROKEN
 *   * revoke-all is step-up gated on the server, but the page had no
 *     step-up modal — so the operator got an opaque failure and the action
 *     was effectively unreachable. It now routes through `useStepUpAction`
 *     and the injected challenge header.
 *   * quarantine / release existed only on the runtime monitor, so the
 *     sessions console could see a quarantined session and do nothing
 *     about it.
 *   * A denial rendered as an error string above an empty table, which
 *     reads as "this workspace has no sessions". Denials now have their own
 *     state and their own copy.
 *
 * TENANT SAFETY: the workspace comes from `lib/platform-context`; every
 * response is dropped if it lands after a workspace switch. No raw IP, no
 * user agent string, no session token and no session hash is rendered — the
 * server projection carries previews only.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../../lib/api";
import { notifyApiError } from "../../../../../../lib/feedback/notify";
import { useTeamId, useTenantGuard } from "../../../../../../lib/platform-context";
import { useToast } from "../../../../../../components/ui";
import { Badge } from "../../../../../../components/ui/Badge";
import { Button } from "../../../../../../components/ui/Button";
import { Card } from "../../../../../../components/ui/Card";
import { useConfirmAction } from "../../../../../../components/ui/ConfirmActionModal";
import {
  DataTable,
  type DataTableColumn,
} from "../../../../../../components/ui/DataTable";
import { EmptyState } from "../../../../../../components/ui/EmptyState";
import { PageSection } from "../../../../../../components/ui/PageShell";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../../../components/identity-security/StepUpModal";
import {
  NoWorkspaceSelected,
  SectionDenied,
  SectionError,
  SectionLoading,
  classifyError,
  sectionInputStyle,
  sectionLabelStyle,
  sectionMuted,
  type SectionState,
} from "../../../security/_sections/section-state";
import { formatDateTime } from "../../ui-tokens";
import { SessionTimelineDrawer } from "./SessionTimelineDrawer";

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

type QuarantineRow = {
  sessionId: string;
  teamId: string | null;
  userId: string;
  quarantinedAtUtc: string;
  quarantinedByUserId: string | null;
  quarantineReason: string;
  quarantineReleaseAtUtc: string | null;
};

type Inventory = {
  sessions: ActiveSession[];
  quarantined: QuarantineRow[];
};

const QUARANTINE_REASONS = [
  { value: "MANUAL_OPERATOR", label: "Operator decision" },
  { value: "SUSPICIOUS_SESSION_AUTO", label: "Suspicious session" },
  { value: "REPEATED_REPLAY", label: "Repeated replay" },
  { value: "GEO_ANOMALY", label: "Location anomaly" },
  { value: "PRIVILEGED_SESSION_AGED", label: "Privileged session too old" },
  { value: "SUSPICIOUS_REVIEWER_ACTIVITY", label: "Suspicious reviewer activity" },
  { value: "SUSPICIOUS_ADMIN_ACTIVITY", label: "Suspicious admin activity" },
] as const;

export function ActiveSessionsSection() {
  const teamId = useTeamId();
  const { stamp, isStale } = useTenantGuard();
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();
  const stepUp = useStepUpAction({ teamId });

  const [state, setState] = useState<SectionState<Inventory>>({ kind: "loading" });
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const [includeExpired, setIncludeExpired] = useState(false);
  const [quarantineReason, setQuarantineReason] =
    useState<string>("MANUAL_OPERATOR");
  const [busy, setBusy] = useState<string | null>(null);
  const [timelineFor, setTimelineFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!teamId) return;
    setState({ kind: "loading" });
    const captured = stamp();
    try {
      const qs = new URLSearchParams({
        teamId,
        includeRevoked: String(includeRevoked),
        includeExpired: String(includeExpired),
        limit: "200",
      });
      const [sessions, quarantined] = await Promise.all([
        apiFetch(`/v1/admin/identity/sessions?${qs.toString()}`, { method: "GET" }),
        apiFetch(
          `/v1/admin/identity/quarantined-sessions?teamId=${encodeURIComponent(
            teamId,
          )}&limit=200`,
          { method: "GET" },
        ),
      ]);
      if (isStale(captured)) return;
      setState({
        kind: "ready",
        data: {
          sessions:
            ((sessions as { sessions?: ActiveSession[] })?.sessions ??
              []) as ActiveSession[],
          quarantined:
            ((quarantined as { items?: QuarantineRow[] })?.items ??
              []) as QuarantineRow[],
        },
      });
    } catch (err) {
      if (isStale(captured)) return;
      setState(
        classifyError<Inventory>(err, "We couldn't load the session inventory."),
      );
    }
  }, [teamId, includeRevoked, includeExpired, stamp, isStale]);

  useEffect(() => {
    setTimelineFor(null);
    void load();
  }, [load]);

  /**
   * One mutation runner for every session action: confirm → step-up-aware
   * request → reload the server projection. Never patches local rows.
   */
  const runMutation = useCallback(
    async (opts: {
      key: string;
      path: string;
      body: Record<string, unknown>;
      confirmTitle: string;
      confirmDescription: string;
      confirmLabel: string;
      requireConfirmText?: string;
      tone?: "danger" | "warning";
      successMessage: string;
      failureMessage: string;
    }) => {
      const ok = await confirm({
        title: opts.confirmTitle,
        description: opts.confirmDescription,
        confirmLabel: opts.confirmLabel,
        tone: opts.tone ?? "danger",
        ...(opts.requireConfirmText
          ? { requireConfirmText: opts.requireConfirmText }
          : {}),
        testId: opts.key,
      });
      if (!ok) return;
      const captured = stamp();
      setBusy(opts.key);
      try {
        await stepUp.runStepUpAction(async (headers) =>
          apiFetch(opts.path, {
            method: "POST",
            headers: { "content-type": "application/json", ...(headers ?? {}) },
            body: JSON.stringify(opts.body),
          }),
        );
        if (isStale(captured)) return;
        addToast(opts.successMessage, "success");
        await load();
      } catch (err) {
        if (isStale(captured)) return;
        const code = ((err as { code?: string }).code ?? "").toUpperCase();
        if (code === "STEP_UP_CANCEL") return;
        notifyApiError(addToast, err, { message: opts.failureMessage });
      } finally {
        setBusy(null);
      }
    },
    [confirm, stepUp, stamp, isStale, addToast, load],
  );

  const description =
    "Every live session in the workspace you are currently in. Device and network previews are shown; raw addresses, user-agent strings and session tokens are never stored or rendered. Revocation is enforced by the session-revocation registry — the next request from that session is refused.";

  if (!teamId) {
    return (
      <PageSection title="Active sessions" description={description}>
        <NoWorkspaceSelected purpose="Switch to a workspace to view and govern its live sessions." />
      </PageSection>
    );
  }
  if (state.kind === "loading") {
    return (
      <PageSection title="Active sessions" description={description}>
        <SectionLoading label="Reading the live session inventory…" />
      </PageSection>
    );
  }
  if (state.kind === "denied") {
    return (
      <PageSection title="Active sessions" description={description}>
        <SectionDenied
          message={state.message}
          hint="Session governance requires owner or admin access on this workspace. This is a refusal — it does not mean the workspace has no sessions."
        />
      </PageSection>
    );
  }
  if (state.kind === "error") {
    return (
      <PageSection title="Active sessions" description={description}>
        <SectionError message={state.message} onRetry={() => void load()} />
      </PageSection>
    );
  }

  const { sessions, quarantined } = state.data;
  const quarantinedSessionIds = new Set(quarantined.map((q) => q.sessionId));

  const sessionColumns: DataTableColumn<ActiveSession>[] = [
    {
      key: "user",
      header: "Member",
      render: (s) => (
        <code style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
          {s.userId.slice(0, 12)}…
        </code>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (s) =>
        s.revoked ? (
          <Badge tone="neutral">revoked</Badge>
        ) : new Date(s.expiresAtUtc) < new Date() ? (
          <Badge tone="neutral">expired</Badge>
        ) : quarantinedSessionIds.has(s.id) ? (
          <Badge tone="pending">quarantined</Badge>
        ) : (
          <Badge tone="verified">active</Badge>
        ),
    },
    {
      key: "sso",
      header: "Identity provider",
      render: (s) => (
        <span style={sectionMuted}>
          {s.ssoConnectionId ? `${s.ssoConnectionId.slice(0, 8)}…` : "password / local"}
        </span>
      ),
    },
    {
      key: "lastseen",
      header: "Last seen",
      nowrap: true,
      render: (s) => <span style={sectionMuted}>{formatDateTime(s.lastSeenAtUtc)}</span>,
    },
    {
      key: "expires",
      header: "Expires",
      nowrap: true,
      render: (s) => <span style={sectionMuted}>{formatDateTime(s.expiresAtUtc)}</span>,
    },
    {
      key: "device",
      header: "Device",
      render: (s) => (
        <div style={{ fontSize: 11 }}>
          <div>{s.uaPreview ?? "unrecognised client"}</div>
          <div style={sectionMuted}>{s.ipPreview ?? "no network preview"}</div>
        </div>
      ),
    },
  ];

  const quarantineColumns: DataTableColumn<QuarantineRow>[] = [
    {
      key: "user",
      header: "Member",
      render: (q) => (
        <code style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
          {q.userId.slice(0, 12)}…
        </code>
      ),
    },
    {
      key: "reason",
      header: "Why",
      render: (q) => <span style={sectionMuted}>{q.quarantineReason}</span>,
    },
    {
      key: "at",
      header: "Held since",
      nowrap: true,
      render: (q) => (
        <span style={sectionMuted}>{formatDateTime(q.quarantinedAtUtc)}</span>
      ),
    },
    {
      key: "release",
      header: "Auto-release",
      nowrap: true,
      render: (q) => (
        <span style={sectionMuted}>
          {q.quarantineReleaseAtUtc ? formatDateTime(q.quarantineReleaseAtUtc) : "manual"}
        </span>
      ),
    },
  ];

  return (
    <PageSection
      title="Active sessions"
      description={description}
      data-active-sessions-section
      action={
        <Button variant="secondary" onClick={() => void load()}>
          Refresh
        </Button>
      }
    >
      <Card padding="compact" style={{ marginBottom: 12 }}>
        <div
          style={{ display: "flex", gap: 16, alignItems: "flex-end", flexWrap: "wrap" }}
        >
          <label style={{ fontSize: 12.5 }}>
            <input
              type="checkbox"
              checked={includeRevoked}
              onChange={(e) => setIncludeRevoked(e.target.checked)}
            />{" "}
            Show revoked
          </label>
          <label style={{ fontSize: 12.5 }}>
            <input
              type="checkbox"
              checked={includeExpired}
              onChange={(e) => setIncludeExpired(e.target.checked)}
            />{" "}
            Show expired
          </label>
          <label style={{ minWidth: 220 }}>
            <span style={sectionLabelStyle}>Reason used when you quarantine</span>
            <select
              value={quarantineReason}
              onChange={(e) => setQuarantineReason(e.target.value)}
              style={sectionInputStyle}
            >
              {QUARANTINE_REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </Card>

      <DataTable
        columns={sessionColumns}
        rows={sessions}
        getRowId={(s) => s.id}
        ariaLabel="Active sessions inventory"
        emptyState={
          <EmptyState
            title="No sessions match these filters"
            purpose="Nobody currently holds a live session in this workspace under the filters above. Turn on “Show revoked” or “Show expired” to widen the view."
          />
        }
        rowActions={(s) => (
          <div
            style={{
              display: "flex",
              gap: 4,
              flexWrap: "wrap",
              justifyContent: "flex-end",
            }}
          >
            <Button variant="secondary" size="sm" onClick={() => setTimelineFor(s.id)}>
              Timeline
            </Button>
            {!s.revoked && !quarantinedSessionIds.has(s.id) ? (
              <Button
                variant="secondary"
                size="sm"
                loading={busy === `session-quarantine-${s.id}`}
                disabled={busy !== null}
                onClick={() =>
                  void runMutation({
                    key: `session-quarantine-${s.id}`,
                    path: `/v1/admin/identity/sessions/${encodeURIComponent(s.id)}/quarantine`,
                    body: { teamId, reason: quarantineReason, releaseHours: 4 },
                    confirmTitle: "Hold this session for review?",
                    confirmDescription:
                      "The member stays signed in but privileged actions are blocked until the hold is released. It auto-releases in 4 hours.",
                    confirmLabel: "Quarantine session",
                    tone: "warning",
                    successMessage: "Session quarantined.",
                    failureMessage: "We couldn't quarantine that session.",
                  })
                }
              >
                Quarantine
              </Button>
            ) : null}
            {!s.revoked ? (
              <Button
                variant="destructive"
                size="sm"
                loading={busy === `session-revoke-${s.id}`}
                disabled={busy !== null}
                onClick={() =>
                  void runMutation({
                    key: `session-revoke-${s.id}`,
                    path: `/v1/admin/identity/sessions/${encodeURIComponent(s.id)}/revoke`,
                    body: { teamId, reason: "OPERATOR_REVOKED" },
                    confirmTitle: "Revoke this session?",
                    confirmDescription:
                      "The member is signed out of this device on their next request. Their account is untouched — they can sign in again unless their access has also been suspended.",
                    confirmLabel: "Revoke session",
                    successMessage: "Session revoked.",
                    failureMessage: "We couldn't revoke that session.",
                  })
                }
              >
                Revoke
              </Button>
            ) : null}
            <Button
              variant="destructive"
              size="sm"
              loading={busy === `session-revoke-all-${s.userId}`}
              disabled={busy !== null}
              onClick={() =>
                void runMutation({
                  key: `session-revoke-all-${s.userId}`,
                  path: `/v1/admin/identity/sessions/user/${encodeURIComponent(
                    s.userId,
                  )}/revoke-all`,
                  body: { teamId, reason: "OPERATOR_REVOKED" },
                  confirmTitle: "Revoke every session for this member?",
                  confirmDescription:
                    "This member is signed out of every device, everywhere. Their account and data are untouched. This action requires step-up verification and is recorded in the audit log.",
                  confirmLabel: "Revoke all sessions",
                  requireConfirmText: "REVOKE ALL",
                  successMessage: "All sessions revoked for that member.",
                  failureMessage: "We couldn't revoke that member's sessions.",
                })
              }
            >
              Revoke all for member
            </Button>
          </div>
        )}
      />

      <h3 style={{ fontSize: 13, fontWeight: 700, margin: "20px 0 8px" }}>
        Sessions held for review
      </h3>
      <DataTable
        columns={quarantineColumns}
        rows={quarantined}
        getRowId={(q) => q.sessionId}
        ariaLabel="Quarantined sessions"
        emptyState={
          <EmptyState
            title="Nothing is on hold"
            purpose="No session in this workspace is currently quarantined. Held sessions appear here with the reason and the auto-release time."
          />
        }
        rowActions={(q) => (
          <Button
            variant="secondary"
            size="sm"
            loading={busy === `session-release-${q.sessionId}`}
            disabled={busy !== null}
            onClick={() =>
              void runMutation({
                key: `session-release-${q.sessionId}`,
                path: `/v1/admin/identity/sessions/${encodeURIComponent(
                  q.sessionId,
                )}/release`,
                body: { teamId },
                confirmTitle: "Release this hold?",
                confirmDescription:
                  "The session returns to normal and the member can perform privileged actions again.",
                confirmLabel: "Release hold",
                tone: "warning",
                successMessage: "Hold released.",
                failureMessage: "We couldn't release that hold.",
              })
            }
          >
            Release
          </Button>
        )}
      />

      {timelineFor ? (
        <SessionTimelineDrawer
          teamId={teamId}
          sessionId={timelineFor}
          onClose={() => setTimelineFor(null)}
        />
      ) : null}

      <StepUpModal control={stepUp} />
    </PageSection>
  );
}

export default ActiveSessionsSection;
