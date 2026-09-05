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

import { describeClient } from "../../../../../lib/ui/describeClient";
import { apiFetch } from "../../../../../lib/api";
import { useTeamId, useTenantGuard } from "../../../../../lib/platform-context";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import { FilterBar } from "../../../../../components/ui/FilterBar";
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
import { ResultCount } from "../../../../../components/ui/ResultCount";
import {
  CursorPager,
  useCursorPager,
} from "../../../../../components/ui/CursorPager";
import {
  AdmInline,
} from "../../../../../components/admin/AdminSurfaces";
import { formatCellDateTime } from "../../../../../lib/date";

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
 * The release window the quarantine request has always sent. It was a bare
 * literal inside the call, invisible to the operator being asked to approve
 * it; naming it here lets the dialog state the consequence it causes.
 */
const QUARANTINE_RELEASE_HOURS = 4;

/**
 * A safe human identifier for the session subject.
 *
 * The dialog must not say only "this session". It also must not print a raw
 * user agent or IP — those are the fields this console deliberately previews
 * rather than exposes.
 */
function describeSessionSubject(s: SessionRow): string {
  const client = describeClient(s.uaPreview);
  return client
    ? `The session on ${client}`
    : `Session ${s.id.slice(0, 8)}`;
}

/**
 * What a re-score found. The previous score is what makes the new one
 * meaningful: an operator needs to know whether pressing the button moved
 * anything, and in which direction.
 */
type RiskScoreResult = {
  sessionId: string;
  riskScore: number;
  level: string;
  previousRiskScore: number | null;
  previousLevel: string | null;
  evaluatedAtUtc: string;
  changed: boolean;
  signals?: ReadonlyArray<{ kind: string; weight: number; reason: string }>;
};

/**
 * One sentence naming before, after and whether it moved.
 *
 * "Session re-scored." was true and useless. A first-ever score is called out
 * separately, because "no previous score" and "previously zero" are different
 * facts and collapsing them would misreport a brand-new session as unchanged.
 */
function describeRescore(r: RiskScoreResult | undefined | null): string {
  if (!r) return "Session re-scored.";
  if (r.previousRiskScore === null) {
    return `Scored for the first time: ${r.riskScore} (${r.level}).`;
  }
  if (!r.changed) {
    return `Re-scored: unchanged at ${r.riskScore} (${r.level}).`;
  }
  const direction = r.riskScore > r.previousRiskScore ? "up" : "down";
  return `Re-scored ${direction}: ${r.previousRiskScore} (${r.previousLevel}) → ${r.riskScore} (${r.level}).`;
}

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

/**
 * The session query, built in one place.
 *
 * A uuid is the only thing the API accepts for userId, so a partial string is
 * NOT sent — sending it would return everything and look like the filter had
 * simply found nothing, which is the most misleading possible outcome for a
 * search box.
 */
function sessionQuery(
  teamId: string,
  userId: string,
  includeRevoked: boolean,
  includeExpired: boolean,
  cursor: string | null,
): string {
  const p = new URLSearchParams();
  p.set("teamId", teamId);
  // 25 per page over the server cursor. The 500-row read predates the
  // cursor; on a monitor an operator scans pages, not a quarter-mile table.
  p.set("limit", "25");
  if (cursor) p.set("cursor", cursor);
  p.set("includeRevoked", String(includeRevoked));
  p.set("includeExpired", String(includeExpired));
  const trimmed = userId.trim();
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)
  ) {
    p.set("userId", trimmed);
  }
  return p.toString();
}

