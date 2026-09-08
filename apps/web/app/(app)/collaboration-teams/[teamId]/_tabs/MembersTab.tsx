"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { useToast } from "../../../../../components/ui";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import { AppListbox } from "../../../../../components/app-primitives/AppListbox";
import { AppStatusText } from "../../../../../components/app-primitives/AppStatusText";
import {
  AppStatusBadge,
  type AppTone,
} from "../../../../../components/app-primitives/AppStatusBadge";
import { ApiError } from "../../../../../lib/api";
import { notifyApiError } from "../../../../../lib/feedback/notify";
import { formatUserDate } from "../../../../../lib/date";
import {
  addExistingMember,
  addExistingMembersBulk,
  getCollaborationEntitlement,
  listTeamMembers,
  type CollaborationTeamMemberPage,
  type CollaborationEntitlement,
  type CollaborationTeamDetail,
  type CollaborationTeamMember,
  type EligibleWorkspaceMember,
  listEligibleMembers,
  removeMember,
  updateMember,
} from "../../../../../lib/api/collaboration-teams";
import {
  COLLABORATION_TEAM_ROLES,
  type CollaborationTeamRole,
} from "@proovra/shared";
import { useActiveSpace, usePlatformContext } from "../../../../../lib/platform-context";
import type { WorkspacePlan } from "../../../../../lib/platform-context/types";
import {
  buildWorkspaceInviteHref,
  buildWorkspacePeopleHref,
} from "../../../../../lib/navigation/workspacePeopleLocator";

/**
 * WCR-08 — the paged endpoint returns a FLAT row (displayName/email at the top
 * level); the detail preview nests a `user` object. One adapter, here, so the
 * row component has one shape to render and neither wire format leaks into it.
 *
 * `email` is `null` for a viewer without `team.member.invite` — the server
 * withholds it, and this must not invent one.
 */
