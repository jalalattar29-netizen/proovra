"use client";

/**
 * PHASE R8.1.5 — MFA recovery admin SPA.
 *
 * Operational admin queue for lost-factor MFA recovery requests in
 * the active team. The page is intentionally minimal — it is NOT a
 * decorative security dashboard, NOT a fake security-score widget,
 * and NOT a marketing surface. It lists pending requests, lets an
 * admin view detail + approve / reject, and surfaces email-
 * verification status so admins know whether the user has confirmed
 * mailbox access.
 *
 * Hard rules (UI-enforced):
 *   - The page consumes the existing R8.1.4/R8.1.5 admin endpoints
 *     ONLY. No bespoke auth, no secret rendering, no token display.
 *   - Approve / reject actions show a confirmation modal explaining
 *     that approval forces re-enrollment and does NOT grant a session.
 *   - Email-pending rows are shown with a clear "user has not yet
 *     verified their email" label and the approve button is
 *     disabled until verification is recorded.
 */

import { useEffect, useState, type CSSProperties } from "react";

import { useTeamId } from "../../../../lib/platform-context";
import { apiFetch, ApiError } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { formatUserDateTime, formatUtcAuditDateTime } from "../../../../lib/date";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { MfaRecoveryApprovalHistoryBlock } from "../../../../components/hidden-feature-panels/HiddenFeaturePanels";
import { PageShell, PageHeader, PageSection } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { Badge } from "../../../../components/ui/Badge";
import {
  DataTable,
  type DataTableColumn,
} from "../../../../components/ui/DataTable";
import { EmptyState } from "../../../../components/ui/EmptyState";

type AdminRecoveryRequest = {
  id: string;
  userId: string;
  reason: string;
  status: "EMAIL_VERIFICATION_PENDING" | "PENDING_ADMIN_REVIEW";
  requiredApprovals: number;
  approvalCount: number;
  expiresAt: string;
  createdAt: string;
  emailVerified: boolean;
};

type RequestDetail = AdminRecoveryRequest & {
  teamId: string;
  emailResendCount: number;
};

type ConfirmAction =
  | { kind: "approve"; requestId: string; userId: string }
  | { kind: "reject"; requestId: string; userId: string }
  | null;

export default function MfaRecoveryAdminPage() {
  // R8.1.5 — canonical PageRouteGate. The /security-center parent
  // page uses the same `workspace.security_center` route id; this
  // sub-page is a dedicated admin lifecycle surface inside that
  // gated area, so we reuse the same id (the gate already enforces
  // the workspace-admin permission contract via ROUTE_REGISTRY).
  return (
    <PageRouteGate routeId="workspace.security_center">
      <MfaRecoveryAdminBody />
    </PageRouteGate>
  );
}

// PHASE R8.1.8 — preference + preview wire-shape.
type DigestPreferenceRow = {
  id: string;
  userId: string;
  teamId: string | null;
  digestEnabled: boolean;
  suppressUntil: string | null;
  createdAt: string;
  updatedAt: string;
};

type DigestPreviewTeam = {
  teamId: string;
  teamName: string;
  pendingCount: number;
  oldestRequestAgeSeconds: number;
  adminRecoveryUrl: string;
  suppressedByPreference: boolean;
};

type DigestPreview = {
  adminUserId: string;
  generatedAt: string;
  teamCount: number;
  requestCount: number;
  teams: DigestPreviewTeam[];
  suppressedTeamCount: number;
};

