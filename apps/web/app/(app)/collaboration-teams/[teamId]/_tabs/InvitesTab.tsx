"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { useToast } from "../../../../../components/ui";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import { AppListbox } from "../../../../../components/app-primitives/AppListbox";
import {
  AppStatusBadge,
  type AppTone,
} from "../../../../../components/app-primitives/AppStatusBadge";
import { ApiError } from "../../../../../lib/api";
import { notifyApiError } from "../../../../../lib/feedback/notify";
import { formatUserDate } from "../../../../../lib/date";
import {
  type CollaborationTeamDetail,
  type CollaborationTeamInvite,
  inviteByEmail,
  revokeInvite,
} from "../../../../../lib/api/collaboration-teams";
import {
  COLLABORATION_TEAM_ROLES,
  type CollaborationTeamRole,
} from "@proovra/shared";
/**
 * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — `CollaborationTeamCapacity`
 * was DELETED from the billing package. It projected the OWNED-WORKSPACE cap
 * into a field called `maxTeams` that the server then enforced over
 * CollaborationTeam rows, so one integer capped two unrelated tables.
 *
 * This is the shape the SERVER projection actually sends, with each field
 * naming the container it caps. The browser still renders these values and
 * never derives them.
 */
type CollaborationTeamCapacity = {
  maxCollaborationTeamsPerWorkspace: number;
  maxAcceptedMembersPerCollaborationTeam: number;
  maxPendingInvitesPerTeam: number;
  maxInvitesPer24h: number;
};
import {
  useActiveSpace,
  useWorkspaceLimits,
} from "../../../../../lib/platform-context";
import {
  PlanGateBadge,
  type PlanTier,
} from "../../../../../components/billing/PlanGateBadge";

// =============================================================================
// Invites tab — EMAIL-ONLY (Teams Entitlement Alignment, 2026-07-14).
//
// Invitations are email-only product-wide: the SMS and shareable-link invite
// channels were deleted from the product (backend endpoints are GONE), so this
// tab renders exactly ONE invite form (email) plus the pending/recent invite
// list. Historic SMS/LINK invite rows may still appear in the list — display
// is honest, but no new non-email invites can be issued.
//
// Plan lock: when the resolved plan grants ZERO Teams (`maxTeams === 0` —
// FREE/PAYG owning a grandfathered Team), the ENTIRE invite surface is
// replaced by a single upgrade panel. We never render a fillable form that is
// known to fail (the backend answers 402 TEAM_INVITES_NOT_INCLUDED).
// =============================================================================

