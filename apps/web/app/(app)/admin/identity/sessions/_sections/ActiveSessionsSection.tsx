"use client";

/**
 * PHASE 12B — Active sessions console section.
 *
 * Extracted from the former monolithic sessions page and completed:
 *
 *   GET  /v1/admin/identity/sessions?teamId&…&limit&cursor   (inventory, paged)
 *   GET  /v1/admin/identity/quarantined-sessions?teamId&limit&cursor
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
 * PAGED, NOT CAPPED
 *   The section asked for `limit=200` and rendered every row it got: 86
 *   sessions made a page nine screens tall, and a workspace with more than
 *   200 would have been cut off with nothing on screen to say so. Both
 *   tables now read 25 rows at a time over a server keyset cursor. The
 *   filters are still applied by the server — under the cursor, so a page
 *   and its continuation always describe the same set — and the count row
 *   states what the server said about a further page rather than guessing
 *   from a full one.
 *
 * TENANT SAFETY: the workspace comes from `lib/platform-context`; every
 * response is dropped if it lands after a workspace switch. No raw IP, no
 * user agent string, no session token and no session hash is rendered — the
 * server projection carries previews only.
 */

import { useCallback, useEffect, useState } from "react";

import { FilterBar } from "../../../../../../components/ui/FilterBar";
import { describeClient } from "../../../../../../lib/ui/describeClient";
import { apiFetch } from "../../../../../../lib/api";
import { notifyApiError } from "../../../../../../lib/feedback/notify";
import { useTeamId, useTenantGuard } from "../../../../../../lib/platform-context";
import { useToast } from "../../../../../../components/ui";
import { Badge } from "../../../../../../components/ui/Badge";
import { Button } from "../../../../../../components/ui/Button";
import { Card } from "../../../../../../components/ui/Card";
import { useConfirmAction } from "../../../../../../components/ui/ConfirmActionModal";
import {
  CursorPager,
  useCursorPager,
} from "../../../../../../components/ui/CursorPager";
import {
  DataTable,
  type DataTableColumn,
} from "../../../../../../components/ui/DataTable";
import { EmptyState } from "../../../../../../components/ui/EmptyState";
import { PageSection } from "../../../../../../components/ui/PageShell";
import { ResultCount } from "../../../../../../components/ui/ResultCount";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../../../components/identity-security/StepUpModal";
import {
  NoWorkspaceSelected,
  SectionDenied,
  SectionDescription,
  SectionError,
  SectionLoading,
  classifyError,
  sectionInputStyle,
  sectionLabelStyle,
  sectionMuted,
  type SectionState,
} from "../../../security/_sections/section-state";
import { SessionTimelineDrawer } from "./SessionTimelineDrawer";
import { formatDateTime } from "../../ui-tokens";

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
  /**
   * Carried by the server so a paged inventory can still say which of its
   * rows is on hold. Optional only so an older projection still renders; the
   * quarantine page is the fallback and can only vouch for its own 25 rows.
   */
  quarantined?: boolean;
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

type SessionsPage = {
  sessions: ActiveSession[];
  nextCursor: string | null;
  hasMore: boolean;
};

type QuarantinePage = {
  items: QuarantineRow[];
  nextCursor: string | null;
  hasMore: boolean;
};

/**
 * Twenty-five rows is about one screen of this table on a laptop, and the
 * whole point of paging it was that one screen is what an operator can scan.
 */
const PAGE_SIZE = 25;

const QUARANTINE_REASONS = [
  { value: "MANUAL_OPERATOR", label: "Operator decision" },
  { value: "SUSPICIOUS_SESSION_AUTO", label: "Suspicious session" },
  { value: "REPEATED_REPLAY", label: "Repeated replay" },
  { value: "GEO_ANOMALY", label: "Location anomaly" },
  { value: "PRIVILEGED_SESSION_AGED", label: "Privileged session too old" },
  { value: "SUSPICIOUS_REVIEWER_ACTIVITY", label: "Suspicious reviewer activity" },
  { value: "SUSPICIOUS_ADMIN_ACTIVITY", label: "Suspicious admin activity" },
] as const;

