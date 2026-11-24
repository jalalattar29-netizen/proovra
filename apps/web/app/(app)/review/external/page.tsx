"use client";

/**
 * PROOVRA Phase 2B Closure — External Review Management Console.
 *
 * Operator surface for the External Reviewer Portal. Replaces the
 * single-issue page with a tabbed console:
 *
 *   • Active / Pending / Accepted / Expired / Revoked tabs render
 *     grant lifecycle states filtered from the workspace-anchored
 *     listInvitationsForTeam projection.
 *   • "Invite reviewer" action (T-136) — one form for one or many
 *     recipients: multi-row paste (CSV or one-per-line), per-row validation
 *     (an invalid address blocks Issue, nothing is truncated), a validated
 *     expiry (T-155), per-row outcome table, summary chips. The tabs hold
 *     lifecycle statuses only.
 *   • Per-grant detail drawer:
 *       - Delivery status panel (most recent + history).
 *       - Activity timeline.
 *       - Resend, Revoke, Bulk Revoke.
 *       - SSO controls — auth method, ssoConnectionId, allowedDomains.
 *       - MFA required toggle (display only — change at issue time).
 *       - Watermark policy chip.
 *   • Token reveal is hidden behind an explicit break-glass toggle.
 *
 * The console is **NEVER** a second portal — it consumes the same
 * REST endpoints behind /v1/external-review/* added by Phase 2B
 * Closure and does NOT duplicate any grant/identity/audit storage.
 *
 * Workspace-anchored at the API boundary — every read includes the
 * caller's session, which the API resolves to a teamId.
 */

import { AppListbox } from "../../../../components/app-primitives/AppListbox";
import { reviewerDenialMessage } from "@proovra/shared";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  BULK_INVITATION_MAX_ROWS,
  EXTERNAL_REVIEWER_ROLES,
  EXTERNAL_REVIEW_EXPIRY_HOURS_MAX,
  EXTERNAL_REVIEW_EXPIRY_HOURS_MIN,
  WATERMARK_POLICIES,
  identifierLabel,
  parseExternalReviewExpiryHours,
  type ExternalReviewerRole,
  type PortalAuthMethod,
} from "@proovra/shared";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { CanonicalActionButton } from "../../../../components/external-review/CanonicalActionButton";
import "../../../../components/reviewer-experience/review-surfaces.css";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../components/identity-security/StepUpModal";
import { apiFetch } from "../../../../lib/api";
import {
  EXTERNAL_REVIEW_RENEW_DAYS,
  externalReviewRenewRefusal,
  renewExternalReviewGrant,
} from "../../../../lib/api/external-review-renew";
import { formatUserDate, formatUserDateTime } from "../../../../lib/date";
import { notifyApiError } from "../../../../lib/feedback/notify";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useConfirmAction } from "../../../../components/ui/ConfirmActionModal";
import { useToast, PageShell } from "../../../../components/ui";
// TEAM-UI-SPEC (structure) — the one review page header: icon title row, the
// tool name, a resolver-gated "← Review" back link (External review is also
// on Pro, where the review hub does not open), no eyebrow.
import { ReviewPageHeader } from "../../../../components/reviewer-experience/ReviewPageHeader";

import { EmptyState } from "../../../../components/ui/EmptyState";
import {
  bulkInvitationOutcomeLabel,
  invitationDeliveryProviderLabel,
} from "../../../../lib/labels/governanceReviewLabels";
import {
  useActiveSpace,
  useTeamId,
} from "../../../../lib/platform-context";
import { EXTERNAL_REVIEW_MANAGE_EXPLANATION } from "../../../../components/external-review/ExternalReviewSubjectPanel";

import {
  ReviewScopePicker,
  SCOPE_REQUIRED_REASON,
  defaultScopeFor,
  type ReviewScopeState,
} from "../../../../components/external-review/ReviewScopePicker";
import {
  bulkIssueBannerText,
  bulkOutcomeReason,
  tallyBulkOutcome,
  type BulkIssueTally,
} from "./_components/bulkInviteOutcome";

// ---------------------------------------------------------------------------
// PHASE 4 — Per-action capability gating.
//
// Phase 0 confirmed every admin button rendered unconditionally and
// every mutation catch collapsed 403 into the misleading "RATE_LIMITED"
// banner. The hook below derives the bounded gate set from the
// canonical platform-context envelope:
//
//   - REVIEWER_OPS_ACT — required for any external-review mutation
//     (Invite / Bulk Invite / Resend / Revoke / Bulk Revoke). The
//     PageRouteGate already requires REVIEWER_OPS_VIEW; ACT is the
//     reviewer-ops mutation cap on the canonical CapabilityMap.
//
//   - canRevealToken — manual token reveal is a stronger split-of-duty
//     gate: REVIEWER_OPS_ACT alone is NOT enough. We additionally
//     require the active space role to be OWNER (workspace owner has
//     break-glass authority). ADMIN/SUPERVISOR can see the button but
//     it stays disabled, with a tooltip explaining the split-of-duty.
//
// Buttons are NEVER hidden — disabled-with-explanation, per brief.
// The server is still the authority — a click that slips through
// (e.g. a stale envelope) is surfaced via the bounded NOT_PERMITTED
// banner rather than the legacy "RATE_LIMITED" collapse.
// ---------------------------------------------------------------------------

type ExternalReviewCapabilities = {
  canInvite: boolean;
  canBulkInvite: boolean;
  canBulkRevoke: boolean;
  canResend: boolean;
  canRevoke: boolean;
  canEndSessions: boolean;
  canRevealToken: boolean;
};

/**
 * TEAM-SPEC R4 (2026-11-23) — the console is reachable wherever the active
 * workspace's plan includes External Review (Pro, Team, Enterprise — personal
 * workspaces included), so its actions can no longer key on the reviewer-ops
 * capability (REVIEWER_OPS_ACT is a Team-tier capability a Pro owner lacks,
 * while the API accepts their issue/revoke). They follow the SAME answer the
 * record panel uses: the list's `viewerCanIssue` and each row's
 * `viewerCanRevoke`, projected by the API from the one predicate the
 * issue/revoke doors enforce (OWNER or ADMIN). An API that predates those
 * fields falls back to the active role from the envelope.
 *
 *   issue / bulk issue        viewerCanIssue
 *   revoke (row)              row.viewerCanRevoke
 *   bulk revoke / resend /
 *   end portal sessions       may manage (viewerCanIssue, or any row revocable)
 *   reveal token              may manage ∧ workspace OWNER (break-glass)
 *
 * No function on this page calls an Enterprise-only entitlement: every door
 * is gated by the External Review entitlement plus role (see the report of
 * TEAM-SPEC R4), so nothing here is individually hidden as Enterprise-only.
 */
function useExternalReviewCapabilities(
  listCanIssue: boolean | undefined,
  rows: ReadonlyArray<InvitationRow> | null,
): ExternalReviewCapabilities {
  const activeSpace = useActiveSpace();
  const role = activeSpace?.roleLabel ?? null;
  const roleAllowsManage = role === "Owner" || role === "OWNER" || role === "ADMIN";
  const rowAnswers = (rows ?? [])
    .map((r) => r.viewerCanRevoke)
    .filter((v): v is boolean => typeof v === "boolean");
  const projected = listCanIssue !== undefined || rowAnswers.length > 0;
  const canManage = projected
    ? listCanIssue === true || rowAnswers.some(Boolean)
    : roleAllowsManage;
  const canIssue = listCanIssue !== undefined ? listCanIssue : roleAllowsManage;
  // Reveal-token is split-of-duty: the workspace OWNER only (the caller's
  // own Personal Space reads "Owner"; an organization reads "OWNER").
  const isOwner =
    activeSpace?.roleLabel === "OWNER" ||
    (activeSpace?.type === "PERSONAL" && activeSpace.shared !== true && activeSpace.roleLabel === "Owner");
  return {
    canInvite: canIssue,
    canBulkInvite: canIssue,
    canBulkRevoke: canManage,
    canResend: canManage,
    canRevoke: canManage,
    // Same tier as revoke on the server (review.assign + administrative tier).
    canEndSessions: canManage,
    canRevealToken: canManage && isOwner,
  };
}

// Map the apiFetch error shape to a bounded denial string the UI
// surfaces. Phase 0 finding: the previous catch{} defaulted to
// "RATE_LIMITED" for every error, including 403 NOT_PERMITTED. We
// now distinguish NOT_PERMITTED + FORBIDDEN from rate-limit collapse.
function denialFromError(err: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any;
  const status = typeof e?.statusCode === "number" ? e.statusCode : 0;
  const code = typeof e?.code === "string" ? e.code : "";
  const denial = typeof e?.body?.denial === "string" ? e.body.denial : "";
  const details = e?.details;
  const detailsDenial =
    details && typeof details === "object" && typeof details.denial === "string"
      ? (details.denial as string)
      : "";
  if (denial) return denial;
  if (detailsDenial) return detailsDenial;
  if (status === 403 || code === "NOT_PERMITTED" || code === "FORBIDDEN") {
    return "NOT_PERMITTED";
  }
  if (code === "RATE_LIMITED" || status === 429) return "RATE_LIMITED";
  return code || "REFUSED";
}

