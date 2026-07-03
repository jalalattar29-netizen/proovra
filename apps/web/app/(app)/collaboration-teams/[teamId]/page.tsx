/**
 * PROOVRA Phase 6 — Team detail page (with tabs).
 *
 * Route: `/collaboration-teams/[teamId]?tab=overview|members|invites|assignments|activity|settings`
 *
 * Single-page detail with query-string-driven tabs (Linear/GitHub
 * pattern). Permission gating is server-enforced; the UI reads
 * `viewerRole` from the detail response and disables actions the
 * viewer can't perform.
 */

"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { useToast } from "../../../../components/ui";
import { useConfirmAction } from "../../../../components/ui/ConfirmActionModal";
import { ApiError } from "../../../../lib/api";
import { formatUserDate, formatUserDateTime } from "../../../../lib/date";
import {
  type CollaborationTeamActivityItem,
  type CollaborationTeamAssignment,
  type CollaborationTeamDetail,
  type CollaborationTeamInvite,
  type CollaborationTeamMember,
  type CollaborationTeamLinkInviteSecret,
  archiveTeam,
  createAssignment,
  createInviteLink,
  getTeam,
  inviteByEmail,
  inviteBySms,
  listActivity,
  listAssignments,
  removeMember,
  revokeInvite,
  updateAssignment,
  updateMember,
  updateTeam,
} from "../../../../lib/api/collaboration-teams";
import {
  COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES,
  COLLABORATION_TEAM_ASSIGNMENT_STATUSES,
  COLLABORATION_TEAM_ASSIGNMENT_TARGETS,
  COLLABORATION_TEAM_ROLES,
  COLLABORATION_TEAM_TYPES,
  collaborationTeamRoleHasPermission,
  getCollaborationTeamPlanLimits,
  type CollaborationTeamActivityEventType,
  type CollaborationTeamAssignmentPriority,
  type CollaborationTeamAssignmentStatus,
  type CollaborationTeamAssignmentTarget,
  type CollaborationTeamPlanLimits,
  type CollaborationTeamRole,
  type CollaborationTeamType,
} from "@proovra/shared";
import {
  useAccount,
  useActiveSpace,
  useOrganizations,
  usePersonalSpace,
} from "../../../../lib/platform-context";
import type { WorkspacePlan } from "../../../../lib/platform-context/types";
import { useBillingSummary } from "../../../../lib/api/billing-summary";
import { PlanLimitBadge } from "../../../../components/billing/PlanLimitBadge";
import {
  PlanGateBadge,
  type PlanTier,
} from "../../../../components/billing/PlanGateBadge";

const TABS = [
  "overview",
  "members",
  "invites",
  "assignments",
  "activity",
  "settings",
] as const;
type TabId = (typeof TABS)[number];

export default function TeamDetailPage() {
  return (
    <PageRouteGate routeId="workspace.collaboration_team_detail">
      <TeamDetail />
    </PageRouteGate>
  );
}

function TeamDetail() {
  const params = useParams<{ teamId: string }>();
  const teamId = params?.teamId ?? "";
  const search = useSearchParams();
  const router = useRouter();

  const activeTab: TabId = useMemo(() => {
    const t = (search?.get("tab") as TabId) ?? "overview";
    return (TABS as ReadonlyArray<string>).includes(t)
      ? t
      : "overview";
  }, [search]);

  const [team, setTeam] = useState<CollaborationTeamDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(
    null,
  );

  const refresh = async () => {
    if (!teamId) return;
    setLoading(true);
    setError(null);
    try {
      const detail = await getTeam(teamId);
      setTeam(detail);
    } catch (err) {
      if (err instanceof ApiError) {
        setError({ message: err.message, requestId: err.requestId });
      } else {
        setError({ message: "Couldn't load Team." });
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [teamId]);

  // PROOVRA Phase 10 — header billing summary hook MUST be called at the
  // top level of the component, before any early return / loading / error
  // branch, so React's Rules of Hooks holds (hook call order must be
  // identical across renders regardless of which branch we take).
  // Consumed below in the header chips once `team` is loaded.
  const headerBillingSummary = useBillingSummary();

  if (loading && !team) {
    return (
      <main
        className="cc-page"
        data-testid="team-detail-loading"
        style={{ maxWidth: 960, margin: "0 auto" }}
      >
        <p style={{ color: "#5d6d71" }}>Loading Team…</p>
      </main>
    );
  }
  if (error || !team) {
    return (
      <main
        className="cc-page"
        data-testid="team-detail-error"
        style={{ maxWidth: 640, margin: "0 auto" }}
      >
        <header className="cc-page-header">
          <div>
            <div className="cc-kicker">Teams</div>
            <h1 className="cc-title">Couldn't load Team</h1>
            <p className="cc-subtitle">
              {error?.message ?? "Something went wrong."}
            </p>
            {error?.requestId ? (
              <p
                style={{
                  color: "#9b826b",
                  fontSize: "0.8rem",
                  fontFamily: "monospace",
                }}
              >
                Request id: {error.requestId}
              </p>
            ) : null}
          </div>
        </header>
        <Link href="/collaboration-teams" className="cases-filter-chip">
          Back to Teams
        </Link>
      </main>
    );
  }

  const canManage = collaborationTeamRoleHasPermission(
    team.viewerRole,
    "team.update_settings",
  );
  const canInvite = collaborationTeamRoleHasPermission(
    team.viewerRole,
    "team.member.invite",
  );
  const canAssign = collaborationTeamRoleHasPermission(
    team.viewerRole,
    "team.assignment.create",
  );

  // PROOVRA Phase 10 — header-level MEMBERS_USED chip + SMS_STATUS chip.
  // Read the same canonical envelope helper used across collaboration-teams
  // pages. The `MembersTab` keeps its own at-capacity logic; this is purely
  // an additive header surface so the user sees the cap before drilling in.
  //
  // NOTE: `headerBillingSummary` is captured by `useBillingSummary()` at the
  // top of the component (before early returns) per the React Rules of
  // Hooks. Only `activeMemberCountForBadge` (a plain derived value that
  // depends on `team`) is computed here.
  const activeMemberCountForBadge = team.members.filter(
    (m) => m.status === "ACTIVE",
  ).length;

  const goTab = (tab: TabId) =>
    router.push(`/collaboration-teams/${team.id}?tab=${tab}`);

  return (
    <main
      className="cc-page"
      data-testid="team-detail"
      data-team-id={team.id}
      data-team-status={team.status}
    >
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">
            <Link href="/collaboration-teams" style={{ color: "inherit" }}>
              Teams
            </Link>
            {" "}/{" "}
            <span>{team.teamType}</span>
          </div>
          <h1 className="cc-title">{team.name}</h1>
          {team.description ? (
            <p className="cc-subtitle">{team.description}</p>
          ) : (
            <p
              className="cc-subtitle"
              style={{ color: "#9b826b", fontStyle: "italic" }}
            >
              No description yet.
            </p>
          )}
        </div>
        <div className="cc-meta" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {headerBillingSummary ? (
            <PlanLimitBadge
              kind="MEMBERS_USED"
              current={activeMemberCountForBadge}
              max={headerBillingSummary.membersMax}
              planLabel={headerBillingSummary.plan}
            />
          ) : null}
          <Link
            href={`/collaboration-teams/${team.id}/collaboration`}
            className="cases-filter-chip"
            data-testid="collaboration-hub-link"
          >
            Collaboration hub
          </Link>
          {canInvite ? (
            <button
              type="button"
              className="cc-quick-action"
              onClick={() => goTab("invites")}
              data-testid="quick-invite-button"
            >
              Invite people
            </button>
          ) : null}
          {canManage ? (
            <button
              type="button"
              className="cases-filter-chip"
              onClick={() => goTab("settings")}
              data-testid="settings-button"
            >
              Settings
            </button>
          ) : null}
        </div>
      </header>

      <nav
        aria-label="Team sections"
        data-testid="team-tabs"
        style={{
          display: "flex",
          gap: "0.5rem",
          marginTop: "1rem",
          borderBottom: "1px solid rgba(79,112,107,0.18)",
          paddingBottom: "0.5rem",
          flexWrap: "wrap",
        }}
      >
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => goTab(t)}
            data-testid={`tab-${t}`}
            data-active={t === activeTab}
            aria-current={t === activeTab ? "page" : undefined}
            style={{
              padding: "8px 14px",
              borderRadius: 999,
              border: "1px solid transparent",
              background:
                t === activeTab
                  ? "linear-gradient(180deg, rgba(62,96,99,0.94) 0%, rgba(24,43,48,0.98) 100%)"
                  : "transparent",
              color: t === activeTab ? "#eef3f1" : "#5d6d71",
              cursor: "pointer",
              fontSize: "0.92rem",
              fontWeight: 500,
              textTransform: "capitalize",
            }}
          >
            {t}
          </button>
        ))}
      </nav>

      <div style={{ marginTop: "1.5rem" }}>
        {activeTab === "overview" ? (
          <OverviewTab team={team} onJumpTab={goTab} />
        ) : activeTab === "members" ? (
          <MembersTab
            team={team}
            onRefresh={refresh}
            canManage={canManage}
            canInvite={canInvite}
            onJumpTab={goTab}
          />
        ) : activeTab === "invites" ? (
          <InvitesTab team={team} onRefresh={refresh} canInvite={canInvite} />
        ) : activeTab === "assignments" ? (
          <AssignmentsTab team={team} canAssign={canAssign} />
        ) : activeTab === "activity" ? (
          <ActivityTab team={team} />
        ) : activeTab === "settings" ? (
          <SettingsTab
            team={team}
            onChange={refresh}
            canManage={canManage}
            canArchive={collaborationTeamRoleHasPermission(
              team.viewerRole,
              "team.archive",
            )}
          />
        ) : null}
      </div>
    </main>
  );
}