function MfaRecoveryAdminBody() {
  const teamId = useTeamId();
  const [requests, setRequests] = useState<AdminRecoveryRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<ConfirmAction>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<RequestDetail | null>(null);
  // PHASE R8.1.8 — digest preferences + preview state. Preferences
  // affect ONLY notification emails (the SPA queue + audit log +
  // security events are unaffected). Copy is reinforced in the UI.
  const [preferences, setPreferences] = useState<DigestPreferenceRow[] | null>(
    null,
  );
  const [preview, setPreview] = useState<DigestPreview | null>(null);
  const [previewIncludeSuppressed, setPreviewIncludeSuppressed] = useState(false);
  const [prefsBusy, setPrefsBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Operational reload. Pulls the bounded admin queue from
  // /v1/identity/mfa-admin/recovery-requests/:teamId. The API
  // returns 403 to non-admin viewers; we surface that as an
  // explicit message rather than an empty list.
  const reload = async () => {
    if (!teamId) return;
    try {
      const r = await apiFetch(
        `/v1/identity/mfa-admin/recovery-requests/${encodeURIComponent(teamId)}`,
        { method: "GET" },
      );
      setRequests(r.requests ?? []);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 403) {
        setError(
          "You must be an organization OWNER or ADMIN to view MFA recovery requests.",
        );
        setRequests([]);
        return;
      }
      const msg = toSafeUserError(err, { message: "Could not load requests." }).message;
      setError(msg);
      setRequests([]);
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId]);

  // PHASE R8.1.8 — preferences fetch.
  const reloadPreferences = async () => {
    try {
      const r = await apiFetch(
        "/v1/identity/mfa-admin/digest-preferences",
        { method: "GET" },
      );
      setPreferences(r.preferences ?? []);
    } catch {
      setPreferences([]);
    }
  };

  // PHASE R8.1.8 — preview fetch. Read-only; no side effect.
  const reloadPreview = async (includeSuppressed: boolean) => {
    try {
      const r = await apiFetch(
        `/v1/identity/mfa-admin/digest-preferences/preview${
          includeSuppressed ? "?includeSuppressed=true" : ""
        }`,
        { method: "GET" },
      );
      setPreview(r.preview ?? null);
    } catch {
      setPreview(null);
    }
  };

  useEffect(() => {
    void reloadPreferences();
    void reloadPreview(previewIncludeSuppressed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewIncludeSuppressed]);

  // PHASE R8.1.8 — snooze quick action. Sends a PATCH with
  // `suppressUntil = now + 7d` for the targeted scope. Optional
  // `teamId` writes a team-scoped row; omit for global.
  const doSnooze = async (scopeTeamId: string | null, days: number) => {
    setPrefsBusy(true);
    try {
      const suppressUntil = new Date(
        Date.now() + days * 24 * 60 * 60 * 1000,
      ).toISOString();
      await apiFetch(
        "/v1/identity/mfa-admin/digest-preferences",
        {
          method: "PATCH",
          body: JSON.stringify({
            teamId: scopeTeamId,
            digestEnabled: true,
            suppressUntil,
          }),
        },
      );
      setToast(`Snoozed for ${days} day${days === 1 ? "" : "s"}.`);
      await reloadPreferences();
      await reloadPreview(previewIncludeSuppressed);
    } catch (err) {
      const msg =
        toSafeUserError(err, { message: "Could not snooze digest." }).message;
      setError(msg);
    } finally {
      setPrefsBusy(false);
      window.setTimeout(() => setToast(null), 4000);
    }
  };

  const doResume = async (scopeTeamId: string | null) => {
    setPrefsBusy(true);
    try {
      await apiFetch(
        "/v1/identity/mfa-admin/digest-preferences",
        {
          method: "PATCH",
          body: JSON.stringify({
            teamId: scopeTeamId,
            digestEnabled: true,
            suppressUntil: null,
          }),
        },
      );
      setToast("Digest notifications resumed.");
      await reloadPreferences();
      await reloadPreview(previewIncludeSuppressed);
    } catch (err) {
      const msg =
        toSafeUserError(err, { message: "Could not resume digest." }).message;
      setError(msg);
    } finally {
      setPrefsBusy(false);
      window.setTimeout(() => setToast(null), 4000);
    }
  };

  const doToggleEnabled = async (
    scopeTeamId: string | null,
    enabled: boolean,
  ) => {
    setPrefsBusy(true);
    try {
      await apiFetch(
        "/v1/identity/mfa-admin/digest-preferences",
        {
          method: "PATCH",
          body: JSON.stringify({
            teamId: scopeTeamId,
            digestEnabled: enabled,
          }),
        },
      );
      setToast(enabled ? "Digest enabled." : "Digest disabled.");
      await reloadPreferences();
      await reloadPreview(previewIncludeSuppressed);
    } catch (err) {
      const msg =
        toSafeUserError(err, { message: "Could not update digest." }).message;
      setError(msg);
    } finally {
      setPrefsBusy(false);
      window.setTimeout(() => setToast(null), 4000);
    }
  };

  // Effective preference resolution — mirror the service.
  const globalPref = (preferences ?? []).find((p) => p.teamId === null);
  const isGloballySnoozed = (() => {
    if (!globalPref) return false;
    if (!globalPref.suppressUntil) return false;
    return new Date(globalPref.suppressUntil).getTime() > Date.now();
  })();

  const openDetail = async (requestId: string) => {
    try {
      const r = await apiFetch(
        `/v1/identity/mfa-admin/recovery-requests/detail/${encodeURIComponent(
          requestId,
        )}`,
        { method: "GET" },
      );
      setSelected(r.detail);
    } catch (err) {
      const msg = toSafeUserError(err, { message: "Could not load detail." }).message;
      setError(msg);
    }
  };

  const doApprove = async (requestId: string) => {
    setBusy(true);
    try {
      await apiFetch(
        `/v1/identity/mfa-admin/recovery-requests/${encodeURIComponent(
          requestId,
        )}/approve`,
        { method: "POST", body: JSON.stringify({}) },
      );
      await reload();
      setPendingAction(null);
      setSelected(null);
    } catch (err) {
      const msg = toSafeUserError(err, { message: "Approve failed." }).message;
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const doReject = async (requestId: string, reason: string) => {
    setBusy(true);
    try {
      await apiFetch(
        `/v1/identity/mfa-admin/recovery-requests/${encodeURIComponent(
          requestId,
        )}/reject`,
        {
          method: "POST",
          body: JSON.stringify({
            reason: reason.trim() || undefined,
          }),
        },
      );
      await reload();
      setPendingAction(null);
      setRejectReason("");
      setSelected(null);
    } catch (err) {
      const msg = toSafeUserError(err, { message: "Reject failed." }).message;
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const requestColumns: DataTableColumn<AdminRecoveryRequest>[] = [
    {
      key: "user",
      header: "User",
      render: (rq) => (
        <span
          data-cc-mfa-recovery-row
          data-cc-mfa-recovery-status={rq.status}
        >
          <button
            type="button"
            onClick={() => void openDetail(rq.id)}
            style={linkButtonStyle}
            data-cc-mfa-recovery-detail-cta
          >
            {rq.userId.slice(0, 8)}…
          </button>
        </span>
      ),
    },
    {
      key: "reason",
      header: "Reason",
      width: 280,
      render: (rq) => <span style={{ display: "block", maxWidth: 280 }}>{rq.reason}</span>,
    },
    {
      key: "emailVerified",
      header: "Email verified",
      render: (rq) =>
        rq.emailVerified ? (
          <Badge tone="verified" data-cc-mfa-email-verified="true">
            verified
          </Badge>
        ) : (
          <Badge tone="pending" data-cc-mfa-email-verified="false">
            awaiting user
          </Badge>
        ),
    },
    {
      key: "approvals",
      header: "Approvals",
      render: (rq) => (
        <span data-cc-mfa-recovery-quorum>
          <span
            style={{
              fontFamily: "ui-monospace, monospace",
              fontWeight: 600,
            }}
            data-cc-mfa-recovery-quorum-count
          >
            {rq.approvalCount}/{rq.requiredApprovals}
          </span>
          {/* PHASE R8.1.6 — quorum-not-met badge. Surfaces
               "waiting for additional approval" when at
               least one approval is recorded but the
               requiredApprovals threshold has not been hit. */}
          {rq.approvalCount > 0 && rq.approvalCount < rq.requiredApprovals ? (
            <div style={{ marginTop: 4 }} data-cc-mfa-recovery-quorum-waiting>
              <Badge tone="pending" subtle>
                Waiting for additional approval
              </Badge>
            </div>
          ) : null}
        </span>
      ),
    },
    {
      key: "expires",
      header: "Expires",
      nowrap: true,
      render: (rq) => formatUtcAuditDateTime(rq.expiresAt),
    },
  ];

  return (
    <PageShell
      data-page="mfa-recovery-admin"
      data-cc-mfa-recovery-admin-spa
      header={
        <PageHeader
          eyebrow="Security Center"
          title="MFA recovery — admin queue"
          subtitle={
            <>
              Members in this workspace who lost access to their two-factor
              authentication factors and have requested a reset. Approving a
              request revokes the user&apos;s existing MFA factors and forces
              them to re-enroll on their next login.{" "}
              <strong>Approval does NOT grant a session.</strong>
            </>
          }
          secondaryActions={
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void reload()}
                data-cc-mfa-recovery-refresh
              >
                Refresh
              </Button>
              {/* PHASE R8.1.8 — global snooze / resume quick action. The
                   button targets the GLOBAL (teamId=null) preference row
                   so a single click affects ALL of the admin's teams. */}
              {isGloballySnoozed ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void doResume(null)}
                  disabled={prefsBusy}
                  data-cc-mfa-recovery-digest-resume
                >
                  Resume digest notifications
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void doSnooze(null, 7)}
                  disabled={prefsBusy}
                  data-cc-mfa-recovery-digest-snooze
                  title="Pause digest emails for 7 days. Recovery queue + audit log unaffected."
                >
                  Snooze digest for 7 days
                </Button>
              )}
            </>
          }
        />
      }
    >
      {error ? (
        <Card variant="status" tone="risk" role="alert">
          {error}
        </Card>
      ) : null}
      {toast ? (
        <Card
          variant="status"
          tone="verified"
          role="status"
          data-cc-mfa-recovery-toast
        >
          {toast}
        </Card>
      ) : null}

      {!teamId ? (
        <EmptyState
          framed
          title="Switch to a workspace to view MFA recovery requests"
          purpose="Lost-factor recovery requests are scoped to a workspace. Open a workspace you administer to review the queue."
        />
      ) : (
        <PageSection title="Pending requests">
          <div data-cc-mfa-recovery-table>
          <DataTable<AdminRecoveryRequest>
            ariaLabel="MFA recovery requests"
            columns={requestColumns}
            rows={requests ?? []}
            getRowId={(rq) => rq.id}
            loading={requests === null}
            rowActions={(rq) => (
              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!rq.emailVerified || busy}
                  onClick={() =>
                    setPendingAction({
                      kind: "approve",
                      requestId: rq.id,
                      userId: rq.userId,
                    })
                  }
                  title={
                    rq.emailVerified
                      ? "Approve recovery request"
                      : "Cannot approve until the user verifies their email"
                  }
                  data-cc-mfa-recovery-approve
                >
                  Approve
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    setPendingAction({
                      kind: "reject",
                      requestId: rq.id,
                      userId: rq.userId,
                    })
                  }
                  disabled={busy}
                  data-cc-mfa-recovery-reject
                >
                  Reject
                </Button>
              </div>
            )}
            emptyState={
              <div data-cc-mfa-recovery-empty>
                <EmptyState
                  compact
                  title="No recovery codes generated"
                  purpose="No pending MFA recovery requests. When a member requests a lost-factor reset, it appears here for admin review."
                />
              </div>
            }
          />
          </div>
        </PageSection>
      )}

      {/* PHASE R8.1.8 — digest preview card. Read-only summary of
           what the next worker tick would email this admin. No
           approve/reject controls inside the preview — those live
           in the queue above. */}
      <Card variant="admin" data-cc-mfa-recovery-digest-preview-card>
        <h2 style={{ ...sectionTitleStyle, marginTop: 0 }}>Next digest preview</h2>
        <p style={mutedStyle}>
          A read-only preview of the consolidated email the worker
          would send you on its next tick.{" "}
          <strong>No email is sent.</strong>
        </p>
        <label
          style={{ display: "inline-flex", gap: 6, alignItems: "center" }}
          data-cc-mfa-recovery-digest-preview-toggle
        >
          <input
            type="checkbox"
            checked={previewIncludeSuppressed}
            onChange={(e) =>
              setPreviewIncludeSuppressed(e.target.checked)
            }
          />
          <span style={{ fontSize: 13 }}>
            Include teams my preferences would suppress
          </span>
        </label>
        {!preview ? (
          <p style={mutedStyle}>Loading preview…</p>
        ) : preview.teamCount === 0 && preview.suppressedTeamCount === 0 ? (
          <p style={mutedStyle} data-cc-mfa-recovery-digest-preview-empty>
            No teams have pending requests older than 24 hours. You
            won&apos;t receive a digest on the next tick.
          </p>
        ) : (
          <>
            <p style={{ fontSize: 14, marginTop: 8 }}>
              <strong>{preview.requestCount}</strong> request
              {preview.requestCount === 1 ? "" : "s"} across{" "}
              <strong>{preview.teamCount}</strong> team
              {preview.teamCount === 1 ? "" : "s"}
              {preview.suppressedTeamCount > 0 ? (
                <span style={{ color: "#92400e" }}>
                  {" "}
                  · {preview.suppressedTeamCount} team
                  {preview.suppressedTeamCount === 1 ? "" : "s"} suppressed
                  by your preferences
                </span>
              ) : null}
            </p>
            <ul
              style={listStyle}
              data-cc-mfa-recovery-digest-preview-teams
            >
              {preview.teams.map((t) => (
                <li
                  key={t.teamId}
                  style={rowStyle}
                  data-cc-mfa-recovery-digest-preview-team-row
                  data-cc-mfa-recovery-digest-preview-team-suppressed={
                    t.suppressedByPreference ? "true" : "false"
                  }
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>
                      {t.teamName}
                      {t.suppressedByPreference ? (
                        <Badge tone="pending" subtle style={{ marginLeft: 6 }}>
                          suppressed
                        </Badge>
                      ) : null}
                    </div>
                    <div style={mutedStyle}>
                      {t.pendingCount} request
                      {t.pendingCount === 1 ? "" : "s"} · oldest{" "}
                      {Math.max(
                        1,
                        Math.floor(t.oldestRequestAgeSeconds / 3600),
                      )}
                      h old
                    </div>
                  </div>
                  {/* Per-team snooze quick action. */}
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void doSnooze(t.teamId, 7)}
                    disabled={prefsBusy}
                    title="Snooze digest emails for this team for 7 days. Recovery queue + audit log unaffected."
                    data-cc-mfa-recovery-digest-snooze-team
                  >
                    Snooze 7d
                  </Button>
                </li>
              ))}
            </ul>
            <p style={mutedStyle}>
              Generated{" "}
              {formatUtcAuditDateTime(preview.generatedAt)}.
            </p>
          </>
        )}
      </Card>

      {/* PHASE R8.1.8 — digest notification preferences card.
           Inline editor for the per-user + per-team digest
           preference rows. Affects EMAILS ONLY — the recovery
           queue, audit log, and security events are preserved
           unconditionally. */}
      <Card variant="admin" data-cc-mfa-recovery-digest-preferences-card>
        <h2 style={{ ...sectionTitleStyle, marginTop: 0 }}>Digest notification preferences</h2>
        <p style={mutedStyle}>
          Control which workspaces email you the daily MFA recovery
          digest.
        </p>
        <p style={warnBoxStyle} data-cc-mfa-recovery-preferences-disclaimer>
          Digest preferences only affect notification emails.
          Security events and audit logs are always preserved.
        </p>
        {/* Global row. */}
        <DigestPreferenceRowEditor
          label="All workspaces (default)"
          scopeTeamId={null}
          pref={preferences?.find((p) => p.teamId === null) ?? null}
          prefsBusy={prefsBusy}
          onToggleEnabled={(enabled) => void doToggleEnabled(null, enabled)}
          onSnooze={() => void doSnooze(null, 7)}
          onResume={() => void doResume(null)}
        />
        {/* Per-team overrides — render whatever rows exist. The
             admin can create a new one by snoozing a team from the
             preview above (which writes a row implicitly). */}
        {(preferences ?? [])
          .filter((p) => p.teamId !== null)
          .map((p) => (
            <DigestPreferenceRowEditor
              key={p.id}
              label={`Workspace ${p.teamId?.slice(0, 8) ?? ""}…`}
              scopeTeamId={p.teamId}
              pref={p}
              prefsBusy={prefsBusy}
              onToggleEnabled={(enabled) =>
                void doToggleEnabled(p.teamId, enabled)
              }
              onSnooze={() => void doSnooze(p.teamId, 7)}
              onResume={() => void doResume(p.teamId)}
            />
          ))}
        {!preferences || preferences.length === 0 ? (
          <p style={mutedStyle}>
            No saved preferences yet — defaults apply (all
            workspaces send the digest).
          </p>
        ) : null}
      </Card>

      {/* Detail modal — read-only */}
      {selected ? (
        <div
          style={modalBackdropStyle}
          onClick={() => setSelected(null)}
          data-cc-mfa-recovery-detail-modal
        >
          <div
            style={modalStyle}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>Request detail</h2>
            <DetailRow label="Request id" value={selected.id} />
            <DetailRow label="User id" value={selected.userId} />
            <DetailRow label="Team id" value={selected.teamId} />
            <DetailRow label="Status" value={selected.status} />
            <DetailRow
              label="Email verified"
              value={selected.emailVerified ? "yes" : "no"}
            />
            <DetailRow
              label="Email send attempts"
              value={String(selected.emailResendCount)}
            />
            <DetailRow
              label="Approvals"
              value={`${selected.approvalCount}/${selected.requiredApprovals}`}
            />
            <DetailRow
              label="Created"
              value={formatUtcAuditDateTime(selected.createdAt)}
            />
            <DetailRow
              label="Expires"
              value={formatUtcAuditDateTime(selected.expiresAt)}
            />
            <div style={{ marginTop: 12 }}>
              <strong>Reason:</strong>
              <p style={{ marginTop: 6 }}>{selected.reason}</p>
            </div>

            {/* Phase Final-Hidden-Feature-Surfacing — approval history.
                Reads the (previously orphaned) MfaRecoveryRequestApproval
                rows via the new bounded admin-on-team endpoint. */}
            <div style={{ marginTop: 16 }}>
              <MfaRecoveryApprovalHistoryBlock requestId={selected.id} />
            </div>

            <div style={{ marginTop: 16, textAlign: "right" }}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setSelected(null)}
              >
                Close
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Approve/Reject confirmation modal */}
      {pendingAction ? (
        <div
          style={modalBackdropStyle}
          onClick={() => !busy && setPendingAction(null)}
          data-cc-mfa-recovery-confirm-modal
        >
          <div
            style={modalStyle}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>
              {pendingAction.kind === "approve"
                ? "Approve MFA recovery"
                : "Reject MFA recovery"}
            </h2>
            {pendingAction.kind === "approve" ? (
              <>
                <p style={mutedStyle}>
                  Approving this request will revoke ALL of user{" "}
                  <code>{pendingAction.userId.slice(0, 8)}…</code>&apos;s
                  active MFA factors, invalidate their outstanding
                  recovery codes, AND reset their trusted devices.
                  They will be required to re-enroll a fresh
                  authenticator on their next login.
                </p>
                <p style={warnBoxStyle}>
                  Approval does <strong>NOT</strong> grant the user a
                  session. They must still complete their primary
                  credentials AND a fresh enrollment.
                </p>
                {/* PHASE R8.1.6 — quorum progress surfacing.
                     Looks up the live request row from the queue
                     (requests state) and shows N/M plus a clear
                     "needs one more approver" note when this is
                     the first of two. */}
                {(() => {
                  const live = (requests ?? []).find(
                    (r) => r.id === pendingAction.requestId,
                  );
                  if (!live) return null;
                  const remaining =
                    live.requiredApprovals - live.approvalCount;
                  return (
                    <div
                      style={{ marginTop: 12, fontSize: 14 }}
                      data-cc-mfa-recovery-approve-quorum
                    >
                      <strong>Quorum:</strong> {live.approvalCount}/
                      {live.requiredApprovals} approvals recorded.{" "}
                      {remaining > 1
                        ? `Your approval still needs ${remaining - 1} additional admin${
                            remaining - 1 === 1 ? "" : "s"
                          } before factors are reset.`
                        : remaining === 1
                          ? "Your approval will complete the quorum and revoke the user's factors immediately."
                          : null}
                    </div>
                  );
                })()}
              </>
            ) : (
              <>
                <p style={mutedStyle}>
                  Rejecting this request flips the row to REJECTED. The
                  user&apos;s factors are not changed. You may optionally
                  record a short reason for the audit log.
                </p>
                <label style={{ display: "block", marginTop: 12 }}>
                  <span style={{ display: "block", fontSize: 14 }}>
                    Reason (optional)
                  </span>
                  <input
                    type="text"
                    maxLength={400}
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    style={inputStyle}
                  />
                </label>
              </>
            )}
            <div
              style={{
                marginTop: 20,
                display: "flex",
                gap: 8,
                justifyContent: "flex-end",
              }}
            >
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPendingAction(null)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  if (pendingAction.kind === "approve") {
                    void doApprove(pendingAction.requestId);
                  } else {
                    void doReject(pendingAction.requestId, rejectReason);
                  }
                }}
                loading={busy}
                disabled={busy}
                data-cc-mfa-recovery-confirm
              >
                {busy
                  ? "Working…"
                  : pendingAction.kind === "approve"
                    ? "Confirm approve"
                    : "Confirm reject"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </PageShell>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", gap: 8, fontSize: 14, marginTop: 4 }}>
      <span style={{ minWidth: 140, color: "#64748b" }}>{label}</span>
      <span style={{ fontFamily: "ui-monospace, monospace" }}>{value}</span>
    </div>
  );
}

