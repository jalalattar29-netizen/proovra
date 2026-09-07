"use client";

/**
 * OVERVIEW — is this team operationally healthy, and what needs attention now?
 *
 * =============================================================================
 * WHY IT WAS REBUILT
 * =============================================================================
 * Every number on this tab used to be computed from the detail payload's
 * `members` and `invites` arrays. Both are BOUNDED PREVIEWS — 25 members, 50
 * invites — so a four-hundred-person Enterprise group read "25/25 active", and
 * "Role coverage" and "Inactive members" were computed from the same truncated
 * array. WCR-08 fixed exactly this class of defect for the header badge and
 * stopped there.
 *
 * Worse, the tab was mostly not about work at all. Four of its five health rows
 * were membership administration; "Recent activity" was a static sentence with
 * no data in it; and "Pending workspace invitations" counted RETIRED
 * CollaborationTeamInvite rows while describing them as workspace invitations —
 * two different things, and the count is structurally zero for every workspace
 * created since the group invitation writer was removed.
 *
 * =============================================================================
 * WHAT IT IS NOW
 * =============================================================================
 * The group's operational snapshot, counted by the database
 * (`GET /v1/collaboration-teams/:teamId/overview` — `count` and `groupBy`,
 * never rows loaded to be measured), so it is exact at any group size and
 * costs the same at any group size.
 *
 * Every figure is about work this team is responsible for and people who are
 * in it. Nothing here re-derives case or evidence state: those belong to their
 * own authorities and are reached through the canonical link on the record.
 */

import { useCallback, useEffect, useState } from "react";

import {
  getTeamOverview,
  type CollaborationTeamDetail,
  type CollaborationTeamMember,
  type CollaborationTeamOverview,
} from "../../../../../lib/api/collaboration-teams";
import { listCollaborationTeamRolePermissions } from "@proovra/shared";
import { AppStatusBadge } from "../../../../../components/app-primitives/AppStatusBadge";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import type { TabId } from "../page";

function memberLabel(
  members: ReadonlyArray<CollaborationTeamMember>,
  userId: string,
): string {
  const m = members.find((mm) => mm.userId === userId);
  if (!m) return "Workspace member";
  return (
    m.user.displayName ||
    [m.user.firstName, m.user.lastName].filter(Boolean).join(" ") ||
    m.user.email ||
    "Workspace member"
  );
}