// =============================================================================
// Overview tab
// =============================================================================

function OverviewTab({
  team,
  onJumpTab,
}: {
  team: CollaborationTeamDetail;
  onJumpTab: (t: TabId) => void;
}) {
  const activeMembers = team.members.filter((m) => m.status === "ACTIVE");
  const pendingInvites = team.invites.filter((i) => i.status === "PENDING");

  return (
    <section
      data-testid="tab-overview-content"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: "1rem",
      }}
    >
      <StatCard
        label="Active members"
        value={activeMembers.length}
        onClick={() => onJumpTab("members")}
      />
      <StatCard
        label="Pending invites"
        value={pendingInvites.length}
        onClick={() => onJumpTab("invites")}
      />
      <StatCard
        label="Open assignments"
        value={team.assignmentCount}
        onClick={() => onJumpTab("assignments")}
      />
      <StatCard
        label="Your role"
        value={team.viewerRole}
        valueStyle={{ textTransform: "uppercase", fontSize: "1rem" }}
      />
    </section>
  );
}

function StatCard({
  label,
  value,
  valueStyle,
  onClick,
}: {
  label: string;
  value: number | string;
  valueStyle?: React.CSSProperties;
  onClick?: () => void;
}) {
  const node = (
    <div
      style={{
        border: "1px solid rgba(79,112,107,0.14)",
        borderRadius: 14,
        padding: "1.1rem",
        background: "rgba(255,255,255,0.7)",
        cursor: onClick ? "pointer" : "default",
      }}
    >
      <div
        style={{
          color: "#5d6d71",
          fontSize: "0.78rem",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: "0.5rem",
          fontSize: "1.7rem",
          fontWeight: 600,
          color: "#182b30",
          ...valueStyle,
        }}
      >
        {value}
      </div>
    </div>
  );
  return onClick ? (
    <button type="button" onClick={onClick} style={{ all: "unset" }}>
      {node}
    </button>
  ) : (
    node
  );
}