const mutedStyle: CSSProperties = { color: "#475569" };
const warnBoxStyle: CSSProperties = {
  border: "1px solid #fde68a",
  background: "#fffbeb",
  color: "#92400e",
  padding: "10px 14px",
  borderRadius: 8,
  marginTop: 8,
};
const linkButtonStyle: CSSProperties = {
  background: "none",
  border: "none",
  color: "#1d4ed8",
  cursor: "pointer",
  textDecoration: "underline",
  padding: 0,
  fontFamily: "ui-monospace, monospace",
};
const modalBackdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 50,
};
const modalStyle: CSSProperties = {
  background: "white",
  borderRadius: 8,
  padding: 24,
  maxWidth: 520,
  width: "90%",
  boxShadow: "0 10px 30px rgba(15, 23, 42, 0.25)",
};
const inputStyle: CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 14,
  marginTop: 4,
};

// PHASE R8.1.8 — styles for the new preferences + preview cards.
const sectionTitleStyle: CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  marginBottom: 8,
};
const listStyle: CSSProperties = {
  listStyle: "none",
  margin: "8px 0 0 0",
  padding: 0,
};
const rowStyle: CSSProperties = {
  display: "flex",
  gap: 12,
  alignItems: "center",
  padding: "8px 0",
  borderTop: "1px solid #f1f5f9",
};
// PHASE R8.1.8 — small row editor for the preferences card. Pure
// presentational; all state lives in the parent body component.
function DigestPreferenceRowEditor(props: {
  label: string;
  scopeTeamId: string | null;
  pref: {
    id: string;
    teamId: string | null;
    digestEnabled: boolean;
    suppressUntil: string | null;
    updatedAt: string;
  } | null;
  prefsBusy: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  onSnooze: () => void;
  onResume: () => void;
}) {
  const enabled = props.pref?.digestEnabled ?? true;
  const snoozedUntil = props.pref?.suppressUntil ?? null;
  const now = Date.now();
  const isSnoozed =
    Boolean(snoozedUntil) &&
    new Date(snoozedUntil as string).getTime() > now;
  return (
    <div
      style={rowStyle}
      data-cc-mfa-recovery-digest-preference-row
      data-cc-mfa-recovery-digest-preference-scope={
        props.scopeTeamId === null ? "global" : "team"
      }
      data-cc-mfa-recovery-digest-preference-snoozed={
        isSnoozed ? "true" : "false"
      }
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{props.label}</div>
        <div style={{ color: "#475569", fontSize: 13 }}>
          {enabled
            ? isSnoozed
              ? `Snoozed until ${formatUserDateTime(snoozedUntil)}`
              : "Digest emails enabled"
            : "Digest emails disabled"}
          {props.pref?.updatedAt ? (
            <span>
              {" "}· last updated {formatUserDateTime(props.pref.updatedAt)}
            </span>
          ) : null}
        </div>
      </div>
      <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={props.prefsBusy}
          onChange={(e) => props.onToggleEnabled(e.target.checked)}
        />
        <span style={{ fontSize: 13 }}>Enabled</span>
      </label>
      {isSnoozed ? (
        <Button
          variant="primary"
          size="sm"
          onClick={props.onResume}
          disabled={props.prefsBusy}
          data-cc-mfa-recovery-digest-preference-resume
        >
          Resume
        </Button>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          onClick={props.onSnooze}
          disabled={props.prefsBusy}
          data-cc-mfa-recovery-digest-preference-snooze
        >
          Snooze 7d
        </Button>
      )}
    </div>
  );
}
