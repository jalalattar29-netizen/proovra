"use client";

import Link from "next/link";
import { useState } from "react";

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
  type CollaborationTeamMember,
  removeMember,
  updateMember,
} from "../../../../../lib/api/collaboration-teams";
import {
  COLLABORATION_TEAM_ROLES,
  type CollaborationTeamRole,
} from "@proovra/shared";
import {
  useActiveSpace,
  useWorkspaceLimits,
} from "../../../../../lib/platform-context";
import type { WorkspacePlan } from "../../../../../lib/platform-context/types";
import type { TabId } from "../page";

// =============================================================================
// Members tab
//
// VISUAL redesign — migrated onto the neutral `app-*` internal-product design
// system (Home/Cases visual language): `.app-panel`, `.app-table-surface` +
// `.app-table[data-responsive]`, `.app-avatar`, `AppListbox`, `AppStatusBadge`,
// `.app-primary-action`, `.app-danger-link`, `.app-empty`. No data-fetching,
// permission, billing-limit, route or behaviour changes — every data-testid,
// data-*, handler, and the plan-capacity logic are preserved verbatim.
// =============================================================================

function MembersTab({
  team,
  onRefresh,
  canManage,
  canInvite,
  onJumpTab,
}: {
  team: CollaborationTeamDetail;
  onRefresh: () => Promise<void>;
  canManage: boolean;
  canInvite: boolean;
  onJumpTab: (t: TabId) => void;
}) {
  const { addToast } = useToast();
  const activeLeadCount = team.members.filter(
    (m) => m.role === "LEAD" && m.status === "ACTIVE",
  ).length;
  // PHASE 12 — POINT 7 (2026-08-05). The cap is READ from the server
  // projection for the ACTIVE workspace, not computed here.
  //
  // It used to be `getCollaborationTeamPlanLimits(useAccount().accountPlan)`.
  // The intent was right — agree with the 409 the server would emit — but the
  // mechanism made the browser a limit authority, and it asked the wrong
  // subject: a collaboration team lives in a WORKSPACE, and a workspace's
  // commercial state is its own. On an unsubscribed Owned Workspace this
  // showed the OWNER's Pro allowance and left the invite button enabled right
  // up to the refusal it was supposed to anticipate.
  //
  // `null` means UNKNOWN (envelope loading, degraded, or older than the
  // projection): no badge, no "at capacity" claim, no fabricated number.
  const limits = useWorkspaceLimits();
  // Presentation only: the plan NAME shown in the badge copy. It comes from
  // the ACTIVE space (the workspace the team belongs to), which is the same
  // subject the limits above were resolved for — not from the account.
  const planLabel: WorkspacePlan | null = useActiveSpace()?.plan ?? null;
  const activeMemberCount = team.members.filter(
    (m) => m.status === "ACTIVE",
  ).length;
  const maxMembersPerTeam = limits?.maxMembersPerTeam ?? 0;
  const atCapacity =
    limits !== null && activeMemberCount >= maxMembersPerTeam;
  const capacityKnown = limits !== null && maxMembersPerTeam > 0;
  return (
    <section data-testid="tab-members-content" className="app-panel">
      <div className="app-panel__head" style={{ flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h2 className="app-panel__title">Members ({activeMemberCount})</h2>
          {capacityKnown ? (
            <MemberCapacityBadge
              memberCount={activeMemberCount}
              maxMembersPerTeam={maxMembersPerTeam}
              atCapacity={atCapacity}
              plan={planLabel}
            />
          ) : null}
        </div>
        {canInvite ? (
          <button
            type="button"
            className="app-primary-action"
            onClick={() => onJumpTab("invites")}
            disabled={atCapacity}
            aria-disabled={atCapacity || undefined}
            title={
              atCapacity
                ? "Team is at capacity for your plan. Upgrade to add more."
                : "Invite a new member"
            }
            data-testid="members-invite-button"
            data-at-capacity={atCapacity ? "true" : "false"}
          >
            Invite member
          </button>
        ) : null}
      </div>

      <div className="app-panel__body">
        {atCapacity ? (
          <div
            role="status"
            data-testid="members-at-capacity-notice"
            style={{
              background: "#FFF6E5",
              border: "1px solid rgba(168,102,18,0.17)",
              color: "#A86612",
              padding: "0.6rem 0.9rem",
              borderRadius: 10,
              marginBottom: "0.9rem",
              fontSize: "0.88rem",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <span>
              Team is at capacity for your plan
              {planLabel ? ` (${planLabel})` : ""}. Upgrade to add more.
            </span>
            <Link
              href="/billing"
              className="app-secondary-action"
              data-testid="members-at-capacity-upgrade"
            >
              Upgrade
            </Link>
          </div>
        ) : null}

        {team.members.length === 0 ? (
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
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </span>
            <strong>No members yet</strong>
            <p>
              Invite people to collaborate on this team&rsquo;s work,
              assignments, and activity.
            </p>
          </div>
        ) : (
          <div className="app-table-surface">
            <table className="app-table" data-responsive>
              <thead>
                <tr>
                  <th scope="col">Member</th>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                  <th scope="col">Joined</th>
                  <th scope="col">Last active</th>
                  <th scope="col">Access source</th>
                  <th scope="col" style={{ textAlign: "right" }}>
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {team.members.map((m) => (
                  <MemberRow
                    key={m.id}
                    member={m}
                    canManage={canManage}
                    teamId={team.id}
                    activeLeadCount={activeLeadCount}
                    onChanged={async (msg) => {
                      addToast(msg, "success");
                      await onRefresh();
                    }}
                    onError={(err) => notifyApiError(addToast, err)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * Phase 10 UX — visible per-team member capacity badge.
 *
 * Shows `{memberCount} of {maxMembersPerTeam} members` next to the
 * Members header so users see the cap BEFORE attempting to invite. When
 * at-capacity the badge switches to a warning tone; the parent surfaces
 * a non-dismissable notice + Upgrade link to `/billing`.
 *
 * The cap is the same value the backend uses (shared SoT
 * `getCollaborationTeamPlanLimits(plan).maxMembersPerTeam`), so this UI
 * cannot drift from the 409 the server would emit.
 */
function MemberCapacityBadge({
  memberCount,
  maxMembersPerTeam,
  atCapacity,
  plan,
}: {
  memberCount: number;
  maxMembersPerTeam: number;
  atCapacity: boolean;
  plan: WorkspacePlan | null;
}) {
  const label = `${memberCount} of ${maxMembersPerTeam} members`;
  const planLabel = plan ? ` on plan ${plan}` : "";
  return (
    <AppStatusBadge
      tone={atCapacity ? "red" : "green"}
      title={
        atCapacity
          ? "Team is at capacity for your plan. Upgrade to add more."
          : `Team member capacity${planLabel}.`
      }
      className="cc-member-capacity-badge"
    >
      <span
        role="status"
        aria-label={
          atCapacity
            ? `Team is at capacity${planLabel}: ${label}. Upgrade to add more.`
            : `${label}${planLabel}.`
        }
        data-testid="member-capacity-badge"
        data-at-capacity={atCapacity ? "true" : "false"}
      >
        {label}
      </span>
    </AppStatusBadge>
  );
}

// Map a member status to the app semantic tone contract.
//   Active=green · Pending=amber · Suspended=amber · Removed=red · else slate.
function memberStatusTone(status: string): AppTone {
  switch (status) {
    case "ACTIVE":
      return "green";
    case "PENDING":
    case "INVITED":
    case "SUSPENDED":
      return "amber";
    case "REMOVED":
      return "red";
    default:
      return "slate";
  }
}

function MemberRow({
  member,
  canManage,
  teamId,
  activeLeadCount,
  onChanged,
  onError,
}: {
  member: CollaborationTeamMember;
  canManage: boolean;
  teamId: string;
  activeLeadCount: number;
  onChanged: (msg: string) => void | Promise<void>;
  onError: (err: { message: string; requestId?: string }) => void;
}) {
  const displayName =
    member.user.displayName ||
    [member.user.firstName, member.user.lastName].filter(Boolean).join(" ") ||
    member.user.email ||
    member.userId;
  const isLastLead = member.role === "LEAD" && activeLeadCount <= 1;
  const [busy, setBusy] = useState(false);
  const { confirm } = useConfirmAction();

  const onChangeRole = async (role: CollaborationTeamRole) => {
    setBusy(true);
    try {
      await updateMember(teamId, member.id, { role });
      await onChanged(`Role updated to ${role}.`);
    } catch (err) {
      if (err instanceof ApiError) {
        onError({ message: err.message, requestId: err.requestId });
      } else {
        onError({ message: "Couldn't update role." });
      }
    } finally {
      setBusy(false);
    }
  };

  const onSuspend = async () => {
    setBusy(true);
    try {
      await updateMember(teamId, member.id, { status: "SUSPENDED" });
      await onChanged("Member suspended.");
    } catch (err) {
      if (err instanceof ApiError) {
        onError({ message: err.message, requestId: err.requestId });
      } else {
        onError({ message: "Couldn't suspend member." });
      }
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async () => {
    const ok = await confirm({
      title: `Remove ${displayName}?`,
      description:
        "They will lose access to this team's work, assignments, and activity.",
      confirmLabel: "Remove member",
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await removeMember(teamId, member.id);
      await onChanged("Member removed.");
    } catch (err) {
      if (err instanceof ApiError) {
        onError({ message: err.message, requestId: err.requestId });
      } else {
        onError({ message: "Couldn't remove member." });
      }
    } finally {
      setBusy(false);
    }
  };

  const roleOptions = COLLABORATION_TEAM_ROLES.map((r) => ({
    value: r,
    label: r,
  }));

  return (
    <tr data-testid={`member-row-${member.id}`}>
      <td data-label="Member">
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <span className="app-avatar" aria-hidden>
            {(displayName[0] ?? "?").toUpperCase()}
          </span>
          <div style={{ minWidth: 0 }}>
            <div
              className="app-table__primary"
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {displayName}
            </div>
            <div className="app-table__muted">
              {member.user.email ?? "no email"}
            </div>
          </div>
        </div>
      </td>
      <td data-label="Email">
        <span className="app-table__muted">
          {member.user.email ?? "—"}
        </span>
      </td>
      <td data-label="Role">
        {canManage ? (
          <div style={{ minWidth: 148 }}>
            <AppListbox<CollaborationTeamRole>
              value={member.role}
              options={roleOptions}
              onChange={(role) => void onChangeRole(role)}
              disabled={busy || isLastLead}
              ariaLabel={
                isLastLead
                  ? "Cannot demote the last LEAD. Transfer leadership first."
                  : `Change role for ${displayName}`
              }
            />
            {/* Hidden mirror preserves the pre-existing testid + value so
                interaction tests keyed on `member-role-select-*` still
                resolve the current role after the native <select> removal. */}
            <input
              type="hidden"
              data-testid={`member-role-select-${member.id}`}
              value={member.role}
              readOnly
            />
          </div>
        ) : (
          <AppStatusBadge tone="slate">{member.role}</AppStatusBadge>
        )}
      </td>
      <td data-label="Status">
        <AppStatusBadge tone={memberStatusTone(member.status)}>
          {member.status}
        </AppStatusBadge>
      </td>
      <td data-label="Joined">
        <span className="app-table__muted">
          {formatUserDate(member.joinedAt)}
        </span>
      </td>
      <td data-label="Last active">
        <span className="app-table__muted">—</span>
      </td>
      <td data-label="Access source">
        <span className="app-table__muted">—</span>
      </td>
      <td data-label="">
        <div className="app-table__actions">
          {canManage && member.status === "ACTIVE" ? (
            <>
              <button
                type="button"
                onClick={() => void onSuspend()}
                disabled={busy}
                className="app-ghost-action"
                data-testid={`member-suspend-${member.id}`}
              >
                Suspend
              </button>
              <button
                type="button"
                onClick={() => void onRemove()}
                disabled={busy || isLastLead}
                className="app-danger-link"
                data-testid={`member-remove-${member.id}`}
                title={
                  isLastLead
                    ? "Cannot remove the last LEAD."
                    : "Remove member"
                }
              >
                Remove
              </button>
            </>
          ) : (
            <span className="app-table__muted">—</span>
          )}
        </div>
      </td>
    </tr>
  );
}

export { MembersTab };