function toDetailMembers(
  rows: CollaborationTeamMemberPage["members"],
): CollaborationTeamMember[] {
  return rows.map((m) => ({
    id: m.id,
    userId: m.userId,
    role: m.role,
    status: m.status,
    joinedAt: m.joinedAt,
    suspendedAt: m.suspendedAt,
    removedAt: m.removedAt,
    user: {
      id: m.userId,
      email: m.email,
      displayName: m.displayName,
      firstName: null,
      lastName: null,
      avatarUrl: m.avatarUrl,
    },
  }));
}

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
}: {
  team: CollaborationTeamDetail;
  onRefresh: () => Promise<void>;
  canManage: boolean;
  canInvite: boolean;
}) {
  const { addToast } = useToast();
  const [addingMember, setAddingMember] = useState(false);
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
  /**
   * WCR-06 / WCR-08 — the capacity answer comes from THE projection.
   *
   * `useWorkspaceLimits()` projects raw catalog integers with no contract, no
   * seat state and no lifecycle, so on an Enterprise workspace it reported the
   * flat catalog placeholder rather than the contracted ceiling. The
   * entitlement endpoint reconciles all of that — including the rule that a
   * group can hold everyone in the workspace and nobody else — and it is what
   * the server enforces on.
   */
  const [entitlement, setEntitlement] = useState<CollaborationEntitlement | null>(
    null,
  );
  /**
   * WCR-08 — THE ROSTER IS PAGED, SEARCHED AND FILTERED BY THE DATABASE.
   *
   * The tab rendered `team.members` — the detail payload's bounded preview —
   * with no pagination, no search and no "load more". Members past the preview
   * limit were simply unreachable, and the paginated endpoint built for this
   * (`GET /v1/collaboration-teams/:id/members`) had no consumer at all.
   *
   * The preview is still used as the FIRST PAINT so the tab is not empty while
   * the first page loads; every subsequent state comes from the server.
   */
  const [roster, setRoster] = useState<ReadonlyArray<CollaborationTeamMember> | null>(
    null,
  );
  const [rosterCursor, setRosterCursor] = useState<string | null>(null);
  const [rosterSearch, setRosterSearch] = useState("");
  const [rosterLoading, setRosterLoading] = useState(false);

  const loadRoster = useCallback(
    async (opts?: { cursor?: string | null; append?: boolean }) => {
      setRosterLoading(true);
      try {
        const page = await listTeamMembers(team.id, {
          search: rosterSearch,
          cursor: opts?.cursor ?? null,
        });
        setRosterCursor(page.nextCursor);
        setRoster((prev) =>
          opts?.append && prev
            ? [...prev, ...toDetailMembers(page.members)]
            : toDetailMembers(page.members),
        );
      } catch (err) {
        notifyApiError(addToast, err, {
          message: "Could not load this team's members.",
        });
      } finally {
        setRosterLoading(false);
      }
    },
    [team.id, rosterSearch, addToast],
  );

  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(() => {
      if (!cancelled) void loadRoster();
    }, rosterSearch ? 250 : 0);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [loadRoster, rosterSearch]);

  useEffect(() => {
    let cancelled = false;
    void getCollaborationEntitlement()
      .then((e) => {
        if (!cancelled) setEntitlement(e);
      })
      .catch(() => {
        // UNKNOWN, not zero. The badge is hidden rather than fabricated.
        if (!cancelled) setEntitlement(null);
      });
    return () => {
      cancelled = true;
    };
  }, [team.id]);
  // Presentation only: the plan NAME shown in the badge copy. It comes from
  // the ACTIVE space (the workspace the team belongs to), which is the same
  // subject the limits above were resolved for — not from the account.
  const planLabel: WorkspacePlan | null = useActiveSpace()?.plan ?? null;
  /**
   * WCR-08 — THE POPULATION, NOT THE PREVIEW.
   *
   * This filtered `team.members`, which is a bounded preview of at most
   * `memberPreviewLimit` rows. Above that limit the tab title under-reported,
   * the capacity badge under-reported, and `atCapacity` stayed false past the
   * real ceiling — so "Add member" remained enabled until the server refused
   * it with a 409. The server has always sent the real count.
   */
  /**
   * The rows on screen: the server's page once it has arrived, and the detail
   * payload's preview until then. The preview is a first PAINT, never a
   * population — every count and every capacity decision on this tab reads
   * `activeMemberCount` or the entitlement projection instead.
   */
  const visibleMembers = roster ?? team.members;
  const activeMemberCount = team.activeMemberCount;
  const maxMembersPerTeam = entitlement?.collaborationTeamMembers.limit ?? 0;
  const atCapacity =
    entitlement !== null && activeMemberCount >= maxMembersPerTeam;
  const capacityKnown = entitlement !== null && maxMembersPerTeam > 0;
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
            onClick={() => setAddingMember((open) => !open)}
            disabled={atCapacity}
            aria-disabled={atCapacity || undefined}
            title={
              atCapacity
                ? "Everyone in this workspace is already in this team."
                : "Add someone from this workspace"
            }
            data-testid="members-invite-button"
            data-at-capacity={atCapacity ? "true" : "false"}
            aria-expanded={addingMember}
          >
            {/*
              "Add member" was ambiguous on this page (§15.8): the identical
              words on Members & Access mean "invite a person to the
              WORKSPACE". Here they mean "pick someone who is already a member
              and put them on this team" — a different operation entirely, and
              the one that never sends an invitation. Naming the source of the
              choices removes the ambiguity without a tooltip.
            */}
            Add workspace members
          </button>
        ) : null}
      </div>

      {addingMember && !atCapacity ? (
        <AddMemberPanel
          team={team}
          onRefresh={onRefresh}
          onClose={() => setAddingMember(false)}
        />
      ) : null}

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

        {/*
          * WCR-08 — server search over the whole membership.
          *
          * Filtering the loaded page in the browser cannot be right: the list
          * has to be complete for a search to be, and completeness is exactly
          * what does not scale.
          */}
        {(team.activeMemberCount ?? 0) > (team.memberPreviewLimit ?? 25) ? (
          <div className="cases-search-field" style={{ marginBottom: "0.9rem" }}>
            <label className="app-visually-hidden" htmlFor="members-search">
              Search this team&rsquo;s members
            </label>
            <input
              id="members-search"
              type="search"
              value={rosterSearch}
              onChange={(e) => setRosterSearch(e.target.value)}
              placeholder="Search members by name or email"
              data-testid="members-search"
            />
          </div>
        ) : null}

        {visibleMembers.length === 0 ? (
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
              {/*
                §15.9 — the empty state teaches the architecture rather than
                describing a button. It said "Invite people", which names the
                WORKSPACE invitation operation this surface does not perform
                and must never grow: a Collaboration Team draws from existing
                workspace membership, and someone who is not a member yet
                becomes eligible by being invited to the workspace first.
              */}
              Add existing workspace members to this team, then assign cases,
              evidence and review work to the group.
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
                  <th scope="col" style={{ textAlign: "right" }}>
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleMembers.map((m) => (
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
            {rosterCursor ? (
              <div className="app-table-footer">
                <button
                  type="button"
                  className="app-secondary-action"
                  disabled={rosterLoading}
                  data-testid="members-load-more"
                  onClick={() =>
                    void loadRoster({ cursor: rosterCursor, append: true })
                  }
                >
                  {rosterLoading ? "Loading…" : "Load more members"}
                </button>
              </div>
            ) : null}
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
    <AppStatusText
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
    </AppStatusText>
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
    // NOT the address, and NOT the uuid. The server withholds the address from
    // viewers who are not member managers, so falling back to it would render
    // an empty string for exactly those people; falling back to a uuid renders
    // something no one can read.
    "Workspace member";
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
    /*
     * REMOVE FROM TEAM IS NOT REMOVE FROM WORKSPACE (§15.11).
     *
     * These are different operations with very different blast radii, and the
     * wording used to leave the scope to be inferred: "Remove {name}?" with
     * "Remove member" on a destructive button, on a page about a team, could
     * reasonably be read as revoking workspace access. A team operator must
     * not be able to end someone's access to the workspace while intending
     * only to take them off a group.
     *
     * So the title names the scope, the description says what is NOT affected,
     * and the button repeats the scope rather than the object. Workspace
     * removal stays where it belongs — a Members & Access governance action.
     */
    const ok = await confirm({
      title: `Remove ${displayName} from this team?`,
      description:
        "They stop being responsible for this team's assignments, work and activity. " +
        "Their workspace access, role and evidence are unaffected — this only removes " +
        "them from this Collaboration Team.",
      confirmLabel: "Remove from team",
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
          </div>
        </div>
      </td>
      <td data-label="Email">
        {/* An address is technical identity: LTR whatever the document direction. */}
        <span className="app-table__muted app-identity">
          {member.user.email ?? "Not shown"}
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
          <AppStatusText tone="slate">{member.role}</AppStatusText>
        )}
      </td>
      <td data-label="Status">
        <AppStatusText tone={memberStatusTone(member.status)}>
          {member.status}
        </AppStatusText>
      </td>
      <td data-label="Joined">
        <span className="app-table__muted">
          {formatUserDate(member.joinedAt)}
        </span>
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
                    // Scope, not object. Workspace removal is a Members &
                    // Access governance action and never happens from here.
                    : "Remove from this team (workspace access is unaffected)"
                }
              >
                Remove from team
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

// =============================================================================
// Add an existing workspace member to this group
//
// WORKSPACE AND COLLABORATION ARCHITECTURE RECONCILIATION — the two operations
// are separate and only one of them belongs here.
//
//   (A) Invite a PERSON INTO THE WORKSPACE — one invitation authority, one
//       seat claim, done in Teams › Members (workspace settings).
//   (B) Assign an EXISTING ACTIVE WORKSPACE MEMBER to a group — this panel.
//
// A group is not a seat pool: someone already in the workspace consumes
// nothing by joining a group, and the same person in five groups is still one
// seat. So this reads the workspace directory (`eligible-members`, which the
// server filters to ACTIVE workspace members not already in this group) rather
// than offering an email field that would mint a second invitation.
// =============================================================================
function AddMemberPanel({
  team,
  onRefresh,
  onClose,
}: {
  team: CollaborationTeamDetail;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const { addToast } = useToast();
  // The workspace this group belongs to — the subject of the canonical
  // invitation flow this panel hands off to. It names a destination and
  // authorizes nothing; `/teams/:id` re-checks membership server-side.
  const { activeWorkspaceId } = usePlatformContext();
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [eligible, setEligible] = useState<
    ReadonlyArray<EligibleWorkspaceMember>
  >([]);
  // Keyed by id rather than by the visible page, so a search does not discard
  // a selection the operator already made.
  const [selectedUserIds, setSelectedUserIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [role, setRole] = useState<CollaborationTeamRole>("MEMBER");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const handle = setTimeout(() => {
      void listEligibleMembers(team.id, { search, limit: 25 })
        .then((page) => {
          if (cancelled) return;
          setEligible(page.members);
          // Nothing is pre-selected any more. A radio group had to default to
          // somebody, so an operator who pressed Add without looking added
          // whoever happened to sort first.
        })
        .catch((err) => {
          if (cancelled) return;
          setEligible([]);
          notifyApiError(addToast, err, {
            message: "Could not load workspace members.",
          });
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [team.id, search, addToast]);

  const submit = async () => {
    const ids = Array.from(selectedUserIds);
    if (ids.length === 0 || busy) return;
    setBusy(true);
    try {
      if (ids.length === 1) {
        // One person still takes the single-member endpoint — same writer, and
        // its refusal carries a message worth showing verbatim.
        await addExistingMember(team.id, { userId: ids[0], role });
        await onRefresh();
        addToast("Added to this team.", "success");
        onClose();
        return;
      }
      const { added, failed } = await addExistingMembersBulk(team.id, {
        userIds: ids,
        role,
      });
      await onRefresh();
      /**
       * PARTIAL SUCCESS IS REPORTED, NOT ROUNDED.
       *
       * Adding eight people where the group's ceiling stops at six is an
       * ordinary condition, and both halves of it are facts the operator needs:
       * a plain "added" would hide two people who are not in the team, and a
       * plain error would hide six who now are.
       */
      if (failed.length === 0) {
        addToast(`Added ${added.length} people to this team.`, "success");
        onClose();
      } else {
        addToast(
          `Added ${added.length}. ${failed.length} could not be added — the team may be at its member limit.`,
          added.length > 0 ? "info" : "error",
        );
        // Keep the panel open with the failures still ticked, so the operator
        // can see exactly who did not make it in.
        setSelectedUserIds(new Set(failed.map((f) => f.userId)));
      }
    } catch (err) {
      // The server is the authority on capacity and on who may be added; a
      // refusal is shown exactly as it was given, never guessed at here.
      notifyApiError(addToast, err, {
        message: "Could not add these people to the team.",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="app-panel__body"
      data-testid="add-member-panel"
      style={{
        border: "1px solid var(--app-border, rgba(15,23,42,0.10))",
        borderRadius: 12,
        marginBottom: "0.9rem",
        padding: "0.9rem",
      }}
    >
      {/*
        THE HANDOFF TO THE CANONICAL WORKSPACE INVITATION.

        This sentence pointed at `/teams`, which 308s to
        `/collaboration-teams` — so the one link in the product that said
        "invite them in workspace members" returned the operator to the page
        they were already on. It now names the Workspace People surface
        through the single locator that knows how to name it.

        A group is not an invitation authority: it is built from people who
        already hold workspace access, so the only correct thing this panel can
        do for a person who is not in the workspace yet is hand them to the
        canonical workspace invitation flow. That is a LINK, not a second
        writer.
      */}
      <p className="app-table__muted" style={{ marginTop: 0 }}>
        People who already have access to this workspace. To bring someone new
        into the workspace, invite them in{" "}
        <Link href={buildWorkspacePeopleHref(activeWorkspaceId)}>
          workspace people
        </Link>{" "}
        first.
      </p>

      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search this workspace"
        aria-label="Search workspace members"
        data-testid="add-member-search"
        className="cases-filter-search"
        style={{ width: "100%", marginBottom: "0.7rem" }}
      />

      {loading ? (
        <p className="app-table__muted" data-testid="add-member-loading">
          Loading…
        </p>
      ) : eligible.length === 0 ? (
        /*
          A DEAD END NEEDS A DOOR.

          Both empty cases used to be a single grey sentence. The one that
          matters operationally — "everyone in this workspace is already in
          this team" — is exactly the moment an operator needs to bring
          somebody NEW in, and the panel offered them nothing to press. On a
          PRO workspace holding one person that is the FIRST state anyone sees.

          The action is a LINK into the canonical workspace invitation flow.
          This panel gains no invitation writer, no email field and no second
          seat accounting; it hands the job to the one surface that owns it.
        */
        <div data-testid="add-member-empty">
          <p className="app-table__muted" style={{ marginTop: 0 }}>
            {search.trim()
              ? "Nobody in this workspace matches that."
              : "Everyone in this workspace is already in this team."}
          </p>
          {search.trim() ? null : (
            <Link
              href={buildWorkspaceInviteHref(activeWorkspaceId)}
              className="app-secondary-action"
              data-testid="add-member-invite-to-workspace"
            >
              Invite someone to the workspace
            </Link>
          )}
        </div>
      ) : (
        <ul
          data-testid="add-member-candidates"
          style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: 260, overflowY: "auto" }}
        >
          {eligible.map((candidate) => (
            <li key={candidate.userId}>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "0.45rem 0.2rem",
                  cursor: "pointer",
                }}
              >
                {/*
                  MULTI-SELECT.

                  This was a radio group — one person per submit — so building
                  a group of twelve took twelve round trips through a search
                  box that reset each time. On a workspace where people arrive
                  in SSO or SCIM cohorts that is not a workflow anyone performs
                  twice.

                  Selection survives a search change on purpose: an operator
                  ticks three people, searches for a fourth, and the first
                  three are still selected. That is why the set is keyed by id
                  rather than derived from the visible page.
                */}
                <input
                  type="checkbox"
                  className="app-checkbox"
                  name="add-member-candidate"
                  value={candidate.userId}
                  checked={selectedUserIds.has(candidate.userId)}
                  onChange={(e) =>
                    setSelectedUserIds((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(candidate.userId);
                      else next.delete(candidate.userId);
                      return next;
                    })
                  }
                  data-testid={`add-member-candidate-${candidate.userId}`}
                />
                <span className="app-avatar" aria-hidden>
                  {(candidate.displayName[0] ?? "?").toUpperCase()}
                </span>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: "block" }}>
                    {candidate.displayName}
                  </span>
                  {candidate.email ? (
                    <span className="app-table__muted app-identity">{candidate.email}</span>
                  ) : null}
                </span>
                <AppStatusBadge tone="slate">
                  {candidate.workspaceRole}
                </AppStatusBadge>
              </label>
            </li>
          ))}
        </ul>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginTop: "0.8rem",
          flexWrap: "wrap",
        }}
      >
        <span className="app-table__muted">Role in this team</span>
        <div style={{ minWidth: 148 }}>
          <AppListbox<CollaborationTeamRole>
            value={role}
            options={COLLABORATION_TEAM_ROLES.map((r) => ({
              value: r,
              label: r,
            }))}
            onChange={setRole}
            disabled={busy}
            ariaLabel="Role in this team"
          />
        </div>
        <input
          type="hidden"
          data-testid="add-member-role"
          value={role}
          readOnly
        />
        <button
          type="button"
          className="app-primary-action"
          onClick={() => void submit()}
          disabled={busy || selectedUserIds.size === 0}
          data-testid="add-member-submit"
        >
          {selectedUserIds.size > 1
            ? `Add ${selectedUserIds.size} to team`
            : "Add to team"}
        </button>
        <button
          type="button"
          className="app-ghost-action"
          onClick={onClose}
          disabled={busy}
          data-testid="add-member-cancel"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export { MembersTab };