// POST /v1/external-review/invitations/:id/sessions/revoke — ends every live
// portal session of the invitation (D2). The invitation itself stays valid.
async function endInvitationPortalSessions(
  grantId: string,
): Promise<{ ok?: boolean; sessionsEnded?: number } | null> {
  return apiFetch(`/v1/external-review/invitations/${grantId}/sessions/revoke`, {
    method: "POST",
    body: JSON.stringify({ reason: "OPERATOR_REVOKE" }),
  });
}

// Bounded copy for a refused "End sessions". Never the raw server string.
function endSessionsFailureText(err: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const status = typeof (err as any)?.statusCode === "number" ? (err as any).statusCode : 0;
  if (status === 403) {
    return "You do not have permission to end this reviewer's sessions. Nothing was changed.";
  }
  if (status === 404) {
    return "This invitation is no longer available in this workspace. Nothing was changed.";
  }
  if (status === 503) {
    return "Sessions could not be ended right now because the session service is unavailable. Nothing was changed; try again shortly.";
  }
  const safe = toSafeUserError(err, {
    title: "Could not end sessions",
    message: "The sessions could not be ended. Nothing was changed.",
  });
  return safe.message;
}

// ---------------------------------------------------------------------------
// Types — mirror /v1/external-review/invitations response shape
// ---------------------------------------------------------------------------

type LatestDelivery = {
  status: string;
  sentAtUtc: string | null;
  queuedAtUtc: string;
  failureReason: string | null;
  attempt: number;
};

type InvitationRow = {
  grantId: string;
  role: ExternalReviewerRole;
  organization: string | null;
  inviteEmail: string;
  mfaRequired: boolean;
  watermarkPolicy: string;
  inviteSentAtUtc: string;
  inviteAcceptedAtUtc: string | null;
  inviteResentAtUtc: string | null;
  activityCount: number;
  grantState: string | null;
  expiresAtUtc: string | null;
  expired: boolean;
  authMethod: PortalAuthMethod;
  ssoConnectionId: string | null;
  allowedDomains: string[];
  ssoSubjectHash: string | null;
  ssoNameId: string | null;
  ssoBoundAtUtc: string | null;
  mfaSatisfiedAtUtc: string | null;
  latestDelivery: LatestDelivery | null;
  /** EP-0450 — the API's answer: this viewer could renew this grant now. */
  viewerCanRenew?: boolean;
  /** TEAM-SPEC §2.11 — the API's answer: this viewer could revoke this grant now. */
  viewerCanRevoke?: boolean;
};

type ActivityRow = {
  id: string;
  code: string;
  sessionId: string | null;
  payload: unknown;
  occurredAtUtc: string;
  ip?: string | null;
};

type DeliveryRow = {
  id: string;
  status: string;
  provider: string;
  // Raw only for a caller who may reveal recipient contact; masked otherwise.
  recipientEmail: string | null;
  recipientEmailMasked: string | null;
  subject: string;
  attempt: number;
  queuedAtUtc: string;
  sentAtUtc: string | null;
  deliveredAtUtc: string | null;
  openedAtUtc: string | null;
  failedAtUtc: string | null;
  revokedAtUtc: string | null;
  expiredAtUtc: string | null;
  failureReason: string | null;
  bulkBatchId: string | null;
};

type BulkOutcomeRow = {
  inviteEmail: string;
  outcome: string;
  grantId: string | null;
  denial: string | null;
};

// T-136 — the tabs are lifecycle statuses only; inviting is an action.
type TabId =
  | "active"
  | "pending"
  | "accepted"
  | "expired"
  | "revoked";

const TAB_ORDER: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "active", label: "Active" },
  { id: "pending", label: "Pending" },
  { id: "accepted", label: "Accepted" },
  { id: "expired", label: "Expired" },
  { id: "revoked", label: "Revoked" },
];

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

export default function ExternalInvitationsPage() {
  return (
    <PageRouteGate routeId="workspace.review_external">
      <ExternalReviewManagementConsole />
    </PageRouteGate>
  );
}