// =============================================================================
// Members tab
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
  // Phase 10 UX — visible per-team member capacity. The cap is derived
  // from the plan via the SAME shared SoT (`getCollaborationTeamPlanLimits`)
  // that backend billing-guards use, so this surface never disagrees with
  // the 409 the server would emit.  The plan is read from
  // `useAccount().accountPlan` (canonical envelope) — we never invent counts.
  const account = useAccount();
  const planForLimits: WorkspacePlan | null = account?.accountPlan ?? null;
  const limits: CollaborationTeamPlanLimits = useMemo(
    () => getCollaborationTeamPlanLimits(planForLimits),
    [planForLimits],
  );
  const activeMemberCount = team.members.filter(
    (m) => m.status === "ACTIVE",
  ).length;
  const maxMembersPerTeam = limits.maxMembersPerTeam;
  const atCapacity =
    planForLimits !== null && activeMemberCount >= maxMembersPerTeam;
  const capacityKnown = planForLimits !== null && maxMembersPerTeam > 0;
  return (
    <section data-testid="tab-members-content">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "0.75rem",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h2
            style={{ margin: 0, fontSize: "1.05rem", color: "#182b30" }}
          >
            Members ({activeMemberCount})
          </h2>
          {capacityKnown ? (
            <MemberCapacityBadge
              memberCount={activeMemberCount}
              maxMembersPerTeam={maxMembersPerTeam}
              atCapacity={atCapacity}
              plan={planForLimits}
            />
          ) : null}
        </div>
        {canInvite ? (
          <button
            type="button"
            className="cc-quick-action"
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
      {atCapacity ? (
        <div
          role="status"
          data-testid="members-at-capacity-notice"
          style={{
            background: "rgba(155,130,107,0.10)",
            border: "1px solid rgba(155,130,107,0.30)",
            color: "#7c2d2d",
            padding: "0.6rem 0.9rem",
            borderRadius: 10,
            marginBottom: "0.75rem",
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
            {planForLimits ? ` (${planForLimits})` : ""}. Upgrade to add more.
          </span>
          <Link
            href="/billing"
            className="cases-filter-chip"
            data-testid="members-at-capacity-upgrade"
          >
            Upgrade
          </Link>
        </div>
      ) : null}
      {team.members.length === 0 ? (
        <p style={{ color: "#5d6d71" }}>No members yet. Invite people →</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
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
              onError={(err) =>
                addToast(err.message, "error")
              }
            />
          ))}
        </ul>
      )}
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
  const tone = atCapacity
    ? { bg: "rgba(186,80,80,0.16)", fg: "#7c2d2d", border: "rgba(186,80,80,0.30)" }
    : { bg: "rgba(56,142,60,0.12)", fg: "#2e7d32", border: "rgba(56,142,60,0.30)" };
  const label = `${memberCount} of ${maxMembersPerTeam} members`;
  const planLabel = plan ? ` on plan ${plan}` : "";
  return (
    <span
      role="status"
      aria-label={
        atCapacity
          ? `Team is at capacity${planLabel}: ${label}. Upgrade to add more.`
          : `${label}${planLabel}.`
      }
      title={
        atCapacity
          ? "Team is at capacity for your plan. Upgrade to add more."
          : `Team member capacity${planLabel}.`
      }
      data-testid="member-capacity-badge"
      data-at-capacity={atCapacity ? "true" : "false"}
      style={{
        background: tone.bg,
        color: tone.fg,
        border: `1px solid ${tone.border}`,
        padding: "2px 10px",
        borderRadius: 999,
        fontSize: "0.78rem",
        fontWeight: 600,
        letterSpacing: "0.02em",
      }}
    >
      {label}
    </span>
  );
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

  return (
    <li
      data-testid={`member-row-${member.id}`}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "0.9rem 1rem",
        background: "rgba(255,255,255,0.7)",
        border: "1px solid rgba(79,112,107,0.12)",
        borderRadius: 12,
        marginBottom: "0.5rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div
          aria-hidden
          style={{
            width: 36,
            height: 36,
            borderRadius: "50%",
            background:
              "linear-gradient(135deg, rgba(62,96,99,0.85) 0%, rgba(24,43,48,0.95) 100%)",
            color: "#fff",
            fontWeight: 600,
            display: "grid",
            placeItems: "center",
            fontSize: 14,
          }}
        >
          {(displayName[0] ?? "?").toUpperCase()}
        </div>
        <div>
          <div style={{ fontWeight: 600, color: "#182b30" }}>{displayName}</div>
          <div style={{ color: "#5d6d71", fontSize: "0.82rem" }}>
            Joined {formatUserDate(member.joinedAt)}{" "}
            • {member.user.email ?? "no email"}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <StatusBadge status={member.status} />
        {canManage ? (
          <select
            value={member.role}
            onChange={(e) =>
              void onChangeRole(e.target.value as CollaborationTeamRole)
            }
            disabled={busy || isLastLead}
            data-testid={`member-role-select-${member.id}`}
            title={
              isLastLead
                ? "Cannot demote the last LEAD. Transfer leadership first."
                : "Change role"
            }
            style={selectStyle}
          >
            {COLLABORATION_TEAM_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        ) : (
          <span
            style={{
              ...selectStyle,
              border: "none",
              background: "transparent",
              color: "#5d6d71",
            }}
          >
            {member.role}
          </span>
        )}
        {canManage && member.status === "ACTIVE" ? (
          <>
            <button
              type="button"
              onClick={() => void onSuspend()}
              disabled={busy}
              className="cases-filter-chip"
              data-testid={`member-suspend-${member.id}`}
            >
              Suspend
            </button>
            <button
              type="button"
              onClick={() => void onRemove()}
              disabled={busy || isLastLead}
              className="cases-filter-chip"
              data-testid={`member-remove-${member.id}`}
              title={
                isLastLead
                  ? "Cannot remove the last LEAD."
                  : "Remove member"
              }
              style={{ color: "#7c2d2d" }}
            >
              Remove
            </button>
          </>
        ) : null}
      </div>
    </li>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === "ACTIVE"
      ? { bg: "rgba(56,142,60,0.12)", fg: "#2e7d32" }
      : status === "SUSPENDED"
        ? { bg: "rgba(155,130,107,0.18)", fg: "#9b826b" }
        : status === "REMOVED"
          ? { bg: "rgba(186,80,80,0.16)", fg: "#7c2d2d" }
          : { bg: "rgba(79,112,107,0.14)", fg: "#3e6063" };
  return (
    <span
      style={{
        background: color.bg,
        color: color.fg,
        padding: "2px 10px",
        borderRadius: 999,
        fontSize: "0.72rem",
        fontWeight: 600,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
      }}
    >
      {status}
    </span>
  );
}

// =============================================================================
// Invites tab
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
  const [linkSecret, setLinkSecret] =
    useState<CollaborationTeamLinkInviteSecret | null>(null);

  const onError = (err: { message: string; requestId?: string }) =>
    addToast(`${err.message}${err.requestId ? ` (req ${err.requestId})` : ""}`, "error");

  return (
    <section data-testid="tab-invites-content">
      <h2 style={{ margin: 0, fontSize: "1.05rem", color: "#182b30" }}>
        Invite people
      </h2>
      <p style={{ color: "#5d6d71", marginTop: 4 }}>
        Invite collaborators by email, SMS, or a sharable link.
        Invitees must also join the parent workspace to accept.
      </p>

      {canInvite ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: "1rem",
            marginTop: "1rem",
          }}
        >
          <EmailInviteCard
            teamId={team.id}
            onSent={() => {
              addToast("Email invite sent.", "success");
              void onRefresh();
            }}
            onError={onError}
          />
          <SmsInviteCard
            teamId={team.id}
            onSent={() => {
              addToast("SMS invite sent.", "success");
              void onRefresh();
            }}
            onError={onError}
          />
          <LinkInviteCard
            teamId={team.id}
            onCreated={(secret) => {
              setLinkSecret(secret);
              void onRefresh();
            }}
            onError={onError}
          />
        </div>
      ) : (
        <p
          style={{
            color: "#9b826b",
            background: "rgba(155,130,107,0.10)",
            padding: "1rem",
            borderRadius: 10,
            marginTop: "1rem",
          }}
          data-testid="invites-permission-denied"
        >
          Only LEAD and ADMIN can issue invitations. Ask a team lead.
        </p>
      )}

      {linkSecret ? (
        <LinkInviteResult
          secret={linkSecret}
          onClose={() => setLinkSecret(null)}
        />
      ) : null}

      <PendingInvitesBadge invites={team.invites} />

      <h3
        style={{
          marginTop: "2rem",
          marginBottom: "0.75rem",
          fontSize: "0.98rem",
          color: "#182b30",
        }}
      >
        Pending & recent invites
      </h3>
      {team.invites.length === 0 ? (
        <p style={{ color: "#5d6d71" }}>No invites yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
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
        </ul>
      )}
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
      style={cardStyle}
    >
      <h4 style={cardTitle}>Email invite</h4>
      <label style={labelStyle}>
        Email
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          placeholder="teammate@firm.com"
          data-testid="email-invite-email"
          style={inputStyle}
        />
      </label>
      <RoleSelect
        value={role}
        onChange={setRole}
        data-testid-prefix="email"
      />
      <ExpirySelect value={days} onChange={setDays} />
      <button
        type="submit"
        disabled={!email || busy}
        className="cc-quick-action"
        data-testid="email-invite-submit"
        style={{ marginTop: "0.5rem" }}
      >
        {busy ? "Sending…" : "Send email invite"}
      </button>
    </form>
  );
}