const DESCRIPTION =
  "Every live session in the workspace you are currently in. Device and network previews are shown; raw addresses, user-agent strings and session tokens are never stored or rendered. Revocation is enforced by the session-revocation registry — the next request from that session is refused.";

export function ActiveSessionsSection() {
  const teamId = useTeamId();
  const { stamp, isStale } = useTenantGuard();
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();
  const stepUp = useStepUpAction({ teamId });

  const [includeRevoked, setIncludeRevoked] = useState(false);
  const [includeExpired, setIncludeExpired] = useState(false);
  const [quarantineReason, setQuarantineReason] =
    useState<string>("MANUAL_OPERATOR");
  const [busy, setBusy] = useState<string | null>(null);
  const [timelineFor, setTimelineFor] = useState<string | null>(null);

  // A cursor belongs to one query. Both pagers reset in the same render the
  // workspace or a filter changes, so the request that follows is page one of
  // the new set and never the old cursor over the new filter.
  const sessionsPager = useCursorPager(
    `${teamId ?? ""}|${includeRevoked}|${includeExpired}`,
  );
  const quarantinePager = useCursorPager(teamId ?? "");

  const [sessionsState, setSessionsState] = useState<SectionState<SessionsPage>>({
    kind: "loading",
  });
  const [quarantineState, setQuarantineState] = useState<
    SectionState<QuarantinePage>
 >({ kind: "loading" });
  /** A page turn keeps the table on screen and marks it busy. */
  const [sessionsBusy, setSessionsBusy] = useState(false);
  const [quarantineBusy, setQuarantineBusy] = useState(false);

  const loadSessions = useCallback(async () => {
    if (!teamId) return;
    setSessionsState((prev) => (prev.kind === "ready" ? prev : { kind: "loading" }));
    setSessionsBusy(true);
    const captured = stamp();
    try {
      // The two filters are SERVER-side: they go into the request, under the
      // cursor, so every page is a page of the narrowed set.
      const qs = new URLSearchParams({
        teamId,
        includeRevoked: String(includeRevoked),
        includeExpired: String(includeExpired),
        limit: String(PAGE_SIZE),
      });
      if (sessionsPager.cursor) qs.set("cursor", sessionsPager.cursor);
      const res = (await apiFetch(`/v1/admin/identity/sessions?${qs.toString()}`, {
        method: "GET",
      })) as {
        sessions?: ActiveSession[];
        nextCursor?: string | null;
        hasMore?: boolean;
      } | null;
      if (isStale(captured)) return;
      setSessionsState({
        kind: "ready",
        data: {
          sessions: res?.sessions ?? [],
          nextCursor: res?.nextCursor ?? null,
          hasMore: res?.hasMore ?? false,
        },
      });
    } catch (err) {
      if (isStale(captured)) return;
      setSessionsState(
        classifyError<SessionsPage>(err, "We couldn't load the session inventory."),
      );
    } finally {
      if (!isStale(captured)) setSessionsBusy(false);
    }
  }, [teamId, includeRevoked, includeExpired, sessionsPager.cursor, stamp, isStale]);

  const loadQuarantined = useCallback(async () => {
    if (!teamId) return;
    setQuarantineState((prev) =>
      prev.kind === "ready" ? prev : { kind: "loading" },
    );
    setQuarantineBusy(true);
    const captured = stamp();
    try {
      const qs = new URLSearchParams({ teamId, limit: String(PAGE_SIZE) });
      if (quarantinePager.cursor) qs.set("cursor", quarantinePager.cursor);
      const res = (await apiFetch(
        `/v1/admin/identity/quarantined-sessions?${qs.toString()}`,
        { method: "GET" },
      )) as {
        items?: QuarantineRow[];
        nextCursor?: string | null;
        hasMore?: boolean;
      } | null;
      if (isStale(captured)) return;
      setQuarantineState({
        kind: "ready",
        data: {
          items: res?.items ?? [],
          nextCursor: res?.nextCursor ?? null,
          hasMore: res?.hasMore ?? false,
        },
      });
    } catch (err) {
      if (isStale(captured)) return;
      setQuarantineState(
        classifyError<QuarantinePage>(
          err,
          "We couldn't load the sessions held for review.",
        ),
      );
    } finally {
      if (!isStale(captured)) setQuarantineBusy(false);
    }
  }, [teamId, quarantinePager.cursor, stamp, isStale]);

  const reload = useCallback(async () => {
    await Promise.all([loadSessions(), loadQuarantined()]);
  }, [loadSessions, loadQuarantined]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    void loadQuarantined();
  }, [loadQuarantined]);

  useEffect(() => {
    setTimelineFor(null);
  }, [teamId]);

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
        // A hold or a release changes both tables; a revoke changes one and
        // the other is cheap. Reload both, on their current pages.
        await reload();
      } catch (err) {
        if (isStale(captured)) return;
        const code = ((err as { code?: string }).code ?? "").toUpperCase();
        if (code === "STEP_UP_CANCEL") return;
        notifyApiError(addToast, err, { message: opts.failureMessage });
      } finally {
        setBusy(null);
      }
    },
    [confirm, stepUp, stamp, isStale, addToast, reload],
  );

  const description = <SectionDescription text={DESCRIPTION} />;

  if (!teamId) {
    return (
      <PageSection title="Active sessions" description={description}>
        <NoWorkspaceSelected purpose="Switch to a workspace to view and govern its live sessions." />
      </PageSection>
    );
  }
  if (sessionsState.kind === "loading") {
    return (
      <PageSection title="Active sessions" description={description}>
        <SectionLoading label="Reading the live session inventory…" />
      </PageSection>
    );
  }
  if (sessionsState.kind === "denied") {
    return (
      <PageSection title="Active sessions" description={description}>
        <SectionDenied
          message={sessionsState.message}
          hint="Session governance requires owner or admin access on this workspace. This is a refusal — it does not mean the workspace has no sessions."
        />
      </PageSection>
    );
  }
  if (sessionsState.kind === "error") {
    return (
      <PageSection title="Active sessions" description={description}>
        <SectionError message={sessionsState.message} onRetry={() => void reload()} />
      </PageSection>
    );
  }

  const { sessions, nextCursor, hasMore } = sessionsState.data;
  const quarantinedOnThisPage = new Set(
    quarantineState.kind === "ready"
      ? quarantineState.data.items.map((q) => q.sessionId)
      : [],
  );
  // The server's own flag first; the quarantine page can only vouch for the
  // rows it holds.
  const isQuarantined = (s: ActiveSession) =>
    s.quarantined ?? quarantinedOnThisPage.has(s.id);

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
        ) : isQuarantined(s) ? (
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
      /**
       * A DESCRIPTOR, NOT THE USER-AGENT.
       *
       * This printed `uaPreview` — the raw UA truncated to 120 characters —
       * which wrapped to five or six lines in a 207px column and dragged every
       * other cell in the row with it. Measured: 205px per row over 75 rows, a
       * 15,409px table, and the four sections below it pushed past 16,000px.
       *
       * It also made this section's own description false, which says raw
       * user-agent strings are never rendered.
       *
       * The stored preview stays on `title`: an operator chasing an anomalous
       * session sometimes needs the exact string, and hiding it entirely would
       * trade one honesty problem for another.
       */
      render: (s) => {
        const described = describeClient(s.uaPreview);
        return (
          <div style={{ fontSize: 11 }} title={s.uaPreview ?? undefined}>
            <div>{described ?? "Unrecognised client"}</div>
            <div style={sectionMuted}>{s.ipPreview ?? "no network preview"}</div>
          </div>
        );
      },
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

  const sessionsPagerControl = (
    <CursorPager
      pager={sessionsPager}
      nextCursor={nextCursor}
      hasMore={hasMore}
      loading={sessionsBusy}
      data-testid="admin-sessions-pager"
    />
  );

  return (
    <PageSection
      title="Active sessions"
      description={description}
      data-active-sessions-section
      action={
        <Button variant="secondary" onClick={() => void reload()}>
          Refresh
        </Button>
      }
    >
      {/* WHAT YOU SEE, separated from WHAT AN ACTION WILL DO.
          These three controls shared one box: two of them filter the list and
          the third sets the reason recorded when you quarantine a session.
          Side by side they read as one group, so it was not apparent that
          changing the third alters an audit record rather than the view. */}
      <FilterBar style={{ marginBottom: 12 }}>
        <FilterBar.Select
          label="Revoked sessions"
          value={includeRevoked ? "include" : "exclude"}
          onChange={(v) => setIncludeRevoked(v === "include")}
          options={[
            { value: "exclude", label: "Hide revoked" },
            { value: "include", label: "Show revoked" },
          ]}
        />
        <FilterBar.Select
          label="Expired sessions"
          value={includeExpired ? "include" : "exclude"}
          onChange={(v) => setIncludeExpired(v === "include")}
          options={[
            { value: "exclude", label: "Hide expired" },
            { value: "include", label: "Show expired" },
          ]}
        />
      </FilterBar>

      <Card padding="compact" style={{ marginBottom: 12 }}>
        <div
          style={{ display: "flex", gap: 16, alignItems: "flex-end", flexWrap: "wrap" }}
        >
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
        loading={sessionsBusy}
        ariaLabel="Active sessions inventory"
        emptyState={
          <EmptyState variant="inline"
            title="No sessions match these filters"
            purpose="Nobody currently holds a live session in this workspace under the filters above. Turn on “Show revoked” or “Show expired” to widen the view."
          />
        }
        rowActions={(s) => (
          /**
           * One line, not a wrapped stack.
           *
           * Four buttons with `flexWrap` in a 193px column became four rows,
           * so the actions were as tall as the record they act on. `nowrap`
           * plus the table's own horizontal scroll container keeps them on one
           * line at every width — the table scrolls, the row does not grow.
           */
          <div
            style={{
              display: "flex",
              gap: 4,
              flexWrap: "nowrap",
              whiteSpace: "nowrap",
              justifyContent: "flex-end",
            }}
          >
            <Button variant="secondary" size="sm" onClick={() => setTimelineFor(s.id)}>
              Timeline
            </Button>
            {!s.revoked && !isQuarantined(s) ? (
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
                  // The button says "Revoke all"; the dialog is where the
                  // scope is spelled out in full, which is the place a
                  // destructive action's blast radius belongs.
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
              Revoke all
            </Button>
          </div>
        )}
      />
      {/* The server says whether there is another page; the count never
          infers it from a full one. The default view hides revoked and
          expired sessions, which IS a filter — the empty wording has to say
          "match these filters" rather than claim the workspace has none. */}
      <ResultCount
        shown={sessions.length}
        hasMore={hasMore}
        noun="session"
        filtered={!includeRevoked || !includeExpired}
        loading={sessionsBusy}
        action={sessionsPagerControl}
        data-testid="admin-sessions-count"
      />

      <h3 style={{ fontSize: 13, fontWeight: 700, margin: "20px 0 8px" }}>
        Sessions held for review
      </h3>
      {quarantineState.kind === "loading" ? (
        <SectionLoading label="Reading the sessions held for review…" />
      ) : quarantineState.kind === "denied" ? (
        <SectionDenied message={quarantineState.message} />
      ) : quarantineState.kind === "error" ? (
        <SectionError
          message={quarantineState.message}
          onRetry={() => void loadQuarantined()}
        />
      ) : (
        <>
          <DataTable
            columns={quarantineColumns}
            rows={quarantineState.data.items}
            getRowId={(q) => q.sessionId}
            loading={quarantineBusy}
            ariaLabel="Quarantined sessions"
            emptyState={
              <EmptyState variant="inline"
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
          <ResultCount
            shown={quarantineState.data.items.length}
            hasMore={quarantineState.data.hasMore}
            noun="held session"
            loading={quarantineBusy}
            action={
              <CursorPager
                pager={quarantinePager}
                nextCursor={quarantineState.data.nextCursor}
                hasMore={quarantineState.data.hasMore}
                loading={quarantineBusy}
                data-testid="admin-quarantine-pager"
              />
            }
            data-testid="admin-quarantine-count"
          />
        </>
      )}

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