function ExternalReviewManagementConsole() {
  const teamId = useTeamId();
  // Reuse the canonical step-up flow (same hook + modal as
  // admin/provisioning). Sensitive external-review mutations (bulk
  // issue, break-glass token reveal) run through `runStepUpAction` so a
  // 401 STEP_UP_REQUIRED response surfaces the modal and resumes the
  // original request once the challenge is verified. NEVER a parallel
  // step-up implementation.
  const stepUp = useStepUpAction({ teamId });
  const [rows, setRows] = useState<InvitationRow[] | null>(null);
  const [listDenied, setListDenied] = useState(false);
  /** The list's `viewerCanIssue`; undefined = not projected (older API). */
  const [listCanIssue, setListCanIssue] = useState<boolean | undefined>(undefined);
  const caps = useExternalReviewCapabilities(listCanIssue, rows);
  // T-114 (ARCH-15, stage E) — the console is READ-ONLY for a caller who may
  // neither issue nor manage (MEMBER): no inert controls, and a plain note says
  // why. T-136 (stage F) — inviting is an action, not a tab.
  const readOnly = !caps.canInvite && !caps.canBulkRevoke;
  const tabOrder = TAB_ORDER;
  const [tab, setTab] = useState<TabId>("active");
  // T-136 — the invite form is opened by the "Invite reviewer" action.
  const [inviting, setInviting] = useState(false);
  // T-158 — a failed list read is an error with Retry, never an empty tab.
  const [listError, setListError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [multiSelected, setMultiSelected] = useState<Set<string>>(new Set());
  const { confirm: confirmBulk } = useConfirmAction();
  const [banner, setBanner] = useState<{
    tone: "info" | "ok" | "warn";
    text: string;
  } | null>(null);

  // Resolves true only when the list was actually reread, so a caller can
  // tell a confirmed change apart from one it could not confirm.
  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const res = await apiFetch("/v1/external-review/invitations", {
        method: "GET",
      });
      setRows((res?.invitations ?? []) as InvitationRow[]);
      setListCanIssue(typeof res?.viewerCanIssue === "boolean" ? res.viewerCanIssue : undefined);
      setListDenied(false);
      setListError(false);
      return true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[external-review] invitations list refresh failed", {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        status: (err as any)?.statusCode ?? 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        code: (err as any)?.code ?? "UNKNOWN",
      });
      const denial = denialFromError(err);
      setListDenied(denial === "NOT_PERMITTED");
      // T-158 — the rows already shown stay; a first read that failed leaves
      // the list unknown (null), so no tab claims "No invitations".
      setListError(denial !== "NOT_PERMITTED");
      setRows((prev) => (denial === "NOT_PERMITTED" ? [] : prev));
      return false;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(
    () => (rows ? filterRowsForTab(rows, tab) : []),
    [rows, tab],
  );

  const counts = useMemo(() => deriveCounts(rows ?? []), [rows]);

  const selectedRow =
    selected !== null
      ? (rows ?? []).find((r) => r.grantId === selected) ?? null
      : null;

  const onToggleMulti = useCallback((grantId: string) => {
    setMultiSelected((prev) => {
      const next = new Set(prev);
      if (next.has(grantId)) next.delete(grantId);
      else next.add(grantId);
      return next;
    });
  }, []);

  const onBulkRevoke = useCallback(async () => {
    if (!caps.canBulkRevoke) {
      setBanner({
        tone: "warn",
        text: "Your role does not allow revoking access in bulk.",
      });
      return;
    }
    const ids = Array.from(multiSelected);
    if (ids.length === 0) return;
    if (ids.length > BULK_INVITATION_MAX_ROWS) {
      setBanner({
        tone: "warn",
        text: `Bulk revoke is bounded to ${BULK_INVITATION_MAX_ROWS} per call.`,
      });
      return;
    }
    // PRO-R2Z-07 — ending outside reviewers' access asks first, with the count.
    const ok = await confirmBulk({
      title: `Revoke ${ids.length} invitation${ids.length === 1 ? "" : "s"}?`,
      description: "Each reviewer's access ends immediately. A revoked invitation cannot be restored; you would issue a new one.",
      confirmLabel: "Revoke access",
      tone: "danger",
    });
    if (!ok) return;
    try {
      const res = await apiFetch(
        "/v1/external-review/invitations/bulk/revoke",
        {
          method: "POST",
          body: JSON.stringify({ grantIds: ids, reason: "Operator bulk revoke" }),
        },
      );
      // PV-DEFECT-002 — every row reports its own outcome. An id that no
      // longer answers in this workspace is decided before any write and
      // named here, instead of failing the whole batch as a server error.
      const rows = (res?.rows as Array<{ outcome: string }> | undefined) ?? [];
      const count = (outcome: string) => rows.filter((r) => r.outcome === outcome).length;
      const revokedCount = count("REVOKED");
      const already = count("ALREADY_REVOKED");
      const missing = count("NOT_FOUND");
      const failed = count("FAILED");
      const parts = [`Revoked ${revokedCount} of ${ids.length} invitations.`];
      if (already > 0) parts.push(`${already} were already revoked.`);
      if (missing > 0) {
        parts.push(`${missing} no longer exist in this workspace — refresh the list.`);
      }
      if (failed > 0) parts.push(`${failed} could not be revoked; try them again.`);
      setBanner({
        tone: missing > 0 || failed > 0 ? "warn" : "ok",
        text: parts.join(" "),
      });
      setMultiSelected(new Set());
      await refresh();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[external-review] bulk revoke failed", {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        status: (err as any)?.statusCode ?? 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        code: (err as any)?.code ?? "UNKNOWN",
      });
      const denial = denialFromError(err);
      setBanner({ tone: "warn", text: `Access was not revoked. ${reviewerDenialMessage(denial)}` });
    }
  }, [caps.canBulkRevoke, multiSelected, refresh, confirmBulk]);

  const selectTab = useCallback((id: TabId) => {
    setTab(id);
    setInviting(false);
    setSelected(null);
    // PRO-R2Z-07 — a bulk action applies to the rows you can see.
    setMultiSelected(new Set());
  }, []);

  return (
    <PageShell
      data-external-review-console
      header={
        <ReviewPageHeader
          backToHub
          title="External review"
          subtitle="External reviewer invitations, delivery and audit for this workspace — included on Pro, Team and Enterprise. Every action you take here is recorded on the grant's audit timeline."
          primaryAction={
            // T-136 — one entry point for one or many invitations. While the
            // form is open its Issue is the one primary.
            inviting || readOnly ? null : (
              <button
                type="button"
                className="app-primary-action"
                data-invite-reviewer-action
                data-capability-allowed={caps.canBulkInvite ? "true" : "false"}
                disabled={!caps.canBulkInvite}
                title={caps.canBulkInvite ? undefined : EXTERNAL_REVIEW_MANAGE_EXPLANATION}
                onClick={() => {
                  setSelected(null);
                  setInviting(true);
                }}
              >
                Invite reviewer
              </button>
            )
          }
          secondaryActions={
            // TEAM-UI-SPEC §1 — revoking is irreversible: a `--danger` entry
            // point that opens the danger confirm, never a filled red button.
            // Bulk revoke applies to the rows of a lifecycle tab, so it is not
            // offered while the invite form is open (whose one primary is Issue).
            inviting || readOnly ? null : (
            <button
              type="button"
              className="app-secondary-action app-secondary-action--danger"
              data-bulk-revoke-action
              data-capability-allowed={caps.canBulkRevoke ? "true" : "false"}
              onClick={onBulkRevoke}
              disabled={!caps.canBulkRevoke || multiSelected.size === 0}
              title={
                !caps.canBulkRevoke
                  ? "You do not have permission to bulk revoke invitations"
                  : multiSelected.size === 0
                  ? "Select at least one row to bulk revoke"
                  : undefined
              }
            >
              Bulk revoke ({multiSelected.size})
            </button>
            )
          }
        />
      }
    >
      {/* TEAM-UI-SPEC §1 — the canonical `app-tabs` strip with tablist
          semantics. `.app-tabs` already scrolls (overflow-x: auto,
          max-width: 100%), so the last tab stays reachable on a 390 px phone
          (review-layout gate, 2026-11-23). */}
      <nav
        data-console-tabs
        className="app-tabs"
        role="tablist"
        aria-label="Invitation lifecycle"
        style={{ overflowX: "auto", maxWidth: "100%" }}
      >
        {tabOrder.map((t, idx) => (
          <button
            type="button"
            key={t.id}
            id={`external-review-tab-${t.id}`}
            role="tab"
            aria-selected={!inviting && tab === t.id}
            aria-controls="external-review-tabpanel"
            tabIndex={tab === t.id ? 0 : -1}
            className={!inviting && tab === t.id ? "app-tab is-active" : "app-tab"}
            data-tab={t.id}
            data-tab-active={!inviting && tab === t.id ? "true" : "false"}
            onClick={() => selectTab(t.id)}
            onKeyDown={(event) => {
              let next: number | null = null;
              if (event.key === "ArrowRight") next = (idx + 1) % tabOrder.length;
              else if (event.key === "ArrowLeft") next = (idx - 1 + tabOrder.length) % tabOrder.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = tabOrder.length - 1;
              if (next === null) return;
              event.preventDefault();
              const target = tabOrder[next]!;
              selectTab(target.id);
              document.getElementById(`external-review-tab-${target.id}`)?.focus();
            }}
          >
            {t.label}
            {rows !== null ? (
              <span data-tab-count={t.id} className="app-tab__count">
                {counts[t.id] ?? 0}
              </span>
            ) : null}
          </button>
        ))}
      </nav>

      {readOnly && !listDenied ? (
        <section
          data-external-review-read-only
          className="app-panel"
          role="note"
        >
          <p className="app-panel__body" style={{ margin: 0 }}>
            Read-only. You can see this workspace's external reviewer
            invitations and their activity. {EXTERNAL_REVIEW_MANAGE_EXPLANATION}
          </p>
        </section>
      ) : null}

      {listDenied ? (
        <section
          data-external-review-list-denied
          className="app-panel"
          role="alert"
        >
          <p className="app-panel__body" style={{ margin: 0 }}>
          You do not have permission to view external reviewer
          invitations. Ask a workspace administrator or supervisor.
          </p>
        </section>
      ) : null}

      {listError ? (
        <section data-external-review-list-error className="app-panel" role="alert">
          <p className="app-panel__body app-field-error" style={{ margin: 0 }}>
            {rows === null
              ? "The invitations could not be loaded."
              : "The invitations could not be refreshed; the list below may be out of date."}{" "}
            <button
              type="button"
              className="app-secondary-action"
              data-external-review-list-retry
              onClick={() => void refresh()}
            >
              Retry
            </button>
          </p>
        </section>
      ) : null}

      {banner ? (
        <section
          data-console-banner
          data-console-banner-tone={banner.tone}
          role="status"
          className="app-panel"
        >
          <p
            className={banner.tone === "warn" ? "app-panel__body app-field-error" : "app-panel__body"}
            style={{ margin: 0 }}
          >
            {banner.text}
          </p>
        </section>
      ) : null}

      <div
        id="external-review-tabpanel"
        role="tabpanel"
        aria-labelledby={`external-review-tab-${tab}`}
        style={{ minWidth: 0 }}
      >
      {inviting ? (
        <BulkInvitePanel
          caps={caps}
          teamId={teamId}
          stepUp={stepUp}
          onCancel={() => setInviting(false)}
          onCompleted={async (tally) => {
            // Reread the invitation list first; the banner counts only the
            // rows that were actually issued. Stay on this tab whenever a
            // row was not issued, so its reason stays on screen.
            const reloaded = await refresh();
            const clean =
              tally.issued > 0 && tally.issued === tally.total && reloaded;
            setBanner({
              tone: clean ? "ok" : "warn",
              text: bulkIssueBannerText(tally, reloaded),
            });
            if (clean) {
              setInviting(false);
              setTab("active");
            }
          }}
        />
      ) : (
        // TEAM-UI-SPEC §4 — list + drawer side by side on desktop;
        // external-review.css stacks them at ≤ 1100 px.
        <div
          className={selected ? "external-review-split has-drawer" : "external-review-split"}
        >
          {rows === null && listError ? null : (
          <InvitationsTable
            rows={filtered}
            selectable={!readOnly}
            multiSelected={multiSelected}
            onSelect={(id) => setSelected(id)}
            onToggleMulti={onToggleMulti}
            selectedId={selected}
          />
          )}
          {selectedRow ? (
            <InvitationDetailDrawer
              row={selectedRow}
              caps={
                // The row's own answer decides its Revoke (never a live
                // control the API would refuse); older API → the page tier.
                typeof selectedRow.viewerCanRevoke === "boolean"
                  ? { ...caps, canRevoke: selectedRow.viewerCanRevoke }
                  : caps
              }
              stepUp={stepUp}
              teamId={teamId}
              readOnly={readOnly}
              onClose={() => setSelected(null)}
              onChanged={(text) => {
                setBanner({ tone: "ok", text });
                void refresh();
              }}
              onRefuse={(text) =>
                setBanner({ tone: "warn", text: `Refused: ${text}` })
              }
              onReread={refresh}
              onNotice={(tone, text) => setBanner({ tone, text })}
            />
          ) : null}
        </div>
      )}
      </div>

      {/* Single centrally-hosted step-up modal — drives the challenge
          flow for bulk issue + break-glass reveal. */}
      <StepUpModal control={stepUp} />
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// Tab filtering
// ---------------------------------------------------------------------------

function filterRowsForTab(rows: InvitationRow[], tab: TabId): InvitationRow[] {
  switch (tab) {
    case "active":
      return rows.filter(
        (r) =>
          r.grantState !== "REVOKED" &&
          !r.expired &&
          r.inviteAcceptedAtUtc !== null,
      );
    case "pending":
      return rows.filter(
        (r) =>
          r.grantState !== "REVOKED" &&
          !r.expired &&
          r.inviteAcceptedAtUtc === null,
      );
    case "accepted":
      return rows.filter((r) => r.inviteAcceptedAtUtc !== null);
    case "expired":
      return rows.filter((r) => r.expired && r.grantState !== "REVOKED");
    case "revoked":
      return rows.filter((r) => r.grantState === "REVOKED");
  }
}

function deriveCounts(rows: InvitationRow[]): Record<TabId, number> {
  return {
    active: filterRowsForTab(rows, "active").length,
    pending: filterRowsForTab(rows, "pending").length,
    accepted: filterRowsForTab(rows, "accepted").length,
    expired: filterRowsForTab(rows, "expired").length,
    revoked: filterRowsForTab(rows, "revoked").length,
  };
}

// ---------------------------------------------------------------------------
// Invitations table
// ---------------------------------------------------------------------------

function InvitationsTable({
  rows,
  selectable = true,
  multiSelected,
  selectedId,
  onSelect,
  onToggleMulti,
}: {
  rows: InvitationRow[];
  /** T-114 — false for a read-only caller: no bulk-selection column. */
  selectable?: boolean;
  multiSelected: Set<string>;
  selectedId: string | null;
  onSelect: (grantId: string) => void;
  onToggleMulti: (grantId: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <section data-invitations-empty>
        <EmptyState
          framed
          title="No invitations match this tab"
          purpose="External reviewer invitations in this lifecycle state will appear here."
        />
      </section>
    );
  }
  return (
    // TEAM-UI-SPEC §4 — ten columns: the shared responsive cutover
    // (`.app-table[data-responsive]`) turns each invitation into a labelled
    // card at ≤ 720 px, so nothing is clipped at 320/390 px.
    <section
      data-invitations-table-wrap
      className="app-table-surface app-table-surface--scroll"
    >
      <table data-invitations-table className="app-table" data-responsive="">
        <thead>
          <tr>
            {selectable ? (
              <th scope="col"><span className="app-visually-hidden">Select</span></th>
            ) : null}
            <th scope="col">Email</th>
            <th scope="col">Role</th>
            <th scope="col">Auth</th>
            <th scope="col">MFA</th>
            <th scope="col">Watermark</th>
            <th scope="col">Delivery</th>
            <th scope="col">Sent</th>
            <th scope="col">Expires</th>
            <th scope="col">Activity</th>
            <th scope="col"><span className="app-visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isSelected = selectedId === r.grantId;
            return (
              <tr
                key={r.grantId}
                data-invitation-row={r.grantId}
                data-row-selected={isSelected ? "true" : "false"}
                aria-selected={isSelected}
                className={isSelected ? "is-selected" : undefined}
                onClick={() => onSelect(r.grantId)}
                style={{ cursor: "pointer" }}
              >
                {selectable ? (
                  <td data-label="Select" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      data-row-multi={r.grantId}
                      aria-label={`Select ${r.inviteEmail}`}
                      checked={multiSelected.has(r.grantId)}
                      onChange={() => onToggleMulti(r.grantId)}
                    />
                  </td>
                ) : null}
                <td data-label="Email" style={{ overflowWrap: "anywhere" }}>
                  <span className="app-table__primary">{r.inviteEmail}</span>
                </td>
                <td data-label="Role">
                  {identifierLabel(r.role)}
                </td>
                <td data-label="Auth">
                  <Chip
                    data-auth-chip={r.authMethod}
                    tone={r.authMethod === "SSO" ? "info" : "muted"}
                    label={r.authMethod}
                  />
                </td>
                <td data-label="MFA">{r.mfaRequired ? "Yes" : "No"}</td>
                <td data-label="Watermark">{r.watermarkPolicy}</td>
                <td data-label="Delivery">
                  {r.latestDelivery ? (
                    <Chip
                      data-delivery-chip={r.latestDelivery.status}
                      tone={deliveryTone(r.latestDelivery.status)}
                      label={identifierLabel(r.latestDelivery.status)}
                    />
                  ) : (
                    <span className="app-table__muted">—</span>
                  )}
                </td>
                <td data-label="Sent">
                  {formatUserDate(r.inviteSentAtUtc)}
                </td>
                <td data-label="Expires">
                  {r.expiresAtUtc
                    ? formatUserDate(r.expiresAtUtc)
                    : "—"}
                </td>
                <td data-label="Activity">{r.activityCount}</td>
                <td data-label="" onClick={(e) => e.stopPropagation()}>
                  {/* TEAM-UI-SPEC §4 — the row's navigation as a real,
                      keyboard-reachable ghost action (the row click stays
                      as a pointer shortcut). */}
                  <button
                    type="button"
                    className="app-ghost-action"
                    data-invitation-open={r.grantId}
                    aria-label={`Open ${r.inviteEmail}`}
                    aria-expanded={isSelected}
                    onClick={() => onSelect(r.grantId)}
                  >
                    Open
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------

function InvitationDetailDrawer({
  row,
  caps,
  stepUp,
  teamId,
  readOnly = false,
  onClose,
  onChanged,
  onRefuse,
  onReread,
  onNotice,
}: {
  row: InvitationRow;
  caps: ExternalReviewCapabilities;
  stepUp: ReturnType<typeof useStepUpAction>;
  /** EP-0450 — the workspace the renew route is asked in. */
  teamId: string | null;
  /** T-114 — a read-only caller sees the record, never manage controls. */
  readOnly?: boolean;
  onClose: () => void;
  onChanged: (msg: string) => void;
  onRefuse: (msg: string) => void;
  onReread: () => Promise<boolean>;
  onNotice: (tone: "ok" | "warn", text: string) => void;
}) {
  // T-158 — "error" is a failed read (shown with Retry), never "nothing yet".
  const [activity, setActivity] = useState<ActivityRow[] | null | "error">(null);
  // PRO-R1-02 — the reviewer's verdicts, rationale and comments on this
  // invitation. "unavailable" when the API predates the feedback read.
  const [feedback, setFeedback] = useState<
    | {
        decisions: Array<{ id: string; verdict: string; rationale: string | null; submittedAtUtc: string }>;
        comments: Array<{ id: string; body: string; authorDisplay: string | null; createdAt: string; parentCommentId: string | null }>;
      }
    | "unavailable"
    | null
  >(null);
  const [deliveries, setDeliveries] = useState<DeliveryRow[] | null | "error">(null);
  const [drawerReload, setDrawerReload] = useState(0);
  const [revealed, setRevealed] = useState<{
    rawToken: string;
    issuedFor: "operator-break-glass";
  } | null>(null);
  const [confirmReveal, setConfirmReveal] = useState(false);
  const { confirm: confirmAction } = useConfirmAction();
  const [endingSessions, setEndingSessions] = useState(false);

  // Resolves true only when the activity trail was actually reread.
  const loadActivity = useCallback(async (): Promise<boolean> => {
    try {
      const a = await apiFetch(
        `/v1/external-review/invitations/${row.grantId}/activity`,
        { method: "GET" },
      );
      setActivity((a?.activity ?? []) as ActivityRow[]);
      return true;
    } catch {
      setActivity("error");
      return false;
    }
  }, [row.grantId]);

  useEffect(() => {
    void (async () => {
      await loadActivity();
      try {
        const f = await apiFetch(`/v1/external-review/invitations/${row.grantId}/feedback`, { method: "GET" });
        setFeedback({
          decisions: Array.isArray(f?.decisions) ? f.decisions : [],
          comments: Array.isArray(f?.comments) ? f.comments : [],
        });
      } catch {
        setFeedback("unavailable");
      }
      try {
        const d = await apiFetch(
          `/v1/external-review/invitations/${row.grantId}/delivery`,
          { method: "GET" },
        );
        setDeliveries((d?.deliveries ?? []) as DeliveryRow[]);
      } catch {
        setDeliveries("error");
      }
    })();
  }, [row.grantId, loadActivity, drawerReload]);

  // T-157 — a revoked or expired invitation cannot be resent or revoked; the
  // reason is stated beside the disabled controls (Renew stays for expiry).
  const lifecycleBlock: string | null =
    row.grantState === "REVOKED"
      ? "This invitation was revoked. Issue a new invitation to give this reviewer access again."
      : row.expired
        ? "This invitation has expired. Renew access to extend it, or issue a new invitation."
        : null;
  const retryDrawer = () => {
    setActivity(null);
    setDeliveries(null);
    setFeedback(null);
    setDrawerReload((n) => n + 1);
  };

  // Ends every live portal session of this invitation. The invitation stays
  // valid: the reviewer can sign in again with their link. Success is
  // announced only after the activity trail and the list were reread.
  const onEndSessions = useCallback(async () => {
    if (!caps.canEndSessions) {
      onRefuse("NOT_PERMITTED");
      return;
    }
    const confirmed = await confirmAction({
      title: `End ${row.inviteEmail}'s portal sessions?`,
      description:
        "Every signed-in portal session for this invitation stops working " +
        "immediately. The invitation stays valid, so the reviewer can sign " +
        "in again with their link. To withdraw access altogether, revoke " +
        "the invitation instead.",
      confirmLabel: "End sessions",
      tone: "danger",
    });
    if (!confirmed) return;
    setEndingSessions(true);
    try {
      let ended: number;
      try {
        const res = await endInvitationPortalSessions(row.grantId);
        ended = typeof res?.sessionsEnded === "number" ? res.sessionsEnded : 0;
      } catch (err) {
        onNotice("warn", endSessionsFailureText(err));
        return;
      }
      const activityReread = await loadActivity();
      const listReread = await onReread();
      if (!activityReread || !listReread) {
        onNotice(
          "warn",
          "The request to end the sessions was accepted, but this invitation " +
            "could not be reloaded to confirm it. Refresh the page to check.",
        );
        return;
      }
      onNotice(
        "ok",
        ended === 0
          ? `${row.inviteEmail} had no signed-in portal sessions. Nothing else changed.`
          : `Ended ${ended} portal ${ended === 1 ? "session" : "sessions"} for ${row.inviteEmail}. The invitation is still valid.`,
      );
    } finally {
      setEndingSessions(false);
    }
  }, [caps.canEndSessions, confirmAction, row.grantId, row.inviteEmail, loadActivity, onReread, onRefuse, onNotice]);

  const onResend = useCallback(async () => {
    if (!caps.canResend) {
      onRefuse("NOT_PERMITTED");
      return;
    }
    try {
      await apiFetch(
        `/v1/external-review/invitations/${row.grantId}/resend`,
        { method: "POST", body: "{}" },
      );
      onChanged(`Resent invitation email for ${row.inviteEmail}.`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[external-review] resend invitation failed", {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        status: (err as any)?.statusCode ?? 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        code: (err as any)?.code ?? "UNKNOWN",
      });
      onRefuse(denialFromError(err));
    }
  }, [caps.canResend, row.grantId, row.inviteEmail, onChanged, onRefuse]);

  // EP-0450 — the explicit, audited renewal: offered only where the list
  // projects viewerCanRenew for this row; confirmed, stepped-up, refusals said.
  const onRenew = useCallback(async () => {
    if (!teamId || row.viewerCanRenew !== true) return;
    const ok = await confirmAction({
      title: `Renew access for ${EXTERNAL_REVIEW_RENEW_DAYS} days?`,
      description: `${row.inviteEmail} keeps access, which now ends ${EXTERNAL_REVIEW_RENEW_DAYS} days from today. The renewal is recorded in the workspace audit log.`,
      confirmLabel: `Renew for ${EXTERNAL_REVIEW_RENEW_DAYS} days`,
    });
    if (!ok) return;
    try {
      await stepUp.runStepUpAction((headers) => renewExternalReviewGrant(teamId, row.grantId, headers));
      onChanged(`Renewed access for ${row.inviteEmail} for ${EXTERNAL_REVIEW_RENEW_DAYS} days.`);
    } catch (err) {
      if ((err as { code?: string } | null)?.code === "STEP_UP_CANCEL") return;
      onNotice("warn", externalReviewRenewRefusal(err));
    }
  }, [teamId, row.viewerCanRenew, row.inviteEmail, row.grantId, confirmAction, stepUp, onChanged, onNotice]);

  const onRevoke = useCallback(async () => {
    if (!caps.canRevoke) {
      onRefuse("NOT_PERMITTED");
      return;
    }
    // PRO-R2Z-07 — revoke asks first, as "End sessions" does.
    const ok = await confirmAction({
      title: "Revoke this invitation?",
      description: `${row.inviteEmail}'s access ends immediately. A revoked invitation cannot be restored; you would issue a new one.`,
      confirmLabel: "Revoke access",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await apiFetch(
        `/v1/external-review/invitations/${row.grantId}/revoke`,
        { method: "POST", body: "{}" },
      );
      onChanged(`Revoked invitation ${row.grantId.slice(0, 8)}…`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[external-review] revoke invitation failed", {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        status: (err as any)?.statusCode ?? 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        code: (err as any)?.code ?? "UNKNOWN",
      });
      onRefuse(denialFromError(err));
    }
  }, [caps.canRevoke, row.grantId, row.inviteEmail, onChanged, onRefuse, confirmAction]);

  return (
    <aside
      data-invitation-detail-drawer
      data-grant-id={row.grantId}
      className="app-panel"
      aria-label={`Invitation for ${row.inviteEmail}`}
      style={{
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h2 className="app-panel__title" style={{ flex: "1 1 160px", minWidth: 0, overflowWrap: "anywhere" }}>
          {row.inviteEmail}
        </h2>
        <button
          type="button"
          data-drawer-close
          className="app-ghost-action"
          onClick={onClose}
        >
          Close
        </button>
      </div>

      <div style={chipsRowStyle}>
        <Chip
          tone={row.grantState === "REVOKED" ? "warn" : row.expired ? "warn" : "ok"}
          label={`State: ${row.grantState ?? "—"}`}
        />
        <Chip tone="muted" label={`Role: ${identifierLabel(row.role)}`} />
        <Chip tone="info" label={`Auth: ${row.authMethod}`} />
        {row.mfaRequired ? <Chip tone="warn" label="MFA required" /> : null}
        <Chip tone="muted" label={`Watermark: ${row.watermarkPolicy}`} />
        {row.expiresAtUtc ? (
          <Chip
            tone={row.expired ? "warn" : "muted"}
            label={`Expires ${formatUserDateTime(row.expiresAtUtc)}`}
          />
        ) : null}
        {row.ssoConnectionId ? (
          <Chip
            tone="info"
            label={`SSO bound: ${row.ssoConnectionId.slice(0, 8)}…`}
          />
        ) : null}
        {row.ssoSubjectHash ? (
          <Chip
            tone="ok"
            label={`SSO subject pinned`}
          />
        ) : null}
      </div>

      {/* TEAM-UI-SPEC §1 — Resend and Renew are ordinary (secondary);
          Revoke and End sessions are irreversible, so each is a `--danger`
          entry point that opens a danger confirm. No primary here.
          T-114 — none of it (nor the break-glass reveal) renders for a
          read-only caller; the page note says why. */}
      {readOnly ? null : (<>
      <section
        data-drawer-actions
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          className="app-secondary-action"
          data-invitation-resend={row.grantId}
          data-capability-allowed={caps.canResend ? "true" : "false"}
          onClick={onResend}
          disabled={!caps.canResend || lifecycleBlock !== null}
          aria-describedby={lifecycleBlock ? `invitation-lifecycle-reason-${row.grantId}` : undefined}
          title={
            !caps.canResend
              ? "You do not have permission to resend invitations"
              : undefined
          }
        >
          Resend invitation email
        </button>
        {row.viewerCanRenew === true ? (
          <button
            type="button"
            className="app-secondary-action"
            data-invitation-renew={row.grantId}
            onClick={() => void onRenew()}
          >
            Renew access
          </button>
        ) : null}
        <button
          type="button"
          className="app-secondary-action app-secondary-action--danger"
          data-invitation-revoke={row.grantId}
          data-capability-allowed={caps.canRevoke ? "true" : "false"}
          onClick={onRevoke}
          disabled={!caps.canRevoke || lifecycleBlock !== null}
          aria-describedby={lifecycleBlock ? `invitation-lifecycle-reason-${row.grantId}` : undefined}
          title={
            !caps.canRevoke
              ? "You do not have permission to revoke invitations"
              : undefined
          }
        >
          Revoke
        </button>
        <button
          type="button"
          className="app-secondary-action app-secondary-action--danger"
          data-invitation-end-sessions={row.grantId}
          data-capability-allowed={caps.canEndSessions ? "true" : "false"}
          onClick={onEndSessions}
          disabled={!caps.canEndSessions || endingSessions}
          aria-busy={endingSessions || undefined}
          aria-describedby={
            caps.canEndSessions ? undefined : `end-sessions-reason-${row.grantId}`
          }
        >
          {endingSessions ? "Ending sessions…" : "End sessions"}
        </button>
        {lifecycleBlock ? (
          <p
            id={`invitation-lifecycle-reason-${row.grantId}`}
            data-invitation-lifecycle-reason
            className="app-field-help"
            style={{ margin: 0, flexBasis: "100%" }}
          >
            {lifecycleBlock}
          </p>
        ) : null}
        {!caps.canEndSessions ? (
          <p
            id={`end-sessions-reason-${row.grantId}`}
            data-end-sessions-disabled-reason
            className="app-field-help"
            style={{ margin: 0, flexBasis: "100%" }}
          >
            Only workspace administrators and supervisors can end a
            reviewer&apos;s portal sessions.
          </p>
        ) : null}
      </section>

      <section
        data-drawer-break-glass
        className="app-panel"
        style={{ padding: 12, display: "grid", gap: 6 }}
      >
        <h3 className="app-panel__title">
          Break-glass: manual token reveal
        </h3>
        <p className="app-field-help" style={{ margin: 0 }}>
          Manual token reveal is for fallback only — the normal
          enterprise flow is the invitation email + optional SSO. Use
          this only when the recipient cannot receive the email.
        </p>
        {!revealed && !confirmReveal ? (
          // TEAM-UI-SPEC §1 — revealing rotates the grant token (the old
          // link stops working): a `--danger` entry to a danger confirm.
          <button
            type="button"
            className="app-secondary-action app-secondary-action--danger"
            style={{ justifySelf: "start" }}
            data-break-glass-arm
            data-capability-allowed={caps.canRevealToken ? "true" : "false"}
            onClick={() => {
              if (!caps.canRevealToken) return;
              setConfirmReveal(true);
            }}
            disabled={!caps.canRevealToken}
            title={
              caps.canRevealToken
                ? undefined
                : "You do not have permission to reveal raw invitation tokens. Token reveal is restricted to the workspace OWNER as a split-of-duty control — workspace ADMIN and SUPERVISOR cannot perform it."
            }
          >
            Enable token reveal
          </button>
        ) : null}
        {confirmReveal && !revealed && caps.canRevealToken ? (
          <BreakGlassReveal
            grantId={row.grantId}
            stepUp={stepUp}
            onCancel={() => setConfirmReveal(false)}
            onRevealed={(rawToken) => {
              setRevealed({
                rawToken,
                issuedFor: "operator-break-glass",
              });
              setConfirmReveal(false);
            }}
          />
        ) : null}
        {revealed ? (
          <div style={{ display: "grid", gap: 6 }}>
            <label className="app-field-label" htmlFor={`break-glass-token-${row.grantId}`}>
              Raw token (shown ONCE)
            </label>
            <textarea
              id={`break-glass-token-${row.grantId}`}
              data-break-glass-token
              readOnly
              rows={2}
              value={revealed.rawToken}
              className="app-input"
              style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
            />
            <button
              type="button"
              className="app-secondary-action"
              style={{ justifySelf: "start" }}
              data-break-glass-clear
              onClick={() => setRevealed(null)}
            >
              I have copied the token
            </button>
          </div>
        ) : null}
      </section>
      </>)}

      <section
        data-drawer-delivery-panel
        className="app-panel"
        style={panelStyle}
      >
        <h3 className="app-panel__title">Delivery status</h3>
        {deliveries === null ? (
          <p role="status" className="app-field-help" style={{ margin: 0 }}>Loading…</p>
        ) : deliveries === "error" ? (
          <p role="alert" data-drawer-delivery-error className="app-field-error" style={{ margin: 0 }}>
            Delivery status could not be loaded.{" "}
            <button type="button" className="app-secondary-action" data-drawer-retry onClick={retryDrawer}>
              Retry
            </button>
          </p>
        ) : deliveries.length === 0 ? (
          <p className="app-field-help" style={{ margin: 0 }}>No invitation emails have been sent yet.</p>
        ) : (
          <div className="app-table-surface--scroll">
          <table data-deliveries-table className="app-table" data-responsive="">
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Attempt</th>
                <th scope="col">Provider</th>
                <th scope="col">Queued</th>
                <th scope="col">Sent</th>
                <th scope="col">Failure</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.id} data-delivery-row={d.id}>
                  <td data-label="Status">
                    <Chip
                      data-delivery-status={d.status}
                      tone={deliveryTone(d.status)}
                      label={identifierLabel(d.status)}
                    />
                  </td>
                  <td data-label="Attempt">{d.attempt}</td>
                  <td data-label="Provider">
                    {invitationDeliveryProviderLabel(d.provider)}{" "}
                    <code data-identifier>{d.provider}</code>
                  </td>
                  <td data-label="Queued">
                    {formatUserDateTime(d.queuedAtUtc)}
                  </td>
                  <td data-label="Sent">
                    {d.sentAtUtc
                      ? formatUserDateTime(d.sentAtUtc)
                      : "—"}
                  </td>
                  <td data-label="Failure">
                    {d.failureReason ? (
                      <code className="app-field-error" style={{ margin: 0 }}>
                        {d.failureReason}
                      </code>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>

      <section
        data-drawer-sso-panel
        className="app-panel"
        style={panelStyle}
      >
        <h3 className="app-panel__title">SSO federation</h3>
        <div style={{ overflowWrap: "anywhere" }}>
          <p style={{ margin: 0, marginBottom: 4 }}>
            Auth method: <code data-sso-auth-method>{row.authMethod}</code>
          </p>
          <p style={{ margin: 0, marginBottom: 4 }}>
            SSO connection:{" "}
            <code data-sso-connection-id>
              {row.ssoConnectionId ?? "(none)"}
            </code>
          </p>
          <p style={{ margin: 0, marginBottom: 4 }}>
            Allowed domains:{" "}
            {row.allowedDomains.length === 0 ? (
              <span className="app-table__muted">(exact email match required)</span>
            ) : (
              <span data-sso-allowed-domains>
                {row.allowedDomains.map((d) => (
                  <Chip key={d} tone="info" label={d} />
                ))}
              </span>
            )}
          </p>
          {row.ssoBoundAtUtc ? (
            <p style={{ margin: 0, marginBottom: 4 }}>
              SSO bound at:{" "}
              <span data-sso-bound-at>
                {formatUserDateTime(row.ssoBoundAtUtc)}
              </span>
            </p>
          ) : null}
          {row.ssoSubjectHash ? (
            <p style={{ margin: 0 }}>
              Subject hash pinned ({row.ssoSubjectHash.slice(0, 8)}…). Any
              future SSO assertion with a different nameId will be
              refused.
            </p>
          ) : null}
        </div>
      </section>

      <section data-drawer-feedback-panel className="app-panel" style={panelStyle}>
        <h3 className="app-panel__title">Reviewer feedback</h3>
        {feedback === null ? (
          <p role="status" className="app-field-help" style={{ margin: 0 }}>Loading…</p>
        ) : feedback === "unavailable" ? (
          <p role="alert" className="app-field-error" style={{ margin: 0 }}>
            Reviewer feedback could not be loaded.{" "}
            <button type="button" className="app-secondary-action" data-drawer-retry onClick={retryDrawer}>
              Retry
            </button>
          </p>
        ) : feedback.decisions.length === 0 && feedback.comments.length === 0 ? (
          <p className="app-field-help" style={{ margin: 0 }}>The reviewer has not commented or decided yet.</p>
        ) : (
          <div style={{ display: "grid", gap: 6, overflowWrap: "anywhere" }}>
            {feedback.decisions.map((d) => (
              <div key={d.id} data-feedback-decision={d.verdict}>
                <strong>Decision: {identifierLabel(d.verdict)}</strong>{" "}
                <span className="app-table__muted">{formatUserDateTime(d.submittedAtUtc)}</span>
                {d.rationale ? <p style={{ margin: "2px 0 0", whiteSpace: "pre-wrap" }}>{d.rationale}</p> : null}
              </div>
            ))}
            {feedback.comments.map((c) => (
              <div key={c.id} data-feedback-comment style={{ paddingLeft: c.parentCommentId ? 12 : 0 }}>
                <span className="app-table__muted">
                  {c.authorDisplay ?? "Reviewer"} · {formatUserDateTime(c.createdAt)}
                </span>
                <p style={{ margin: "2px 0 0", whiteSpace: "pre-wrap" }}>{c.body}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      <section
        data-drawer-activity-panel
        className="app-panel"
        style={panelStyle}
      >
        <h3 className="app-panel__title">Activity timeline</h3>
        {activity === null ? (
          <p role="status" className="app-field-help" style={{ margin: 0 }}>Loading…</p>
        ) : activity === "error" ? (
          <p role="alert" data-drawer-activity-error className="app-field-error" style={{ margin: 0 }}>
            The activity timeline could not be loaded.{" "}
            <button type="button" className="app-secondary-action" data-drawer-retry onClick={retryDrawer}>
              Retry
            </button>
          </p>
        ) : activity.length === 0 ? (
          <p className="app-field-help" style={{ margin: 0 }}>No activity recorded yet.</p>
        ) : (
          <ul
            data-activity-timeline
            style={{ margin: 0, padding: 0, listStyle: "none" }}
          >
            {activity.map((a) => (
              <li
                key={a.id}
                data-activity-row={a.code}
                style={{
                  padding: "4px 0",
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                }}
              >
                <span style={{ flex: "1 1 200px", minWidth: 0, overflowWrap: "anywhere" }}>
                  {identifierLabel(a.code)} <code data-identifier>{a.code}</code>
                </span>
                <span className="app-table__muted">
                  {formatUserDateTime(a.occurredAtUtc)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}

function BreakGlassReveal({
  grantId,
  stepUp,
  onCancel,
  onRevealed,
}: {
  grantId: string;
  stepUp: ReturnType<typeof useStepUpAction>;
  onCancel: () => void;
  onRevealed: (rawToken: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const onConfirm = useCallback(async () => {
    if (reason.trim().length < 10) {
      setErr("Provide a brief operator reason (≥ 10 chars).");
      return;
    }
    setBusy(true);
    try {
      // Break-glass reveal ROTATES the grant token and returns a fresh
      // raw token — sensitive, so it is step-up gated on the backend.
      // Wrap in `runStepUpAction`: a 401 STEP_UP_REQUIRED surfaces the
      // modal and the request resumes (with the challenge header) once
      // verified. This deliberately requires a confirmed reason so it
      // is auditable.
      const res = (await stepUp.runStepUpAction(async (headers) =>
        apiFetch(
          `/v1/external-review/invitations/${grantId}/reveal-token`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(headers ?? {}),
            },
            body: JSON.stringify({ reason: reason.trim() }),
          },
        ),
      )) as { rawToken?: string } | null;
      if (typeof res?.rawToken === "string") {
        onRevealed(res.rawToken);
      } else {
        setErr("Reveal denied — see audit timeline.");
      }
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === "STEP_UP_CANCEL") {
        setErr("Step-up cancelled — token was not revealed.");
        return;
      }
      // eslint-disable-next-line no-console
      console.warn("[external-review] reveal token failed", {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        status: (e as any)?.statusCode ?? 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        code: (e as any)?.code ?? "UNKNOWN",
      });
      const denial = denialFromError(e);
      setErr(denial === "REFUSED" ? "REVEAL_REFUSED" : denial);
    } finally {
      setBusy(false);
    }
  }, [grantId, reason, onRevealed, stepUp]);
  return (
    <div data-break-glass-form style={{ display: "grid", gap: 6 }}>
      <label className="app-field-label" htmlFor={`break-glass-reason-${grantId}`}>
        Operator reason
      </label>
      <textarea
        id={`break-glass-reason-${grantId}`}
        data-break-glass-reason
        rows={2}
        placeholder="Operator reason (e.g. reviewer cannot receive email — Acme Co.)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className="app-input"
        aria-invalid={err ? true : undefined}
      />
      {err ? (
        <p role="alert" className="app-field-error" style={{ margin: 0 }}>
          {err}
        </p>
      ) : null}
      {/* TEAM-UI-SPEC §1 — Cancel secondary + the irreversible confirm as
          `app-danger-action` (the reveal rotates the grant token). */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button
          type="button"
          className="app-secondary-action"
          data-break-glass-cancel
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className="app-danger-action"
          data-break-glass-confirm
          onClick={onConfirm}
          disabled={busy}
          aria-busy={busy || undefined}
        >
          {busy ? "Revealing…" : "Reveal raw token"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bulk Invite panel
// ---------------------------------------------------------------------------

function BulkInvitePanel({
  caps,
  teamId,
  stepUp,
  onCompleted,
  onCancel,
}: {
  caps: ExternalReviewCapabilities;
  teamId: string | null;
  stepUp: ReturnType<typeof useStepUpAction>;
  onCompleted: (tally: BulkIssueTally) => Promise<void>;
  onCancel?: () => void;
}) {
  const { addToast } = useToast();
  // D16 — every grant needs ONE target in this workspace. Without it the
  // API answers each row POLICY_DENIED and writes nothing.
  const [scope, setScope] = useState<ReviewScopeState>({
    target: null,
    blockedReason: SCOPE_REQUIRED_REASON,
  });
  const [pasted, setPasted] = useState("");
  // T-155 — the field's text; a whole number of hours within bounds or Issue
  // stays disabled (empty used to issue an already-expired invitation, and a
  // non-numeric value threw on toISOString).
  const [hoursText, setHoursText] = useState("72");
  const hours = parseExternalReviewExpiryHours(hoursText);
  const [defaultRole, setDefaultRole] = useState<ExternalReviewerRole>(
    "EXTERNAL_REVIEWER",
  );
  const [defaultWatermark, setDefaultWatermark] = useState<
    "ALWAYS" | "BYTES_ONLY" | "NEVER"
  >("ALWAYS");
  const [defaultMfa, setDefaultMfa] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<{
    bulkBatchId: string;
    summary: Record<string, number>;
    rows: BulkOutcomeRow[];
  } | null>(null);

  const parsed = useMemo(() => parseBulkPaste(pasted), [pasted]);

  const onIssueBulk = useCallback(async () => {
    if (!caps.canBulkInvite) {
      setOutcomes({
        bulkBatchId: "",
        summary: {},
        rows: parsed.map((p) => ({
          inviteEmail: p.email,
          outcome: "FAILED",
          grantId: null,
          denial: "NOT_PERMITTED",
        })),
      });
      return;
    }
    if (parsed.length === 0) return;
    if (parsed.length > BULK_INVITATION_MAX_ROWS) return;
    const target = scope.target;
    if (!target || scope.blockedReason) return;
    if (hours === null || parsed.some((p) => !p.valid)) return;
    setBusy(true);
    try {
      // Bulk issue grants multiple outside reviewers access to sensitive
      // evidence — step-up gated on the backend. Wrap in
      // `runStepUpAction`: a 401 STEP_UP_REQUIRED surfaces the modal and
      // the request resumes (with the challenge header) once verified.
      const res = await stepUp.runStepUpAction(async (headers) =>
        apiFetch("/v1/external-review/invitations/bulk", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(headers ?? {}),
          },
          body: JSON.stringify({
            expiresAtUtc: new Date(
              Date.now() + hours * 3600 * 1000,
            ).toISOString(),
            defaultRole,
            defaultWatermarkPolicy: defaultWatermark,
            defaultMfaRequired: defaultMfa,
            defaultScope: defaultScopeFor(target),
            rows: parsed.map((p) => ({
              inviteEmail: p.email,
              displayName: p.displayName,
              organization: p.organization,
            })),
            // PRO-R1-03 — no SSO fields: outside reviewers sign in with the
            // emailed link (and the emailed code when required). The API
            // refuses an SSO request rather than issuing a bearer link.
          }),
        }),
      );
      const resultRows = (
        Array.isArray(res?.rows) ? res.rows : []
      ) as BulkOutcomeRow[];
      setOutcomes({
        bulkBatchId: typeof res?.bulkBatchId === "string" ? res.bulkBatchId : "",
        summary: (res?.summary ?? {}) as Record<string, number>,
        rows: resultRows,
      });
      await onCompleted(tallyBulkOutcome(resultRows));
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "STEP_UP_CANCEL") {
        // Operator cancelled the step-up challenge — nothing was issued.
        // The modal already conveyed the cancel; surface a bounded
        // per-row outcome so the table doesn't look silently stuck.
        setOutcomes({
          bulkBatchId: "",
          summary: {},
          rows: parsed.map((p) => ({
            inviteEmail: p.email,
            outcome: "FAILED",
            grantId: null,
            denial: "STEP_UP_CANCELLED",
          })),
        });
        return;
      }
      // eslint-disable-next-line no-console
      console.warn("[external-review] bulk invite failed", {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        status: (err as any)?.statusCode ?? 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        code: (err as any)?.code ?? "UNKNOWN",
      });
      notifyApiError(addToast, err, {
        message: toSafeUserError(err, {
          message: "We couldn't issue these invitations.",
        }).message,
      });
      const denial = denialFromError(err);
      setOutcomes({
        bulkBatchId: "",
        summary: {},
        rows: parsed.map((p) => ({
          inviteEmail: p.email,
          outcome: "FAILED",
          grantId: null,
          denial,
        })),
      });
    } finally {
      setBusy(false);
    }
  }, [
    caps.canBulkInvite,
    parsed,
    scope,
    hours,
    defaultRole,
    defaultWatermark,
    defaultMfa,
    onCompleted,
    stepUp,
    addToast,
  ]);

  const invalidCount = parsed.filter((p) => !p.valid).length;
  // The first reason that applies, stated on the disabled control.
  const submitBlockedReason: string | null = !caps.canBulkInvite
    ? "You do not have permission to bulk issue invitations"
    : scope.blockedReason
      ? scope.blockedReason
      : !scope.target
        ? SCOPE_REQUIRED_REASON
        : parsed.length === 0
          ? "Paste at least one reviewer email to issue invitations."
          : parsed.length > BULK_INVITATION_MAX_ROWS
            ? `You entered ${parsed.length} reviewers; issue at most ${BULK_INVITATION_MAX_ROWS} at a time. Nothing is dropped silently — remove ${parsed.length - BULK_INVITATION_MAX_ROWS} to continue.`
            : invalidCount > 0
              ? `${invalidCount} of ${parsed.length} ${invalidCount === 1 ? "address is" : "addresses are"} not a valid e-mail address. Fix or remove ${invalidCount === 1 ? "it" : "them"} to issue; nothing was sent.`
              : hours === null
                ? `Enter a whole number of hours between ${EXTERNAL_REVIEW_EXPIRY_HOURS_MIN} and ${EXTERNAL_REVIEW_EXPIRY_HOURS_MAX} (30 days).`
                : null;

  return (
    <section
      data-bulk-invite-panel
      className="app-panel"
      style={{
        padding: 16,
        display: "grid",
        gap: 12,
        minWidth: 0,
      }}
    >
      <header>
        <h2 className="app-panel__title">Invite external reviewers</h2>
        <p className="app-field-help" style={{ margin: "4px 0 0" }}>
          One reviewer or many: enter one per line. Accepted formats:
        </p>
        <ul
          className="app-field-help"
          style={{
            margin: "4px 0",
            paddingLeft: 18,
            overflowWrap: "anywhere",
          }}
        >
          <li>
            <code>reviewer@example.com</code>
          </li>
          <li>
            <code>reviewer@example.com,Display Name</code>
          </li>
          <li>
            <code>reviewer@example.com,Display Name,Organization</code>
          </li>
        </ul>
        <p className="app-field-help" style={{ margin: 0 }}>
          Bounded ≤ {BULK_INVITATION_MAX_ROWS} rows per call. One failing
          row never aborts the batch.
        </p>
      </header>

      <ReviewScopePicker teamId={teamId} onChange={setScope} />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))",
          gap: 12,
        }}
      >
        <Field label={`Reviewers (≤ ${BULK_INVITATION_MAX_ROWS})`}>
          <textarea
            data-bulk-paste
            rows={10}
            placeholder={"reviewer@example.com\nsue@acme.com,Sue Q.,Acme"}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            className="app-input"
            style={{
              width: "100%",
              fontFamily: "ui-monospace, SFMono-Regular, monospace",
              boxSizing: "border-box",
            }}
          />
          <small data-bulk-paste-count className="app-field-help">
            {parsed.length} {parsed.length === 1 ? "row" : "rows"} parsed
            {invalidCount > 0 ? ` · ${invalidCount} invalid (flagged below)` : ""}
            {parsed.length > BULK_INVITATION_MAX_ROWS ? ` · over the ${BULK_INVITATION_MAX_ROWS}-row limit` : ""}.
          </small>
          {parsed.length > 0 ? (
            <table data-bulk-paste-preview className="app-table" data-responsive="">
              <thead>
                <tr>
                  <th scope="col">Email</th>
                  <th scope="col">Display</th>
                  <th scope="col">Org</th>
                  <th scope="col">Validity</th>
                </tr>
              </thead>
              <tbody>
                {parsed.map((p, idx) => (
                  <tr
                    key={`${idx}-${p.email}`}
                    data-bulk-paste-row={idx}
                    data-bulk-paste-valid={p.valid ? "true" : "false"}
                  >
                    <td data-label="Email" style={{ overflowWrap: "anywhere" }}>{p.email}</td>
                    <td data-label="Display">{p.displayName ?? "—"}</td>
                    <td data-label="Org">{p.organization ?? "—"}</td>
                    <td data-label="Validity">
                      {p.valid ? (
                        <Chip tone="ok" label="Valid" />
                      ) : (
                        <Chip tone="warn" label={bulkInvitationOutcomeLabel("INVALID_EMAIL")} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </Field>

        <div style={{ display: "grid", gap: 8 }}>
          <Field label="Default role">
            <AppListbox
              value={defaultRole}
              options={[
                ...EXTERNAL_REVIEWER_ROLES.map((r) => ({ value: r, label: identifierLabel(r) })),
              ]}
              onChange={(next) => setDefaultRole(next as ExternalReviewerRole)}
              triggerProps={{ "data-bulk-default-role": "" }}
            />
          </Field>
          <Field label="On-screen watermark (portal panel only; downloads are not marked)">
            <AppListbox
              value={defaultWatermark}
              options={[
                ...WATERMARK_POLICIES.map((w) => ({ value: w, label: identifierLabel(w) })),
              ]}
              onChange={(next) => setDefaultWatermark(next as typeof defaultWatermark)}
              triggerProps={{ "data-bulk-default-watermark": "" }}
            />
          </Field>
          <Field label="Expires in (hours)">
            <input
              data-bulk-default-hours
              type="number"
              inputMode="numeric"
              min={EXTERNAL_REVIEW_EXPIRY_HOURS_MIN}
              max={EXTERNAL_REVIEW_EXPIRY_HOURS_MAX}
              step={1}
              value={hoursText}
              onChange={(e) => setHoursText(e.target.value)}
              aria-invalid={hours === null ? true : undefined}
              aria-describedby={hours === null ? "bulk-hours-error" : undefined}
              className="app-input"
            />
            {hours === null ? (
              <small id="bulk-hours-error" data-bulk-hours-error className="app-field-error">
                Enter a whole number of hours between {EXTERNAL_REVIEW_EXPIRY_HOURS_MIN} and {EXTERNAL_REVIEW_EXPIRY_HOURS_MAX}.
              </small>
            ) : null}
          </Field>
          <label
            className="app-field-label"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <input
              data-bulk-default-mfa
              type="checkbox"
              checked={defaultMfa}
              onChange={(e) => setDefaultMfa(e.target.checked)}
            />
            Require MFA for each row
          </label>

          <p data-bulk-sign-in-note className="app-field-help" style={{ margin: 0 }}>
            Reviewers sign in with the emailed link, plus the emailed code when MFA is required.
            Single sign-on is not available for outside reviewers.
          </p>
        </div>
      </div>

      <div>
        {/* TEAM-UI-SPEC §1 — issuing invitations is the one primary on
            this tab. */}
        <CanonicalActionButton
          variant="primary"
          data-bulk-issue-submit
          data-capability-allowed={caps.canBulkInvite ? "true" : "false"}
          onClick={onIssueBulk}
          busy={busy}
          disabled={submitBlockedReason !== null}
          disabledReason={submitBlockedReason ?? undefined}
        >
          {busy
            ? "Issuing…"
            : `Issue ${parsed.length} invitation${parsed.length === 1 ? "" : "s"}`}
        </CanonicalActionButton>
        {onCancel ? (
          <button
            type="button"
            className="app-ghost-action"
            data-invite-cancel
            style={{ marginLeft: 8 }}
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
        ) : null}
      </div>

      {outcomes ? (
        <section data-bulk-outcomes style={{ minWidth: 0 }}>
          <strong>
            {outcomes.bulkBatchId ? (
              <>
                Batch{" "}
                <code data-identifier>{outcomes.bulkBatchId.slice(0, 8)}…</code>
              </>
            ) : (
              "Nothing was sent"
            )}
          </strong>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
            {Object.entries(outcomes.summary).map(([k, v]) => (
              <Chip
                key={k}
                data-bulk-summary={k}
                tone={k === "INVITED" ? "ok" : k === "FAILED" ? "warn" : "muted"}
                label={`${bulkInvitationOutcomeLabel(k)}: ${v}`}
              />
            ))}
          </div>
          <div className="app-table-surface--scroll" style={{ marginTop: 6 }}>
          <table data-bulk-outcome-table className="app-table" data-responsive="">
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Outcome</th>
                <th scope="col">Access</th>
                <th scope="col">Reason</th>
              </tr>
            </thead>
            <tbody>
              {outcomes.rows.map((r, idx) => (
                <tr
                  key={`${idx}-${r.inviteEmail}`}
                  data-bulk-outcome-row={r.inviteEmail}
                  data-bulk-outcome={r.outcome}
                >
                  <td data-label="Email" style={{ overflowWrap: "anywhere" }}>{r.inviteEmail}</td>
                  <td data-label="Outcome">
                    <Chip
                      tone={
                        r.outcome === "INVITED"
                          ? "ok"
                          : r.outcome === "DUPLICATE"
                          ? "info"
                          : "warn"
                      }
                      label={bulkInvitationOutcomeLabel(r.outcome)}
                    />
                  </td>
                  <td data-label="Access">
                    {r.grantId ? (
                      <>
                        Created{" "}
                        <code data-identifier>{r.grantId.slice(0, 8)}…</code>
                      </>
                    ) : (
                      "Not created"
                    )}
                  </td>
                  <td data-label="Reason" data-bulk-outcome-reason>
                    {bulkOutcomeReason(r) ?? "—"}
                    {r.denial ? (
                      <>
                        {" "}
                        <code data-identifier>{r.denial}</code>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </section>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ParsedBulkRow = {
  email: string;
  displayName?: string;
  organization?: string;
  valid: boolean;
};

function parseBulkPaste(text: string): ParsedBulkRow[] {
  if (!text || !text.trim()) return [];
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  // T-156 — every line is parsed and shown; a list over the row limit is
  // refused with its count (it used to be cut to the limit silently).
  return lines.map((line) => {
    const parts = line.split(",").map((p) => p.trim());
    const email = parts[0] ?? "";
    const displayName = parts[1] ? parts[1] : undefined;
    const organization = parts[2] ? parts[2] : undefined;
    return {
      email,
      displayName,
      organization,
      valid: isEmail(email),
    };
  });
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function deliveryTone(status: string): "ok" | "info" | "muted" | "warn" {
  switch (status) {
    case "SENT":
    case "DELIVERED":
    case "OPENED":
      return "ok";
    case "PENDING":
      return "info";
    case "REVOKED":
    case "EXPIRED":
      return "muted";
    case "FAILED":
    default:
      return "warn";
  }
}

function Chip({
  label,
  tone,
  ...rest
}: {
  label: string;
  tone: "ok" | "info" | "muted" | "warn";
} & React.HTMLAttributes<HTMLSpanElement>) {
  // TEAM-UI-SPEC §1 — status reads as the canonical `app-chip` family.
  const toneClass =
    tone === "ok" ? " app-chip--ok" : tone === "warn" ? " app-chip--warn" : "";
  return (
    <span {...rest} data-chip-tone={tone} className={`app-chip${toneClass}`} style={{ marginRight: 4 }}>
      {label}
    </span>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <span className="app-field-label">{label}</span>
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Inline style constants
// ---------------------------------------------------------------------------

/** Drawer sub-panels (`app-panel`), laid out as a small stack. */
const panelStyle = {
  padding: 12,
  display: "grid",
  gap: 6,
  minWidth: 0,
} as const;
const chipsRowStyle = {
  display: "flex",
  gap: 4,
  flexWrap: "wrap" as const,
};