function SmsInviteCard({
  teamId,
  onSent,
  onError,
}: {
  teamId: string;
  onSent: () => void;
  onError: (err: { message: string; requestId?: string }) => void;
}) {
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<CollaborationTeamRole>("MEMBER");
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  // PROOVRA Phase 10 — read SMS gating from the canonical plan limits
  // derived from `/v1/platform-context` (no fabricated counts). When
  // limits is still null (envelope loading) we leave the form active —
  // the backend `billing-guards` remain the source of truth.
  const limits = useResolvedCollaborationTeamPlanLimits();
  const currentPlan = useResolvedActivePlanTier();
  const smsGated = limits !== null && limits.smsInvitesEnabled === false;
  const disabledTitle = smsGated
    ? "SMS invites are not included in your current plan — upgrade to PAYG or above to enable this channel."
    : undefined;
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (smsGated || !phone || busy) return;
        setBusy(true);
        try {
          await inviteBySms(teamId, { phone, role, expiresInDays: days });
          setPhone("");
          onSent();
        } catch (err) {
          if (err instanceof ApiError) {
            onError({ message: err.message, requestId: err.requestId });
          } else {
            onError({ message: "Couldn't send SMS invite." });
          }
        } finally {
          setBusy(false);
        }
      }}
      data-testid="sms-invite-form"
      data-plan-gated={smsGated ? "true" : "false"}
      aria-disabled={smsGated ? true : undefined}
      style={{
        ...cardStyle,
        opacity: smsGated ? 0.62 : 1,
      }}
    >
      <h4 style={cardTitle}>SMS invite</h4>
      <label style={labelStyle}>
        Phone (E.164)
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          required={!smsGated}
          disabled={smsGated}
          placeholder="+12025550100"
          pattern="^\+[1-9]\d{7,14}$"
          data-testid="sms-invite-phone"
          aria-label={smsGated ? disabledTitle : undefined}
          style={inputStyle}
        />
      </label>
      <RoleSelect value={role} onChange={setRole} data-testid-prefix="sms" />
      <ExpirySelect value={days} onChange={setDays} />
      <SmsStatusChip smsIncluded={!smsGated} />
      <button
        type="submit"
        disabled={smsGated || !phone || busy}
        className="cc-quick-action"
        data-testid="sms-invite-submit"
        title={disabledTitle}
        aria-label={smsGated ? disabledTitle : undefined}
        style={{ marginTop: "0.5rem" }}
      >
        {busy ? "Sending…" : "Send SMS invite"}
      </button>
      {smsGated ? (
        <PlanGateBadge
          feature="SMS invites"
          requiredPlan="PAYG"
          currentPlan={currentPlan}
          upgradeCtaHref="/billing"
        />
      ) : (
        <p style={{ fontSize: "0.78rem", color: "#9b826b", marginTop: 6 }}>
          SMS invites are available on PAYG and above.
        </p>
      )}
    </form>
  );
}

/**
 * PROOVRA Phase 10 — additive small SMS_STATUS chip rendered above the
 * SmsInviteCard submit button. Single source of truth: derives from the
 * canonical billing summary. Renders bounded copy ("Included in Team
 * plan" / "Upgrade to Team plan for SMS"). Never replaces the
 * pre-existing PlanGateBadge — strictly additive.
 */
function SmsStatusChip({ smsIncluded }: { smsIncluded: boolean }): JSX.Element | null {
  const summary = useBillingSummary();
  if (!summary) return null;
  const planLabel = summary.plan;
  return (
    <span
      data-testid="sms-status-chip"
      data-included={smsIncluded ? "true" : "false"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 10px",
        borderRadius: 999,
        fontSize: "0.72rem",
        fontWeight: 600,
        letterSpacing: "0.02em",
        background: smsIncluded
          ? "rgba(56,142,60,0.12)"
          : "rgba(155,130,107,0.14)",
        color: smsIncluded ? "#2e7d32" : "#9b826b",
        border: `1px solid ${
          smsIncluded ? "rgba(56,142,60,0.30)" : "rgba(155,130,107,0.30)"
        }`,
        marginTop: 6,
        alignSelf: "flex-start",
      }}
      title={
        smsIncluded
          ? `Included in ${planLabel} plan`
          : "Upgrade to Team plan for SMS"
      }
    >
      {smsIncluded
        ? `Included in ${planLabel} plan`
        : "Upgrade to Team plan for SMS"}
    </span>
  );
}

function LinkInviteCard({
  teamId,
  onCreated,
  onError,
}: {
  teamId: string;
  onCreated: (s: CollaborationTeamLinkInviteSecret) => void;
  onError: (err: { message: string; requestId?: string }) => void;
}) {
  const [role, setRole] = useState<CollaborationTeamRole>("MEMBER");
  const [maxUses, setMaxUses] = useState(1);
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  // PROOVRA Phase 10 — link-invite gating mirrors the SMS gate above.
  // The backend `billing-guards` are authoritative; this is UX-only.
  const limits = useResolvedCollaborationTeamPlanLimits();
  const currentPlan = useResolvedActivePlanTier();
  const linkGated = limits !== null && limits.linkInvitesEnabled === false;
  const disabledTitle = linkGated
    ? "Sharable invite links are not included in your current plan — upgrade to enable this channel."
    : undefined;
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (linkGated || busy) return;
        setBusy(true);
        try {
          const secret = await createInviteLink(teamId, {
            role,
            maxUses,
            expiresInDays: days,
          });
          onCreated(secret);
        } catch (err) {
          if (err instanceof ApiError) {
            onError({ message: err.message, requestId: err.requestId });
          } else {
            onError({ message: "Couldn't generate invite link." });
          }
        } finally {
          setBusy(false);
        }
      }}
      data-testid="link-invite-form"
      data-plan-gated={linkGated ? "true" : "false"}
      aria-disabled={linkGated ? true : undefined}
      style={{
        ...cardStyle,
        opacity: linkGated ? 0.62 : 1,
      }}
    >
      <h4 style={cardTitle}>Sharable link</h4>
      <RoleSelect value={role} onChange={setRole} data-testid-prefix="link" />
      <label style={labelStyle}>
        Max uses
        <input
          type="number"
          min={1}
          max={1000}
          value={maxUses}
          onChange={(e) => setMaxUses(parseInt(e.target.value || "1", 10))}
          disabled={linkGated}
          data-testid="link-invite-max-uses"
          aria-label={linkGated ? disabledTitle : undefined}
          style={inputStyle}
        />
      </label>
      <ExpirySelect value={days} onChange={setDays} />
      <button
        type="submit"
        disabled={linkGated || busy}
        className="cc-quick-action"
        data-testid="link-invite-submit"
        title={disabledTitle}
        aria-label={linkGated ? disabledTitle : undefined}
        style={{ marginTop: "0.5rem" }}
      >
        {busy ? "Generating…" : "Generate link"}
      </button>
      {linkGated ? (
        <PlanGateBadge
          feature="Sharable invite links"
          requiredPlan="PAYG"
          currentPlan={currentPlan}
          upgradeCtaHref="/billing"
        />
      ) : (
        <p style={{ fontSize: "0.78rem", color: "#9b826b", marginTop: 6 }}>
          The link is shown ONCE — copy it before closing the panel.
        </p>
      )}
    </form>
  );
}