export default function IdentityRuntimePage() {
  const teamId = useTeamId();
  const { stamp, isStale } = useTenantGuard();
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  /**
   * Filters the API has always accepted and this page never offered.
   *
   * GET /v1/admin/identity/sessions takes userId, includeRevoked and
   * includeExpired. The page hard-coded includeRevoked=true and limit=500 and
   * exposed nothing, so a workspace with more than 500 sessions showed an
   * arbitrary 500 and an operator looking for one person's sessions had to
   * read the whole table.
   *
   * These are server-side: they go into the request, so narrowing changes what
   * the API returns rather than what the browser draws. A filter that only
   * hides rows already fetched would still be capped at the same 500.
   */
  const [userFilter, setUserFilter] = useState("");
  // Default OFF. The page used to REQUEST revoked sessions and then hide
  // them in the browser — over a paged read that would silently shrink
  // pages. The server filter is the only honest one, and "Include revoked"
  // now actually shows what it fetched.
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const [includeExpired, setIncludeExpired] = useState(false);
  const [sessionsMore, setSessionsMore] = useState<{ nextCursor: string | null; hasMore: boolean }>({ nextCursor: null, hasMore: false });
  const [quarantined, setQuarantined] = useState<QuarantineRow[] | null>(null);
  const [quarantineMore, setQuarantineMore] = useState<{ nextCursor: string | null; hasMore: boolean }>({ nextCursor: null, hasMore: false });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reconcile, setReconcile] = useState<ReconcileResult | null>(null);
  const [scoreResult, setScoreResult] = useState<RiskScoreResult | null>(null);
  const [emergencyReason, setEmergencyReason] = useState("");
  /**
   * The quarantine reason, chosen from the catalog the API validates against.
   * It was previously typed into a window.prompt that accepted any string and
   * then rejected all but eight of them.
   */
  const [quarantineReason, setQuarantineReason] =
    useState<(typeof QUARANTINE_REASONS)[number]>("MANUAL_OPERATOR");
  const { confirm } = useConfirmAction();
  const stepUp = useStepUpAction({ teamId });
  // Scope keys fold every server filter in, so changing one resets the walk
  // — a cursor from one filter must never ride another.
  const sessionsPager = useCursorPager(
    `${teamId ?? ""}|${userFilter}|${includeRevoked}|${includeExpired}`,
  );
  const quarantinePager = useCursorPager(teamId ?? "");