function OverviewTab({
  team,
  onJumpTab,
}: {
  team: CollaborationTeamDetail;
  onJumpTab: (t: TabId) => void;
}) {
  const [overview, setOverview] = useState<CollaborationTeamOverview | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (isStale: () => boolean) => {
      try {
        const res = await getTeamOverview(team.id);
        if (isStale()) return;
        setOverview(res);
      } catch (err) {
        if (isStale()) return;
        setError(
          toSafeUserError(err, {
            message: "The team's work summary couldn't be loaded.",
          }).message,
        );
      }
    },
    [team.id],
  );

  useEffect(() => {
    let cancelled = false;
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  const permissions = listCollaborationTeamRolePermissions(team.viewerRole);

  /**
   * NO NUMBER IS SHOWN BEFORE THE SERVER HAS SENT IT.
   *
   * `null` means unknown — loading, or degraded. Substituting a zero would
   * read as "this team has no overdue work", which is a claim, and the wrong
   * one to make about work an operator is deciding whether to act on.
   */
  const w = overview?.work ?? null;

  return (
    <section data-testid="tab-overview-content" className="app-section-stack">
      {/* Needs attention ------------------------------------------------- */}
      <div className="app-panel" data-testid="overview-needs-attention">
        <div className="app-panel__head">
          <h2 className="app-panel__title">Needs attention</h2>
          <button
            type="button"
            className="app-ghost-action"
            onClick={() => onJumpTab("work")}
            data-testid="overview-open-work"
          >
            Open work
          </button>
        </div>
        <div className="app-panel__body">
          {error ? (
            <p className="app-table__muted" style={{ margin: 0 }}>
              {error}
            </p>
          ) : w === null ? (
            <p className="app-table__muted" style={{ margin: 0 }}>
              Loading this team&rsquo;s work…
            </p>
          ) : w.overdue === 0 &&
            w.dueSoon === 0 &&
            w.highPriority === 0 &&
            w.unassigned === 0 ? (
            <p className="app-table__muted" style={{ margin: 0 }}>
              Nothing is overdue, due soon, high priority or unassigned.
            </p>
          ) : (
            <ul className="overview-action-list">
              {w.overdue > 0 ? (
                <AttentionRow
                  tone="red"
                  count={w.overdue}
                  label={w.overdue === 1 ? "item is overdue" : "items are overdue"}
                  hint="Past its due date and still open."
                  testId="overview-attention-overdue"
                  onOpen={() => onJumpTab("work")}
                />
              ) : null}
              {w.dueSoon > 0 ? (
                <AttentionRow
                  tone="amber"
                  count={w.dueSoon}
                  label={w.dueSoon === 1 ? "item is due soon" : "items are due soon"}
                  hint="Due within the next three days."
                  testId="overview-attention-due-soon"
                  onOpen={() => onJumpTab("work")}
                />
              ) : null}
              {w.highPriority > 0 ? (
                <AttentionRow
                  tone="amber"
                  count={w.highPriority}
                  label="high or urgent priority"
                  hint="Open work the team marked as needing to go first."
                  testId="overview-attention-priority"
                  onOpen={() => onJumpTab("work")}
                />
              ) : null}
              {w.unassigned > 0 ? (
                <AttentionRow
                  tone="indigo"
                  count={w.unassigned}
                  label="not assigned to anyone"
                  hint="Work the team holds but nobody has picked up."
                  testId="overview-attention-unassigned"
                  onOpen={() => onJumpTab("work")}
                />
              ) : null}
            </ul>
          )}
        </div>
      </div>

      {/* Work ------------------------------------------------------------ */}
      <div className="app-panel" data-testid="overview-work">
        <div className="app-panel__head">
          <h2 className="app-panel__title">Work</h2>
        </div>
        <div className="app-panel__body">
          {w === null ? (
            <p className="app-table__muted" style={{ margin: 0 }}>
              {error ?? "Loading…"}
            </p>
          ) : (
            <div className="app-grid-kpis">
              <Kpi label="Open" value={w.open} testId="overview-kpi-open" />
              <Kpi
                label="In progress"
                value={w.inProgress}
                testId="overview-kpi-in-progress"
              />
              <Kpi
                label="Completed"
                value={w.completed}
                testId="overview-kpi-completed"
              />
              <Kpi
                label="Cases"
                value={w.byTargetType.CASE}
                testId="overview-kpi-cases"
              />
              <Kpi
                label="Evidence"
                value={w.byTargetType.EVIDENCE}
                testId="overview-kpi-evidence"
              />
              <Kpi
                label="Reviews"
                value={w.byTargetType.REVIEW}
                testId="overview-kpi-reviews"
              />
            </div>
          )}
        </div>
      </div>

      {/* Member workload -------------------------------------------------- */}
      <div className="app-panel" data-testid="overview-workload">
        <div className="app-panel__head">
          <h2 className="app-panel__title">Who is carrying what</h2>
          <button
            type="button"
            className="app-ghost-action"
            onClick={() => onJumpTab("members")}
          >
            Members
          </button>
        </div>
        <div className="app-panel__body">
          {overview === null ? (
            <p className="app-table__muted" style={{ margin: 0 }}>
              {error ?? "Loading…"}
            </p>
          ) : overview.workload.length === 0 ? (
            <p className="app-table__muted" style={{ margin: 0 }}>
              No open work is assigned to a specific member yet.
            </p>
          ) : (
            <ul
              style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}
              data-testid="overview-workload-list"
            >
              {overview.workload.map((row) => (
                <li
                  key={row.userId}
                  data-testid={`overview-workload-${row.userId}`}
                  style={{ display: "flex", alignItems: "center", gap: 10 }}
                >
                  <span style={{ minWidth: 0, flex: 1 }}>
                    {memberLabel(team.members, row.userId)}
                  </span>
                  <span className="app-table__muted">
                    {row.open} open
                  </span>
                  {row.overdue > 0 ? (
                    <AppStatusBadge tone="red">
                      {row.overdue} overdue
                    </AppStatusBadge>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <p
            className="app-table__muted"
            style={{ margin: "10px 0 0", fontSize: 12 }}
          >
            Counted from work assigned to this team only. A person&rsquo;s full
            review workload across the workspace lives in reviewer operations.
          </p>
        </div>
      </div>

      {/* Team ------------------------------------------------------------- */}
      <div className="app-panel" data-testid="overview-team-health">
        <div className="app-panel__head">
          <h2 className="app-panel__title">Team</h2>
        </div>
        <div className="app-panel__body">
          {overview === null ? (
            <p className="app-table__muted" style={{ margin: 0 }}>
              {error ?? "Loading…"}
            </p>
          ) : (
            <ul className="overview-health-list">
              <HealthRow
                label="Active members"
                tone={overview.members.active > 0 ? "green" : "amber"}
                badge={`${overview.members.active} active`}
                detail="People currently able to participate in this team."
              />
              <HealthRow
                label="Role coverage"
                tone={overview.members.managers > 0 ? "green" : "amber"}
                badge={
                  overview.members.managers > 0
                    ? `${overview.members.managers} lead/admin`
                    : "No manager"
                }
                detail={
                  overview.members.managers > 0
                    ? "At least one member can manage this team."
                    : "No active lead or admin can manage this team."
                }
              />
              <HealthRow
                label="Suspended members"
                tone={overview.members.suspended > 0 ? "amber" : "green"}
                badge={`${overview.members.suspended} suspended`}
                detail="Members suspended from participation."
              />
            </ul>
          )}
        </div>
      </div>

      {/* Your role -------------------------------------------------------- */}
      <div className="app-panel" data-testid="overview-your-role">
        <div className="app-panel__head">
          <h2 className="app-panel__title">Your role &amp; permissions</h2>
          <AppStatusBadge
            tone={
              team.viewerRole === "LEAD" || team.viewerRole === "ADMIN"
                ? "indigo"
                : "slate"
            }
          >
            {team.viewerRole}
          </AppStatusBadge>
        </div>
        <div className="app-panel__body">
          <p style={{ margin: "0 0 10px", color: "#5F6878", fontSize: 13 }}>
            As <strong style={{ color: "#172033" }}>{team.viewerRole}</strong>{" "}
            you can:
          </p>
          <ul className="overview-perm-list">
            {permissions.map((p) => (
              <li key={p}>{humanizePermission(p)}</li>
            ))}
          </ul>
        </div>
      </div>

      <style>{OVERVIEW_STYLES}</style>
    </section>
  );
}

function Kpi({
  label,
  value,
  testId,
}: {
  label: string;
  value: number;
  testId: string;
}) {
  return (
    <div className="app-kpi-card" data-testid={testId}>
      <span className="app-kpi-card__value">{value}</span>
      <span className="app-kpi-card__label">{label}</span>
    </div>
  );
}

function AttentionRow({
  tone,
  count,
  label,
  hint,
  testId,
  onOpen,
}: {
  tone: "red" | "amber" | "indigo";
  count: number;
  label: string;
  hint: string;
  testId: string;
  onOpen: () => void;
}) {
  return (
    <li className="overview-action-row" data-testid={testId}>
      <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 10 }}>
        <AppStatusBadge tone={tone}>{count}</AppStatusBadge>
        <div style={{ minWidth: 0 }}>
          <div className="overview-action-label">{label}</div>
          <p className="overview-action-hint">{hint}</p>
        </div>
      </div>
      <button type="button" className="app-secondary-action" onClick={onOpen}>
        Review
      </button>
    </li>
  );
}

function HealthRow({
  label,
  tone,
  badge,
  detail,
}: {
  label: string;
  tone: "green" | "amber" | "red" | "indigo" | "slate";
  badge: string;
  detail: string;
}) {
  return (
    <li>
      <div className="overview-health-row">
        <span className="overview-health-label">{label}</span>
        <span className="app-status-badge" data-tone={tone}>
          {badge}
        </span>
      </div>
      <p className="overview-health-detail">{detail}</p>
    </li>
  );
}

const PERMISSION_LABELS: Record<string, string> = {
  "team.read": "See this team and its work",
  "team.update_settings": "Change the team's name and description",
  "team.archive": "Archive or reopen this team",
  "team.transfer_lead": "Transfer the lead role",
  "team.member.invite": "Add workspace members to the team",
  "team.member.remove": "Remove members from the team",
  "team.member.suspend": "Suspend and reinstate members",
  "team.member.change_role": "Change a member's role",
  "team.invite.revoke": "Withdraw an outstanding invitation",
  "team.invite.resend": "Resend an outstanding invitation",
  "team.assignment.create": "Assign cases, evidence and reviews to this team",
  "team.assignment.reassign": "Reassign work and change priority or due date",
  "team.assignment.complete": "Mark assigned work complete",
  "team.assignment.cancel": "Remove work from this team",
  "team.activity.read": "See the team's activity history",
};

function humanizePermission(p: string): string {
  return PERMISSION_LABELS[p] ?? p;
}

const OVERVIEW_STYLES = `
.overview-health-list, .overview-action-list, .overview-perm-list {
  list-style: none; margin: 0; padding: 0; display: grid; gap: 12px;
}
.overview-health-row {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
}
.overview-health-label { font-weight: 600; color: var(--app-ink, #172033); font-size: 13.5px; }
.overview-health-detail { margin: 2px 0 0; color: #5F6878; font-size: 12.5px; }
.overview-action-row {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
}
.overview-action-label { font-weight: 600; color: var(--app-ink, #172033); font-size: 13.5px; }
.overview-action-hint { margin: 2px 0 0; color: #5F6878; font-size: 12.5px; }
.overview-perm-list li { color: #5F6878; font-size: 13px; }
`;

export { OverviewTab };