function LinkInviteResult({
  secret,
  onClose,
}: {
  secret: CollaborationTeamLinkInviteSecret;
  onClose: () => void;
}) {
  const { addToast } = useToast();
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(secret.acceptUrl);
        setCopied(true);
        addToast("Invite link copied.", "success");
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      addToast("Couldn't copy. Select the link manually.", "error");
    }
  };
  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid="link-invite-result"
      style={{
        marginTop: "1rem",
        border: "1px solid rgba(62,96,99,0.30)",
        background: "rgba(243,245,242,0.94)",
        borderRadius: 14,
        padding: "1.25rem",
      }}
    >
      <h4 style={{ margin: 0, color: "#182b30" }}>
        Your invite link (visible once)
      </h4>
      <p style={{ color: "#5d6d71", marginTop: 6, fontSize: "0.9rem" }}>
        Copy this link and share it with the people you want to invite.
        It expires {new Date(secret.expiresAtUtc).toUTCString()} and
        accepts up to {secret.maxUses} use{secret.maxUses === 1 ? "" : "s"}.
      </p>
      <div
        style={{
          display: "flex",
          gap: 8,
          marginTop: "0.75rem",
          alignItems: "center",
        }}
      >
        <input
          readOnly
          value={secret.acceptUrl}
          data-testid="link-invite-url"
          style={{ ...inputStyle, fontFamily: "monospace", fontSize: "0.85rem" }}
        />
        <button
          type="button"
          onClick={() => void onCopy()}
          className="cc-quick-action"
          data-testid="link-invite-copy"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <div style={{ marginTop: "0.5rem" }}>
        <button type="button" onClick={onClose} className="cases-filter-chip">
          Done
        </button>
      </div>
    </div>
  );
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
  const recipient =
    invite.email ??
    invite.phone ??
    (invite.channel === "LINK" ? `link · ${invite.useCount}/${invite.maxUses}` : "—");
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
    <li
      data-testid={`invite-row-${invite.id}`}
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
        padding: "0.7rem 1rem",
        background: "rgba(255,255,255,0.65)",
        border: "1px solid rgba(79,112,107,0.10)",
        borderRadius: 10,
        marginBottom: "0.4rem",
      }}
    >
      <div>
        <div style={{ fontWeight: 600, color: "#182b30" }}>{recipient}</div>
        <div style={{ color: "#5d6d71", fontSize: "0.78rem" }}>
          {invite.channel} • {invite.role} • expires{" "}
          {formatUserDate(invite.expiresAtUtc)}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <StatusBadge status={invite.status} />
        <span
          style={{
            fontSize: "0.72rem",
            color: "#9b826b",
            textTransform: "uppercase",
          }}
        >
          delivery: {invite.deliveryStatus.toLowerCase()}
        </span>
        {canManage && invite.status === "PENDING" ? (
          <button
            type="button"
            onClick={() => void onRevoke()}
            disabled={busy}
            className="cases-filter-chip"
            data-testid={`invite-revoke-${invite.id}`}
            style={{ color: "#7c2d2d" }}
          >
            Revoke
          </button>
        ) : null}
      </div>
    </li>
  );
}

// -----------------------------------------------------------------------------
// PendingInvitesBadge — Phase 10 UX addition.
//
// Surfaces the per-team invite caps (`maxPendingInvitesPerTeam`,
// `maxInvitesPer24h`) BEFORE the user hits the 429 rate-limit from
// `assertCanInviteCollaborationTeamMember` (services/api/.../billing-guards.ts).
//
// Data sources (NO new endpoint):
//   - Counts are derived from `team.invites` already on the detail payload.
//   - Caps are resolved from the canonical `getCollaborationTeamPlanLimits`
//     against the plan exposed by /v1/platform-context (account /
//     personal-space / organization), via the canonical tenant-model hooks.
//     We do NOT fabricate caps and we do NOT re-fetch billing.
//
// Upgrade CTA points at the canonical billing surface (/billing).
// -----------------------------------------------------------------------------
function PendingInvitesBadge({
  invites,
}: {
  invites: ReadonlyArray<CollaborationTeamInvite>;
}) {
  const limits = useResolvedCollaborationTeamPlanLimits();

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
        marginTop: "1.5rem",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 10,
      }}
    >
      <span
        data-testid="pending-invites-count"
        title={
          pendingAtCap
            ? "Pending-invite cap reached. Revoke a pending invite or upgrade your plan to send more."
            : "Pending invites count toward your plan's per-team cap."
        }
        aria-label={pendingLabel}
        style={badgeStyle(pendingAtCap)}
      >
        {pendingLabel}
      </span>
      <span
        data-testid="invites-rate-count"
        title={
          rateAtCap
            ? "24h invite rate limit reached. Wait for the window to reset or upgrade your plan."
            : "Invites sent in the last 24 hours, all channels combined."
        }
        aria-label={rateLabel}
        style={badgeStyle(rateAtCap)}
      >
        {rateLabel}
      </span>
      {anyAtCap ? (
        <Link
          href="/billing"
          data-testid="pending-invites-upgrade-cta"
          aria-label={
            pendingAtCap
              ? "Pending-invite cap reached — upgrade plan"
              : "24h invite rate limit reached — upgrade plan"
          }
          className="cases-filter-chip"
          style={{
            color: "#7c2d2d",
            borderColor: "rgba(186,80,80,0.35)",
          }}
        >
          Upgrade plan
        </Link>
      ) : null}
    </div>
  );
}

function badgeStyle(atCap: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "4px 12px",
    borderRadius: 999,
    fontSize: "0.78rem",
    fontWeight: 600,
    letterSpacing: "0.02em",
    background: atCap ? "rgba(186,80,80,0.12)" : "rgba(79,112,107,0.10)",
    color: atCap ? "#7c2d2d" : "#3e6063",
    border: `1px solid ${
      atCap ? "rgba(186,80,80,0.30)" : "rgba(79,112,107,0.20)"
    }`,
  };
}