const load = useCallback(() => {
    if (!teamId) return;
    Promise.all([
      apiFetch(
        `/v1/admin/identity/sessions?${sessionQuery(teamId, userFilter, includeRevoked, includeExpired, sessionsPager.cursor)}`,
        { method: "GET" },
      ).catch(() => ({ sessions: [] })),
      apiFetch(
        `/v1/admin/identity/quarantined-sessions?teamId=${encodeURIComponent(teamId)}&limit=25${quarantinePager.cursor ? `&cursor=${encodeURIComponent(quarantinePager.cursor)}` : ""}`,
        { method: "GET" },
      ).catch(() => ({ items: [] })),
    ]).then(
      ([s, q]: [
        { sessions?: SessionRow[]; nextCursor?: string | null; hasMore?: boolean },
        { items?: QuarantineRow[]; nextCursor?: string | null; hasMore?: boolean },
      ]) => {
        setSessions(s.sessions ?? []);
        setSessionsMore({ nextCursor: s.nextCursor ?? null, hasMore: s.hasMore ?? false });
        setQuarantined(q.items ?? []);
        setQuarantineMore({ nextCursor: q.nextCursor ?? null, hasMore: q.hasMore ?? false });
        setError(null);
      },
    );
  }, [teamId, userFilter, includeRevoked, includeExpired, sessionsPager.cursor, quarantinePager.cursor]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * QUARANTINE — the canonical dialog, naming who and for how long.
   *
   * This used to collect the reason through `window.prompt`. Three things
   * were wrong with that, and only the first is about accessibility:
   *
   *   * `window.prompt` is not the canonical dialog. It cannot be styled, it
   *     traps no focus, it is not announced, and it is blocked outright in
   *     some browsers — an operator with it disabled had a button that
   *     silently did nothing.
   *   * It named no target. The operator saw "Quarantine reason" with no
   *     indication of WHOSE session was about to be cut off; the only
   *     identifier on screen was a row they had to have kept their eye on.
   *   * It disclosed no consequence. `releaseHours: 4` is sent on every
   *     call and was never shown, so the dialog asked for a reason while
   *     concealing the effect.
   *
   * The reason now comes from a real select over the same catalog — a free
   * text box that only accepts eight values was a quiz — and the dialog
   * names the person, the session and the four hours before submitting.
   */
  const quarantine = useCallback(
    async (sessionId: string) => {
      if (!teamId) return;
      const session = (sessions ?? []).find((s) => s.id === sessionId);
      const reason = quarantineReason;
      if (!QUARANTINE_REASONS.includes(reason as never)) {
        setError("Reason must be one of " + QUARANTINE_REASONS.join(", "));
        return;
      }
      const who = session ? describeSessionSubject(session) : "this session";
      const ok = await confirm({
        title: "Quarantine this session?",
        tone: "warning",
        confirmLabel: "Quarantine session",
        testId: "confirm-quarantine-session",
        description: (
          <>
            <p>
              {who} will be blocked from using this session for{" "}
              <strong>{QUARANTINE_RELEASE_HOURS} hours</strong>, after which it
              is released automatically. It affects this one session, not the
              person&rsquo;s other sessions and not their account.
            </p>
            <p>
              Recorded reason: <strong>{reason}</strong>. You can release the
              session sooner from the quarantine list below.
            </p>
          </>
        ),
      });
      if (!ok) return;
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
              releaseHours: QUARANTINE_RELEASE_HOURS,
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
    [teamId, load, confirm, quarantineReason, sessions],
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
        /*
         * RE-SCORE HAS TO SAY WHAT IT FOUND.
         *
         * This announced "Session re-scored." and reloaded. An operator
         * pressing it learned nothing: not the previous score, not the new
         * one, not when the evaluation ran, and — most importantly — not
         * whether pressing it had changed anything at all. A button whose
         * whole purpose is to re-evaluate cannot be the one control that
         * refuses to report its result.
         */
        const res = (await apiFetch(
          `/v1/admin/identity/sessions/${encodeURIComponent(sessionId)}/score`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ teamId }),
          },
        )) as { result?: RiskScoreResult };
        setScoreResult(res?.result ?? null);
        setNotice(describeRescore(res?.result));
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
    if (!teamId || busy !== null) return;
    const reason = emergencyReason;
    if (!reason || reason.trim().length < 8) {
      setError("Reason must be at least 8 chars.");
      return;
    }
    const ok = await confirm({
      title: "Emergency org-wide session revoke?",
      description: `EVERY active session in this workspace will be terminated. All users will be signed out. This action is logged with the incident reason "${reason.trim()}" and cannot be undone.`,
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
      // Re-read the runtime BEFORE announcing: the notice describes the
      // state the operator is now looking at, not the one they left.
      await load();
      setNotice(
        `Revoked ${res?.usersRevoked ?? 0} users (${res?.sessionsAffected ?? 0} sessions).`,
      );
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
  }, [teamId, load, confirm, busy, emergencyReason]);

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
      await load();
      if (isStale(captured)) return;
      setReconcile({
        scope: res?.scope ?? "workspace",
        expiredStepUps: res?.expiredStepUps ?? 0,
        expiredDevices: res?.expiredDevices ?? 0,
        ranAt: new Date().toISOString(),
      });
      setError(null);
      setNotice(null);
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
        <EmptyState variant="inline"
          framed
          title="No workspace selected"
          purpose="Switch to a workspace to monitor its live sessions and quarantine posture."
        />
      </PageShell>
    );
  }

  // The revoked/expired narrowing is the SERVER's, via the filters above —
  // a client-side filter over a paged read would silently shrink pages.
  const activeSessions = sessions ?? [];

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
        <span className="adm-help" style={{ fontSize: 11 }}>{q.quarantineReason}</span>
      ),
    },
    {
      key: "quarantined",
      header: "Quarantined",
      nowrap: true,
      render: (q) => (
        <span className="adm-help">{formatCellDateTime(q.quarantinedAtUtc)}</span>
      ),
    },
    {
      key: "autorelease",
      header: "Auto-release",
      nowrap: true,
      render: (q) => (
        <span className="adm-help">{formatCellDateTime(q.quarantineReleaseAtUtc)}</span>
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
        <span className="adm-help" style={{ fontSize: 11 }}>
          {s.ssoConnectionId ? s.ssoConnectionId.slice(0, 8) + "…" : "—"}
        </span>
      ),
    },
    {
      key: "lastseen",
      header: "Last seen",
      nowrap: true,
      render: (s) => (
        <span className="adm-help">{formatCellDateTime(s.lastSeenAtUtc)}</span>
      ),
    },
    {
      key: "device",
      header: "Device",
      // The same raw user-agent that made /admin/identity/sessions 205px per
      // row. Here it was 109px over 78 rows. A descriptor answers the only
      // question this column is asked — is that plausibly the same person —
      // and the stored preview stays on hover for the cases that need it.
      render: (s) => (
        <div style={{ fontSize: 11 }} title={s.uaPreview ?? undefined}>
          <div>{s.ipPreview ?? "—"}</div>
          <div className="adm-help">
            {describeClient(s.uaPreview) ?? "Unrecognised client"}
          </div>
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
            <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
              {/* The incident reason used to be collected by window.prompt —
                  unstyled, unlabelled, and invisible to the accessibility
                  tree. It is a field now, and the dialog repeats it. */}
              <label style={{ fontSize: 12 }}>
                <span className="app-visually-hidden">Incident reason for emergency revoke</span>
                <input
                  className="input"
                  value={emergencyReason}
                  onChange={(e) => setEmergencyReason(e.target.value)}
                  placeholder="Incident reason (audited, 8+ chars)"
                  maxLength={400}
                  style={{ minWidth: 220 }}
                  data-testid="identity-runtime-emergency-reason"
                />
              </label>
              <Button
                variant="destructive"
                onClick={emergencyRevoke}
                disabled={busy !== null}
                loading={busy === "emergency"}
                data-testid="identity-runtime-emergency-revoke-button"
              >
                Emergency org revoke
              </Button>
            </span>
          }
        />
      }
              >
      {error ? <AdmInline state="error">{error}</AdmInline> : null}
      {notice ? <AdmInline state="done">{notice}</AdmInline> : null}

      {/*
        THE RE-SCORE RESULT, SHOWN RATHER THAN SUMMARISED AWAY.

        The sentence above already says whether the score moved. This panel
        carries what an operator needs to act on it: both numbers with their
        bands, when the evaluation actually ran, and the signals that produced
        it. Without the signals a changed score is a verdict with no reasons.
      */}
      {scoreResult ? (
        <Card padding="comfortable" data-rescore-result>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <Badge tone={scoreResult.changed ? "pending" : "neutral"} dot>
              {scoreResult.changed ? "Score changed" : "No change"}
            </Badge>
            <span style={{ fontSize: 13 }}>
              {scoreResult.previousRiskScore === null
                ? "No previous score"
                : `${scoreResult.previousRiskScore} (${scoreResult.previousLevel})`}
              {" → "}
              <strong>
                {scoreResult.riskScore} ({scoreResult.level})
              </strong>
            </span>
            <span className="adm-help" style={{ fontSize: 12 }}>
              evaluated {formatCellDateTime(scoreResult.evaluatedAtUtc)}
            </span>
          </div>
          {scoreResult.signals && scoreResult.signals.length > 0 ? (
            <ul style={{ margin: "10px 0 0", paddingInlineStart: 18, fontSize: 12.5 }}>
              {scoreResult.signals.map((sig) => (
                <li key={sig.kind}>
                  <strong>{sig.kind.replace(/_/g, " ").toLowerCase()}</strong> (+{sig.weight}) — {sig.reason}
                </li>
              ))}
            </ul>
          ) : (
            <p className="adm-help" style={{ fontSize: 12.5, margin: "10px 0 0" }}>
              No risk signals fired for this session.
            </p>
          )}
        </Card>
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
            <p className="adm-help" style={{ margin: 0 }}>
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
              <Badge tone="neutral">ran {formatCellDateTime(reconcile.ranAt)}</Badge>
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
            <EmptyState variant="inline"
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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <ResultCount
            shown={quarantined?.length ?? 0}
            hasMore={quarantineMore.hasMore}
            noun="quarantined session"
            loading={quarantined === null}
            data-testid="admin-identity-runtime-quarantine-count"
          />
          <CursorPager
            pager={quarantinePager}
            nextCursor={quarantineMore.nextCursor}
            hasMore={quarantineMore.hasMore}
            loading={quarantined === null}
            data-testid="admin-identity-runtime-quarantine-pager"
          />
        </div>
      </PageSection>

      <PageSection title="Active sessions">
        {/* Server-side. Every control here goes into the request, so the
            500-row cap applies to the NARROWED set rather than to an
            arbitrary first page that is then filtered in the browser. */}
        <FilterBar style={{ marginBottom: 12 }}>
          <FilterBar.Search
            label="User ID"
            placeholder="Full user UUID"
            value={userFilter}
            onChange={setUserFilter}
          />
          <FilterBar.Select
            label="Revoked"
            value={includeRevoked ? "include" : "exclude"}
            onChange={(v) => setIncludeRevoked(v === "include")}
            options={[
              { value: "include", label: "Include revoked" },
              { value: "exclude", label: "Active only" },
            ]}
          />
          <FilterBar.Select
            label="Expired"
            value={includeExpired ? "include" : "exclude"}
            onChange={(v) => setIncludeExpired(v === "include")}
            options={[
              { value: "exclude", label: "Hide expired" },
              { value: "include", label: "Include expired" },
            ]}
          />
          {/*
            The reason a quarantine will be recorded under, picked before the
            action rather than typed into a prompt afterwards. The API
            validates against exactly this catalog, so offering a free text
            box was asking the operator to guess one of eight strings.
          */}
          <FilterBar.Select
            label="Quarantine reason"
            value={quarantineReason}
            onChange={(v) =>
              setQuarantineReason(v as (typeof QUARANTINE_REASONS)[number])
            }
            options={QUARANTINE_REASONS.map((r) => ({
              value: r,
              label: r.replace(/_/g, " ").toLowerCase(),
            }))}
          />
        </FilterBar>
        <DataTable
          columns={sessionColumns}
          rows={activeSessions}
          getRowId={(s) => s.id}
          loading={sessions === null}
          ariaLabel="Active sessions"
          emptyState={
            <EmptyState variant="inline"
              title={userFilter.trim() !== "" || !includeRevoked || includeExpired ? "No sessions match these filters" : "No active sessions"}
              purpose={userFilter.trim() !== "" || !includeRevoked || includeExpired
                ? "No session matches the current user, revoked or expired filters. Clearing them shows every live session in this workspace."
                : "Live sessions across this workspace appear here for re-scoring and quarantine."}
            />
          }
          rowActions={(s) => (
            /* One line. Two buttons wrapping in a 122px column made every
               row 109px tall over 79 rows — the actions were taller than the
               record. The table scrolls horizontally; the row does not grow. */
            <div
              style={{
                display: "flex",
                gap: 4,
                flexWrap: "nowrap",
                whiteSpace: "nowrap",
                justifyContent: "flex-end",
              }}
            >
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
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <ResultCount
            shown={sessions?.length ?? 0}
            hasMore={sessionsMore.hasMore}
            noun="session"
            filtered={userFilter.trim() !== "" || includeRevoked || includeExpired}
            loading={sessions === null}
            data-testid="admin-identity-runtime-count"
          />
          <CursorPager
            pager={sessionsPager}
            nextCursor={sessionsMore.nextCursor}
            hasMore={sessionsMore.hasMore}
            loading={sessions === null}
            data-testid="admin-identity-runtime-pager"
          />
        </div>
      </PageSection>

      <StepUpModal control={stepUp} />
    </PageShell>
  );
}