function InvitesTab({
  team,
  onRefresh,
  canInvite,
}: {
  team: CollaborationTeamDetail;
  onRefresh: () => Promise<void>;
  canInvite: boolean;
}) {
  const { addToast } = useToast();
  const limits = useResolvedCollaborationTeamCapacity();
  const currentPlan = useResolvedActivePlanTier();

  const onError = (err: { message: string; requestId?: string }) =>
    notifyApiError(addToast, err);

  // Plan lock — resolved plan includes zero Teams. Replace the whole invite
  // surface (form + caps badge) with one honest upgrade panel. While the
  // envelope is still loading (limits === null) we keep the normal surface;
  // the backend guards remain the source of truth.
  const planLocked =
    limits !== null && limits.maxCollaborationTeamsPerWorkspace === 0;

  if (planLocked) {
    return (
      <section data-testid="tab-invites-content">
        <div className="app-panel" data-testid="invites-plan-locked">
          <div className="app-panel__head">
            <h2 className="app-panel__title">Invitations are locked</h2>
          </div>
          <div className="app-panel__body">
            <p
              style={{
                color: "#475569",
                margin: "0 0 12px",
                fontSize: 13.5,
                lineHeight: 1.55,
                maxWidth: "60ch",
              }}
            >
              The Team owner&apos;s current plan does not include Teams.
              Existing data remains accessible. Upgrade to invite members.
            </p>
            <div
              style={{
                display: "flex",
                gap: 12,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <Link
                href="/billing"
                className="app-primary-action"
                data-testid="invites-plan-locked-upgrade-cta"
              >
                View billing
              </Link>
              <PlanGateBadge
                feature="Teams"
                requiredPlan="PRO"
                currentPlan={currentPlan}
                upgradeCtaHref="/billing"
              />
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section data-testid="tab-invites-content">
      <div className="app-panel">
        <div className="app-panel__head">
          <div>
            <h2 className="app-panel__title">Invite people</h2>
            <p
              style={{
                color: "#667085",
                marginTop: 4,
                marginBottom: 0,
                fontSize: 13,
              }}
            >
              Invite collaborators by email. Invitees must also join the
              parent workspace to accept.
            </p>
          </div>
        </div>

        <div className="app-panel__body">
          {canInvite ? (
            <div className="app-inner-surface" style={{ padding: "1.1rem" }}>
              <EmailInviteCard
                teamId={team.id}
                onSent={() => {
                  addToast("Email invite sent.", "success");
                  void onRefresh();
                }}
                onError={onError}
              />
            </div>
          ) : (
            <p
              style={{
                color: "#A86612",
                background: "#FFF6E5",
                border: "1px solid rgba(168,102,18,0.17)",
                padding: "1rem",
                borderRadius: 10,
                margin: 0,
                fontSize: 13,
              }}
              data-testid="invites-permission-denied"
            >
              Only LEAD and ADMIN can issue invitations. Ask a team lead.
            </p>
          )}

          <PendingInvitesBadge invites={team.invites} limits={limits} />
        </div>
      </div>

      <div className="app-panel" style={{ marginTop: "1.25rem" }}>
        <div className="app-panel__head">
          <h3 className="app-panel__title">Pending &amp; recent invites</h3>
        </div>
        <div className="app-panel__body">
          {team.invites.length === 0 ? (
            <div className="app-empty">
              <span className="app-empty__icon" aria-hidden>
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M4 4h16v16H4z" />
                  <path d="m22 6-10 7L2 6" />
                </svg>
              </span>
              <strong>No invites yet</strong>
              <p>
                Pending and recently issued invitations will appear here once
                you send one.
              </p>
            </div>
          ) : (
            <div className="app-table-surface">
              <table className="app-table" data-responsive>
                <thead>
                  <tr>
                    <th scope="col">Recipient</th>
                    <th scope="col">Channel</th>
                    <th scope="col">Role</th>
                    <th scope="col">Status</th>
                    <th scope="col">Sent</th>
                    <th scope="col">Expires</th>
                    <th scope="col">Delivery</th>
                    <th scope="col" style={{ textAlign: "right" }}>
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {team.invites.map((inv) => (
                    <InviteRow
                      key={inv.id}
                      invite={inv}
                      teamId={team.id}
                      canManage={canInvite}
                      onRefresh={onRefresh}
                      onError={onError}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function EmailInviteCard({
  teamId,
  onSent,
  onError,
}: {
  teamId: string;
  onSent: () => void;
  onError: (err: { message: string; requestId?: string }) => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<CollaborationTeamRole>("MEMBER");
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!email || busy) return;
        setBusy(true);
        try {
          await inviteByEmail(teamId, {
            email,
            role,
            expiresInDays: days,
          });
          setEmail("");
          onSent();
        } catch (err) {
          if (err instanceof ApiError) {
            onError({ message: err.message, requestId: err.requestId });
          } else {
            onError({ message: "Couldn't send email invite." });
          }
        } finally {
          setBusy(false);
        }
      }}
      data-testid="email-invite-form"
      style={formGridStyle}
    >
      <div style={fieldWideStyle}>
        <label className="app-field-label" htmlFor="email-invite-email">
          Email
        </label>
        <input
          id="email-invite-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          placeholder="teammate@firm.com"
          data-testid="email-invite-email"
          className="app-form-input"
        />
      </div>
      <RoleSelect value={role} onChange={setRole} data-testid-prefix="email" />
      <ExpirySelect value={days} onChange={setDays} />
      <div style={actionRowStyle}>
        <button
          type="submit"
          disabled={!email || busy}
          className="app-primary-action"
          data-testid="email-invite-submit"
        >
          {busy ? "Sending…" : "Send email invite"}
        </button>
      </div>
    </form>
  );
}

// Map an invite status to the app semantic tone contract.
function inviteStatusTone(status: string): AppTone {
  switch (status) {
    case "ACCEPTED":
      return "green";
    case "PENDING":
      return "amber";
    case "REVOKED":
    case "EXPIRED":
    case "CANCELLED":
      return "red";
    default:
      return "slate";
  }
}

function InviteRow({
  invite,
  teamId,
  canManage,
  onRefresh,
  onError,
}: {
  invite: CollaborationTeamInvite;
  teamId: string;
  canManage: boolean;
  onRefresh: () => Promise<void>;
  onError: (err: { message: string; requestId?: string }) => void;
}) {
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();
  const [busy, setBusy] = useState(false);
  // Historic rows: SMS/LINK invites issued before the email-only
  // alignment may still exist — display them honestly.
  const recipient = invite.email ?? invite.phone ?? "—";
  const onRevoke = async () => {
    const ok = await confirm({
      title: "Revoke this invite?",
      description:
        "Anyone using this invite will no longer be able to accept it.",
      confirmLabel: "Revoke",
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await revokeInvite(teamId, invite.id);
      addToast("Invite revoked.", "success");
      await onRefresh();
    } catch (err) {
      if (err instanceof ApiError) {
        onError({ message: err.message, requestId: err.requestId });
      } else {
        onError({ message: "Couldn't revoke invite." });
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <tr data-testid={`invite-row-${invite.id}`}>
      <td data-label="Recipient">
        <span
          className="app-table__primary"
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            display: "block",
            maxWidth: 260,
          }}
        >
          {recipient}
        </span>
      </td>
      <td data-label="Channel">
        <AppStatusBadge tone="slate">{invite.channel}</AppStatusBadge>
      </td>
      <td data-label="Role">
        <span className="app-table__muted">{invite.role}</span>
      </td>
      <td data-label="Status">
        <AppStatusBadge tone={inviteStatusTone(invite.status)}>
          {invite.status}
        </AppStatusBadge>
      </td>
      <td data-label="Sent">
        <span className="app-table__muted">
          {formatUserDate(invite.createdAt)}
        </span>
      </td>
      <td data-label="Expires">
        <span className="app-table__muted">
          {formatUserDate(invite.expiresAtUtc)}
        </span>
      </td>
      <td data-label="Delivery">
        <span
          className="app-table__muted"
          style={{ textTransform: "capitalize" }}
        >
          {invite.deliveryStatus.toLowerCase()}
        </span>
      </td>
      <td data-label="">
        <div className="app-table__actions">
          {canManage && invite.status === "PENDING" ? (
            <button
              type="button"
              onClick={() => void onRevoke()}
              disabled={busy}
              className="app-danger-link"
              data-testid={`invite-revoke-${invite.id}`}
            >
              Revoke
            </button>
          ) : (
            <span className="app-table__muted">—</span>
          )}
        </div>
      </td>
    </tr>
  );
}

// -----------------------------------------------------------------------------
// PendingInvitesBadge — surfaces the per-team invite caps
// (`maxPendingInvitesPerTeam`, `maxInvitesPer24h`) BEFORE the user hits the
// 429 rate-limit from the backend billing guards.
//
// Data sources (NO new endpoint):
//   - Counts are derived from `team.invites` already on the detail payload.
//   - Caps come from the SERVER projection (`planFeatures.limits` for the
//     ACTIVE workspace) via `useResolvedCollaborationTeamCapacity`. We do
//     NOT fabricate caps, we do NOT re-derive them from a plan name, and we do
//     NOT re-fetch billing.
//
// Upgrade CTA points at the canonical billing surface (/billing).
// -----------------------------------------------------------------------------
function PendingInvitesBadge({
  invites,
  limits,
}: {
  invites: ReadonlyArray<CollaborationTeamInvite>;
  limits: CollaborationTeamCapacity | null;
}) {
  const pending = useMemo(
    () => invites.filter((i) => i.status === "PENDING").length,
    [invites],
  );
  const sent24h = useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return invites.filter((i) => {
      const ts = new Date(i.createdAt).getTime();
      return Number.isFinite(ts) && ts >= cutoff;
    }).length;
  }, [invites]);

  // While the plan is still loading from the envelope we render the counts
  // without a denominator rather than fabricating a cap.
  const pendingCap: number | null = limits?.maxPendingInvitesPerTeam ?? null;
  const rateCap: number | null = limits?.maxInvitesPer24h ?? null;

  const pendingAtCap = pendingCap !== null && pending >= pendingCap;
  const rateAtCap = rateCap !== null && sent24h >= rateCap;
  const anyAtCap = pendingAtCap || rateAtCap;

  const pendingLabel =
    pendingCap !== null
      ? `${pending} of ${pendingCap} pending invites`
      : `${pending} pending invites`;
  const rateLabel =
    rateCap !== null
      ? `${sent24h} of ${rateCap} invites sent in last 24h`
      : `${sent24h} invites sent in last 24h`;

  return (
    <div
      data-testid="pending-invites-badge"
      data-pending-at-cap={pendingAtCap ? "true" : "false"}
      data-rate-at-cap={rateAtCap ? "true" : "false"}
      role="status"
      aria-live="polite"
      style={{
        marginTop: "1.25rem",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 10,
      }}
    >
      <AppStatusBadge tone={pendingAtCap ? "red" : "slate"}>
        <span
          data-testid="pending-invites-count"
          title={
            pendingAtCap
              ? "Pending-invite cap reached. Revoke a pending invite or upgrade your plan to send more."
              : "Pending invites count toward your plan's per-team cap."
          }
          aria-label={pendingLabel}
        >
          {pendingLabel}
        </span>
      </AppStatusBadge>
      <AppStatusBadge tone={rateAtCap ? "red" : "slate"}>
        <span
          data-testid="invites-rate-count"
          title={
            rateAtCap
              ? "24h invite rate limit reached. Wait for the window to reset or upgrade your plan."
              : "Invites sent in the last 24 hours."
          }
          aria-label={rateLabel}
        >
          {rateLabel}
        </span>
      </AppStatusBadge>
      {anyAtCap ? (
        <Link
          href="/billing"
          data-testid="pending-invites-upgrade-cta"
          aria-label={
            pendingAtCap
              ? "Pending-invite cap reached — upgrade plan"
              : "24h invite rate limit reached — upgrade plan"
          }
          className="app-danger-link"
        >
          Upgrade plan
        </Link>
      ) : null}
    </div>
  );
}

/**
 * PHASE 12 — POINT 7 (2026-08-05): READ the limits, do not resolve them.
 *
 * These two hooks used to reconstruct the commercial subject in the browser —
 * "active organization's plan, else personal-space plan, else the ACCOUNT
 * plan" — and then key a limit table on the result. Three things were wrong
 * with that, in increasing order of consequence:
 *
 *   the `?? account.accountPlan` tail is an OWNER-PLAN FALLBACK, so a
 *   workspace with no commercial state of its own silently displayed its
 *   owner's allowance;
 *
 *   the resolution order was a hand-maintained copy of a backend chain, and
 *   copies drift — the server had already moved to a subject-correct
 *   effective-plan policy in which an Owned Workspace never inherits the
 *   owner's plan;
 *
 *   and it made the browser an authority on a commercial limit, which is the
 *   metric Point 7 drives to zero.
 *
 * The server now projects both the numeric limits and the ACTIVE space's plan.
 * `null` still means UNKNOWN, and call sites still render the unknown state
 * rather than fabricating FREE — that part was right and is preserved.
 */
function useResolvedCollaborationTeamCapacity():
  | CollaborationTeamCapacity
  | null {
  const limits = useWorkspaceLimits();
  if (!limits) return null;
  return {
    maxCollaborationTeamsPerWorkspace: limits.maxCollaborationTeamsPerWorkspace,
    maxAcceptedMembersPerCollaborationTeam:
      limits.maxAcceptedMembersPerCollaborationTeam,
    maxPendingInvitesPerTeam: limits.maxPendingInvitesPerTeam,
    maxInvitesPer24h: limits.maxInvitesPer24h,
  };
}

/**
 * The ACTIVE space's plan, for the `PlanGateBadge` label vocabulary.
 *
 * Server-resolved, on the canonical section. `null` = unknown; callers render
 * the unknown gate state rather than fabricating FREE.
 */
function useResolvedActivePlanTier(): PlanTier | null {
  const activeSpace = useActiveSpace();
  const plan = activeSpace?.plan ?? null;
  // WorkspacePlan vocabulary is a strict subset of PlanTier — narrow safely.
  return plan === null ? null : (plan as PlanTier);
}

function RoleSelect({
  value,
  onChange,
  "data-testid-prefix": prefix,
}: {
  value: CollaborationTeamRole;
  onChange: (r: CollaborationTeamRole) => void;
  "data-testid-prefix"?: string;
}) {
  const options = COLLABORATION_TEAM_ROLES.map((r) => ({
    value: r,
    label: r,
    description: roleHelp(r),
  }));
  const testid = prefix ? `${prefix}-invite-role` : undefined;
  return (
    <div>
      <span className="app-field-label" id={testid ? `${testid}-label` : undefined}>
        Role
      </span>
      <AppListbox<CollaborationTeamRole>
        value={value}
        options={options}
        onChange={onChange}
        ariaLabelledby={testid ? `${testid}-label` : undefined}
        ariaLabel={testid ? undefined : "Role"}
      />
      {/* Hidden mirror preserves the former native <select>'s testid + value
          so tests keyed on `{prefix}-invite-role` still resolve the value. */}
      {testid ? (
        <input type="hidden" data-testid={testid} value={value} readOnly />
      ) : null}
    </div>
  );
}

function ExpirySelect({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const options = [
    { value: "1", label: "1 day" },
    { value: "3", label: "3 days" },
    { value: "7", label: "7 days" },
    { value: "14", label: "14 days" },
    { value: "30", label: "30 days" },
  ];
  return (
    <div>
      <span className="app-field-label" id="invite-expiry-label">
        Expires in
      </span>
      <AppListbox
        value={String(value)}
        options={options}
        onChange={(v) => onChange(parseInt(v, 10))}
        ariaLabelledby="invite-expiry-label"
      />
    </div>
  );
}

function roleHelp(r: CollaborationTeamRole): string {
  switch (r) {
    case "LEAD":
      return "manages team & leadership";
    case "ADMIN":
      return "manages members & work";
    case "MEMBER":
      return "participates in team work";
    case "VIEWER":
      return "read-only";
    case "EXTERNAL":
      return "limited collaborator";
  }
}

// =============================================================================
// Invites-tab-private layout styles
//
// LAYOUT only — colour, border, background, and focus come from the canonical
// `app-*` classes applied on each field. The form uses a responsive
// two-column grid; recipient/status/badge rows span full width.
// =============================================================================

const formGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: "0.9rem",
  alignItems: "start",
};

const fieldWideStyle: React.CSSProperties = {
  gridColumn: "1 / -1",
};

const actionRowStyle: React.CSSProperties = {
  gridColumn: "1 / -1",
  display: "flex",
  justifyContent: "flex-start",
  marginTop: "0.25rem",
};

export { InvitesTab };