/**
 * Resolve the active-space plan from the canonical envelope hooks and
 * return the matching `CollaborationTeamPlanLimits`. Returns `null` while
 * the envelope is still loading so the badge does not show a fabricated
 * denominator.
 *
 * Plan-resolution order (matches the backend `resolveCollaborationTeamOwnerUserId`
 * → `resolveUserPlan` chain):
 *   1. Active organization's plan when an org is the active space.
 *   2. Personal-space plan when the active space is personal.
 *   3. Account-level plan fallback.
 */
function useResolvedCollaborationTeamPlanLimits():
  | CollaborationTeamPlanLimits
  | null {
  const account = useAccount();
  const personalSpace = usePersonalSpace();
  const activeSpace = useActiveSpace();
  const organizations = useOrganizations();

  const plan: WorkspacePlan | null = useMemo(() => {
    if (!activeSpace) return account?.accountPlan ?? null;
    if (activeSpace.type === "ORGANIZATION") {
      const org = organizations.find((o) => o.id === activeSpace.id);
      return org?.plan ?? account?.accountPlan ?? null;
    }
    return personalSpace?.plan ?? account?.accountPlan ?? null;
  }, [account, activeSpace, organizations, personalSpace]);

  if (plan === null) return null;
  return getCollaborationTeamPlanLimits(plan);
}

/**
 * Phase 10 — sibling hook returning the resolved active plan tier as
 * the canonical {@link PlanTier} vocabulary used by `PlanGateBadge`.
 * `null` indicates the envelope hasn't resolved a plan yet (degraded
 * billing context) — call sites must render an "unknown" gate state
 * rather than fabricating FREE.
 */
function useResolvedActivePlanTier(): PlanTier | null {
  const account = useAccount();
  const personalSpace = usePersonalSpace();
  const activeSpace = useActiveSpace();
  const organizations = useOrganizations();

  return useMemo<PlanTier | null>(() => {
    let plan: WorkspacePlan | null;
    if (!activeSpace) {
      plan = account?.accountPlan ?? null;
    } else if (activeSpace.type === "ORGANIZATION") {
      const org = organizations.find((o) => o.id === activeSpace.id);
      plan = org?.plan ?? account?.accountPlan ?? null;
    } else {
      plan = personalSpace?.plan ?? account?.accountPlan ?? null;
    }
    if (plan === null) return null;
    // WorkspacePlan vocabulary ("FREE" | "PAYG" | "PRO" | "TEAM") is a
    // strict subset of PlanTier — no ENTERPRISE today. Narrow safely.
    return plan as PlanTier;
  }, [account, activeSpace, organizations, personalSpace]);
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
  return (
    <label style={labelStyle}>
      Role
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as CollaborationTeamRole)}
        style={inputStyle}
        data-testid={prefix ? `${prefix}-invite-role` : undefined}
      >
        {COLLABORATION_TEAM_ROLES.map((r) => (
          <option key={r} value={r}>
            {r} — {roleHelp(r)}
          </option>
        ))}
      </select>
    </label>
  );
}

function ExpirySelect({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label style={labelStyle}>
      Expires in
      <select
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        style={inputStyle}
      >
        <option value={1}>1 day</option>
        <option value={3}>3 days</option>
        <option value={7}>7 days</option>
        <option value={14}>14 days</option>
        <option value={30}>30 days</option>
      </select>
    </label>
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
// Assignments tab
// =============================================================================

function AssignmentsTab({
  team,
  canAssign,
}: {
  team: CollaborationTeamDetail;
  canAssign: boolean;
}) {
  const { addToast } = useToast();
  const [items, setItems] =
    useState<ReadonlyArray<CollaborationTeamAssignment>>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] =
    useState<CollaborationTeamAssignmentStatus | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const rows = await listAssignments(team.id, { status: statusFilter });
      setItems(rows);
    } catch (err) {
      if (err instanceof ApiError) {
        addToast(`Couldn't load assignments (${err.requestId ?? "—"})`, "error");
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [team.id, statusFilter]);

  return (
    <section data-testid="tab-assignments-content">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "0.75rem",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: "1.05rem", color: "#182b30" }}>
            Assignments
          </h2>
          <select
            value={statusFilter ?? ""}
            onChange={(e) =>
              setStatusFilter(
                (e.target.value as CollaborationTeamAssignmentStatus) || null,
              )
            }
            data-testid="assignment-status-filter"
            style={selectStyle}
          >
            <option value="">All statuses</option>
            {COLLABORATION_TEAM_ASSIGNMENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        {canAssign ? (
          <button
            type="button"
            className="cc-quick-action"
            onClick={() => setCreating(true)}
            data-testid="create-assignment-button"
          >
            Create assignment
          </button>
        ) : null}
      </div>

      {loading ? (
        <p style={{ color: "#5d6d71" }}>Loading assignments…</p>
      ) : items.length === 0 ? (
        <p style={{ color: "#5d6d71" }}>
          No assignments {statusFilter ? `in ${statusFilter}` : "yet"}.
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {items.map((a) => (
            <AssignmentRow
              key={a.id}
              assignment={a}
              teamId={team.id}
              canAssign={canAssign}
              members={team.members}
              onChanged={async (msg) => {
                addToast(msg, "success");
                await refresh();
              }}
              onError={(err) =>
                addToast(
                  `${err.message}${err.requestId ? ` (req ${err.requestId})` : ""}`,
                  "error",
                )
              }
            />
          ))}
        </ul>
      )}

      {creating ? (
        <CreateAssignmentModal
          team={team}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            addToast("Assignment created.", "success");
            await refresh();
          }}
        />
      ) : null}
    </section>
  );
}

function AssignmentRow({
  assignment,
  teamId,
  canAssign,
  members,
  onChanged,
  onError,
}: {
  assignment: CollaborationTeamAssignment;
  teamId: string;
  canAssign: boolean;
  members: ReadonlyArray<CollaborationTeamMember>;
  onChanged: (msg: string) => void | Promise<void>;
  onError: (err: { message: string; requestId?: string }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const assignee = members.find((m) => m.userId === assignment.assigneeUserId);
  const assigneeLabel = assignee
    ? assignee.user.displayName ||
      assignee.user.email ||
      assignee.userId.slice(0, 8)
    : "Team-level";

  const update = async (
    patch: Parameters<typeof updateAssignment>[2],
    msg: string,
  ) => {
    setBusy(true);
    try {
      await updateAssignment(teamId, assignment.id, patch);
      await onChanged(msg);
    } catch (err) {
      if (err instanceof ApiError) {
        onError({ message: err.message, requestId: err.requestId });
      } else {
        onError({ message: "Couldn't update assignment." });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      data-testid={`assignment-row-${assignment.id}`}
      style={{
        padding: "0.85rem 1rem",
        background: "rgba(255,255,255,0.7)",
        border: "1px solid rgba(79,112,107,0.12)",
        borderRadius: 12,
        marginBottom: "0.5rem",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ fontWeight: 600, color: "#182b30" }}>
            {assignment.targetType} · {assignment.targetId.slice(0, 8)}…
          </div>
          <div style={{ color: "#5d6d71", fontSize: "0.82rem" }}>
            Assignee: {assigneeLabel} · Priority: {assignment.priority}
            {assignment.dueAtUtc
              ? ` · Due ${formatUserDate(assignment.dueAtUtc)}`
              : ""}
          </div>
          {assignment.note ? (
            <p
              style={{
                color: "#5d6d71",
                fontSize: "0.85rem",
                marginTop: 4,
              }}
            >
              {assignment.note}
            </p>
          ) : null}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <StatusBadge status={assignment.status} />
          {canAssign && assignment.status === "OPEN" ? (
            <>
              <button
                type="button"
                disabled={busy}
                className="cases-filter-chip"
                onClick={() =>
                  void update({ status: "IN_PROGRESS" }, "Marked in progress.")
                }
                data-testid={`assignment-start-${assignment.id}`}
              >
                Start
              </button>
              <button
                type="button"
                disabled={busy}
                className="cases-filter-chip"
                onClick={() =>
                  void update({ status: "COMPLETED" }, "Assignment completed.")
                }
                data-testid={`assignment-complete-${assignment.id}`}
              >
                Complete
              </button>
            </>
          ) : null}
          {canAssign && assignment.status === "IN_PROGRESS" ? (
            <button
              type="button"
              disabled={busy}
              className="cases-filter-chip"
              onClick={() =>
                void update({ status: "COMPLETED" }, "Assignment completed.")
              }
              data-testid={`assignment-complete-${assignment.id}`}
            >
              Complete
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function CreateAssignmentModal({
  team,
  onClose,
  onCreated,
}: {
  team: CollaborationTeamDetail;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const { addToast } = useToast();
  const [targetType, setTargetType] =
    useState<CollaborationTeamAssignmentTarget>("CASE");
  const [targetId, setTargetId] = useState("");
  const [assigneeUserId, setAssigneeUserId] = useState<string>("");
  const [priority, setPriority] =
    useState<CollaborationTeamAssignmentPriority>("NORMAL");
  const [dueAt, setDueAt] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetId || busy) return;
    setBusy(true);
    try {
      await createAssignment(team.id, {
        targetType,
        targetId,
        assigneeUserId: assigneeUserId || null,
        priority,
        dueAtUtc: dueAt ? new Date(dueAt).toISOString() : null,
        note: note || null,
      });
      await onCreated();
    } catch (err) {
      if (err instanceof ApiError) {
        addToast(`${err.message} (req ${err.requestId ?? "—"})`, "error");
      } else {
        addToast("Couldn't create assignment.", "error");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(24,43,48,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
        zIndex: 200,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={onSubmit}
        data-testid="create-assignment-modal"
        style={{
          background: "#fff",
          borderRadius: 20,
          padding: "1.5rem",
          maxWidth: 560,
          width: "100%",
          display: "flex",
          flexDirection: "column",
          gap: "0.75rem",
        }}
      >
        <h2 style={{ margin: 0 }}>Create assignment</h2>
        <label style={labelStyle}>
          Target type
          <select
            value={targetType}
            onChange={(e) =>
              setTargetType(e.target.value as CollaborationTeamAssignmentTarget)
            }
            style={inputStyle}
            data-testid="assignment-target-type"
          >
            {COLLABORATION_TEAM_ASSIGNMENT_TARGETS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label style={labelStyle}>
          Target id (case / evidence / review uuid)
          <input
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            required
            placeholder="00000000-0000-0000-0000-000000000000"
            data-testid="assignment-target-id"
            style={inputStyle}
          />
        </label>
        <label style={labelStyle}>
          Assignee
          <select
            value={assigneeUserId}
            onChange={(e) => setAssigneeUserId(e.target.value)}
            style={inputStyle}
            data-testid="assignment-assignee"
          >
            <option value="">Team-level (no specific assignee)</option>
            {team.members
              .filter((m) => m.status === "ACTIVE")
              .map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.user.displayName || m.user.email || m.userId.slice(0, 8)}
                </option>
              ))}
          </select>
        </label>
        <label style={labelStyle}>
          Priority
          <select
            value={priority}
            onChange={(e) =>
              setPriority(e.target.value as CollaborationTeamAssignmentPriority)
            }
            style={inputStyle}
            data-testid="assignment-priority"
          >
            {COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label style={labelStyle}>
          Due (optional)
          <input
            type="datetime-local"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
            data-testid="assignment-due"
            style={inputStyle}
          />
        </label>
        <label style={labelStyle}>
          Note (optional)
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={600}
            rows={3}
            data-testid="assignment-note"
            style={{ ...inputStyle, resize: "vertical" }}
          />
        </label>
        <footer style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="cases-filter-chip"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!targetId || busy}
            className="cc-quick-action"
            data-testid="assignment-submit"
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </footer>
      </form>
    </div>
  );
}

// =============================================================================
// Activity tab
// =============================================================================

function ActivityTab({ team }: { team: CollaborationTeamDetail }) {
  const [items, setItems] =
    useState<ReadonlyArray<CollaborationTeamActivityItem>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(
    null,
  );

  useEffect(() => {
    (async () => {
      try {
        const res = await listActivity(team.id, { limit: 100 });
        setItems(res.items);
      } catch (err) {
        if (err instanceof ApiError) {
          setError({ message: err.message, requestId: err.requestId });
        } else {
          setError({ message: "Couldn't load activity." });
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [team.id]);

  if (loading) return <p style={{ color: "#5d6d71" }}>Loading activity…</p>;
  if (error)
    return (
      <p style={{ color: "#7c2d2d" }} data-testid="activity-error">
        {error.message}
        {error.requestId ? ` (req ${error.requestId})` : ""}
      </p>
    );
  if (items.length === 0)
    return <p style={{ color: "#5d6d71" }}>No activity yet.</p>;

  return (
    <section data-testid="tab-activity-content">
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {items.map((a) => (
          <li
            key={a.id}
            data-testid={`activity-row-${a.id}`}
            style={{
              padding: "0.7rem 1rem",
              background: "rgba(255,255,255,0.6)",
              border: "1px solid rgba(79,112,107,0.10)",
              borderRadius: 10,
              marginBottom: "0.4rem",
              display: "flex",
              justifyContent: "space-between",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <div>
              <div style={{ color: "#182b30", fontWeight: 600 }}>
                {activityLabel(a.eventType)}
              </div>
              <div style={{ color: "#5d6d71", fontSize: "0.78rem" }}>
                {a.targetType ? `${a.targetType.toLowerCase()} · ` : ""}
                {formatUserDateTime(a.createdAt)}
              </div>
            </div>
            <code
              style={{
                color: "#9b826b",
                fontSize: "0.72rem",
                fontFamily: "monospace",
                alignSelf: "center",
              }}
            >
              {a.eventType}
            </code>
          </li>
        ))}
      </ul>
    </section>
  );
}

function activityLabel(e: CollaborationTeamActivityEventType): string {
  switch (e) {
    case "TEAM_CREATED": return "Team created";
    case "TEAM_RENAMED": return "Team renamed";
    case "TEAM_DESCRIPTION_CHANGED": return "Description updated";
    case "TEAM_TYPE_CHANGED": return "Template changed";
    case "TEAM_ARCHIVED": return "Team archived";
    case "TEAM_REOPENED": return "Team reopened";
    case "MEMBER_INVITED": return "Member invited";
    case "INVITE_RESENT": return "Invite resent";
    case "INVITE_REVOKED": return "Invite revoked";
    case "INVITE_ACCEPTED": return "Invite accepted";
    case "INVITE_EXPIRED": return "Invite expired";
    case "MEMBER_ADDED": return "Member added";
    case "MEMBER_SUSPENDED": return "Member suspended";
    case "MEMBER_REINSTATED": return "Member reinstated";
    case "MEMBER_REMOVED": return "Member removed";
    case "MEMBER_ROLE_CHANGED": return "Role changed";
    case "LEAD_TRANSFERRED": return "Lead transferred";
    case "ASSIGNMENT_CREATED": return "Assignment created";
    case "ASSIGNMENT_REASSIGNED": return "Assignment reassigned";
    case "ASSIGNMENT_COMPLETED": return "Assignment completed";
    case "ASSIGNMENT_CANCELLED": return "Assignment cancelled";
    case "ASSIGNMENT_PRIORITY_CHANGED": return "Assignment priority changed";
    case "ASSIGNMENT_DUE_CHANGED": return "Assignment due date changed";
  }
}

// =============================================================================
// Settings tab
// =============================================================================

function SettingsTab({
  team,
  onChange,
  canManage,
  canArchive,
}: {
  team: CollaborationTeamDetail;
  onChange: () => Promise<void>;
  canManage: boolean;
  canArchive: boolean;
}) {
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();
  const router = useRouter();
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description ?? "");
  const [teamType, setTeamType] = useState<CollaborationTeamType>(team.teamType);
  const [busy, setBusy] = useState(false);

  const dirty =
    name !== team.name ||
    description !== (team.description ?? "") ||
    teamType !== team.teamType;

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty || busy) return;
    setBusy(true);
    try {
      await updateTeam(team.id, {
        name: name !== team.name ? name : undefined,
        description:
          description !== (team.description ?? "")
            ? description || null
            : undefined,
        teamType: teamType !== team.teamType ? teamType : undefined,
      });
      addToast("Settings saved.", "success");
      await onChange();
    } catch (err) {
      if (err instanceof ApiError) {
        addToast(`${err.message} (req ${err.requestId ?? "—"})`, "error");
      } else {
        addToast("Couldn't save settings.", "error");
      }
    } finally {
      setBusy(false);
    }
  };

  const onArchive = async () => {
    const ok = await confirm({
      title: `Archive "${team.name}"?`,
      description:
        "Members will lose access to active work until the team is unarchived. Activity history is preserved.",
      confirmLabel: "Archive team",
      tone: "danger",
      requireConfirmText: team.name,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await archiveTeam(team.id);
      addToast("Team archived.", "success");
      router.push("/collaboration-teams");
    } catch (err) {
      if (err instanceof ApiError) {
        addToast(`${err.message} (req ${err.requestId ?? "—"})`, "error");
      } else {
        addToast("Couldn't archive team.", "error");
      }
    } finally {
      setBusy(false);
    }
  };

  if (!canManage) {
    return (
      <p
        style={{ color: "#9b826b" }}
        data-testid="settings-permission-denied"
      >
        Only LEAD and ADMIN can change team settings.
      </p>
    );
  }

  return (
    <section data-testid="tab-settings-content" style={{ maxWidth: 560 }}>
      <form onSubmit={onSave}>
        <label style={labelStyle}>
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            required
            data-testid="settings-name"
            style={inputStyle}
          />
        </label>
        <label style={labelStyle}>
          Description
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={600}
            rows={3}
            data-testid="settings-description"
            style={{ ...inputStyle, resize: "vertical" }}
          />
        </label>
        <label style={labelStyle}>
          Template
          <select
            value={teamType}
            onChange={(e) =>
              setTeamType(e.target.value as CollaborationTeamType)
            }
            data-testid="settings-team-type"
            style={inputStyle}
          >
            {COLLABORATION_TEAM_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={!dirty || busy}
          className="cc-quick-action"
          data-testid="settings-save"
          style={{ marginTop: "0.5rem" }}
        >
          {busy ? "Saving…" : "Save changes"}
        </button>
      </form>

      <div
        style={{
          marginTop: "2.5rem",
          padding: "1rem",
          border: "1px solid rgba(186,80,80,0.25)",
          borderRadius: 12,
          background: "rgba(255,242,242,0.6)",
        }}
        data-testid="settings-danger-zone"
      >
        <h3 style={{ margin: 0, color: "#7c2d2d", fontSize: "0.98rem" }}>
          Danger zone
        </h3>
        <p style={{ color: "#5d6d71", margin: "0.5rem 0" }}>
          Archiving the team hides it from the overview and removes it from
          active work routing. Activity history is preserved.
        </p>
        <button
          type="button"
          onClick={() => void onArchive()}
          disabled={!canArchive || busy || team.status === "ARCHIVED"}
          className="cases-filter-chip"
          data-testid="settings-archive"
          style={{ color: "#7c2d2d" }}
        >
          {team.status === "ARCHIVED" ? "Already archived" : "Archive team"}
        </button>
      </div>
    </section>
  );
}

// =============================================================================
// Shared styles
// =============================================================================

const cardStyle: React.CSSProperties = {
  border: "1px solid rgba(79,112,107,0.14)",
  borderRadius: 14,
  padding: "1.1rem",
  background: "rgba(255,255,255,0.7)",
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
};

const cardTitle: React.CSSProperties = {
  margin: 0,
  fontSize: "1rem",
  fontWeight: 600,
  color: "#182b30",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontWeight: 600,
  color: "#182b30",
  fontSize: "0.9rem",
};

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "8px 12px",
  border: "1px solid rgba(79,112,107,0.18)",
  borderRadius: 10,
  background: "#fff",
  color: "#182b30",
  fontSize: "0.95rem",
  outline: "none",
  marginTop: 4,
};

const selectStyle: React.CSSProperties = {
  padding: "6px 10px",
  border: "1px solid rgba(79,112,107,0.18)",
  borderRadius: 999,
  background: "#fff",
  color: "#182b30",
  fontSize: "0.85rem",
};
