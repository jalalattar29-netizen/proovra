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
import { AppStatusText } from "../../../../../components/app-primitives/AppStatusText";
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

  const isArchived = team.status !== "ACTIVE";
  const permissions = listCollaborationTeamRolePermissions(team.viewerRole);
  const permissionGroups = groupPermissions(permissions);

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
            /*
              SIX METRICS IN THE NOTIFICATIONS GRAMMAR (§4).

              `--dense` is the existing auto-fit track, so the row is six
              across where there is room, three and three on a tablet and two
              on a phone — without a breakpoint written here. The tones are the
              canonical semantic scale: the two lifecycle states that mean
              "moving" and "done" read as info and success, and the three
              target types take the tone each object already carries elsewhere
              in the product.
            */
            <ul className="app-grid-kpis app-grid-kpis--dense">
              <Kpi label="Open" value={w.open} tone="info" testId="overview-kpi-open" />
              <Kpi
                label="In progress"
                value={w.inProgress}
                tone="accent"
                testId="overview-kpi-in-progress"
              />
              <Kpi
                label="Completed"
                value={w.completed}
                tone="success"
                testId="overview-kpi-completed"
              />
              <Kpi
                label="Cases"
                value={w.byTargetType.CASE}
                tone="accent"
                testId="overview-kpi-cases"
              />
              <Kpi
                label="Evidence"
                value={w.byTargetType.EVIDENCE}
                tone="info"
                testId="overview-kpi-evidence"
              />
              <Kpi
                label="Reviews"
                value={w.byTargetType.REVIEW}
                tone="warning"
                testId="overview-kpi-reviews"
              />
            </ul>
          )}
        </div>
      </div>

      {/*
        THE OPERATIONAL PAIR (§6).

        "Who is carrying what" and "Team" are two readings of the same
        population — one by workload, one by health — and each was a full-width
        panel holding a handful of short rows. Side by side they read as the
        comparison they are, and the Overview stops being a single column of
        half-empty slabs. `.app-grid-panels` collapses them back to one column
        on a narrow viewport.
      */}
      <div className="app-grid-panels">
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
          <h2 className="app-panel__title">Team health</h2>
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
      </div>

      {/*
        YOUR ROLE — A SUMMARY, WITH THE DETAIL ONE CLICK AWAY (§7).

        This was a seventeen-line bullet wall: every permission the server
        granted, flat, in source order, in the tallest card on the page. Nobody
        reads a list like that, and its height said the permissions were the
        most important thing on the Overview.

        Nothing is removed. The same permissions are still shown, still derived
        from `permissions` — this is presentation only and creates no second
        authority. What changed is that the card leads with the ROLE and one
        sentence about what it means, and the enumeration moved into grouped
        sections behind a disclosure, so the default state is three lines
        instead of nineteen.

        The summary sentence is BUILT from what was actually granted rather
        than written per role: a role whose grants change would otherwise keep
        a sentence that quietly stopped being true.
      */}
      <div className="app-panel" data-testid="overview-your-role">
        <div className="app-panel__head app-panel__head-row">
          <h2 className="app-panel__title">Your role</h2>
          <AppStatusText
            tone={
              team.viewerRole === "LEAD" || team.viewerRole === "ADMIN"
                ? "indigo"
                : "slate"
            }
          >
            {team.viewerRole}
          </AppStatusText>
        </div>
        <div className="app-panel__body">
          <p style={{ margin: 0, color: "#5F6878", fontSize: 13, lineHeight: 1.5 }}>
            {summarisePermissions(permissions)}
          </p>
          {permissionGroups.length > 0 ? (
            <details className="overview-perm-details">
              <summary data-testid="overview-perm-toggle">
                View all permissions ({permissions.length})
              </summary>
              <div className="overview-perm-groups">
                {permissionGroups.map((group) => (
                  <div key={group.title} className="overview-perm-group">
                    <h3 className="overview-perm-group__title">{group.title}</h3>
                    <ul className="overview-perm-list">
                      {group.items.map((p) => (
                        <li key={p}>{humanizePermission(p, isArchived)}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </div>
      </div>

      <style>{OVERVIEW_STYLES}</style>
    </section>
  );
}

function Kpi({
  label,
  value,
  tone,
  testId,
}: {
  label: string;
  value: number;
  tone: "info" | "accent" | "success" | "warning";
  testId: string;
}) {
  return (
    <li>
      <div className="app-metric-card" data-app-metric-tone={tone} data-testid={testId}>
        <span className="app-metric-card__value">{value}</span>
        <span className="app-metric-card__label">{label}</span>
      </div>
    </li>
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
      <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 12 }}>
        {/* The count is a NUMBER, tinted. It was a filled capsule, which made
            three attention rows read as three buttons. */}
        <span className="overview-action-count" data-tone={tone}>
          {count}
        </span>
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
        {/*
          TEXT, NOT A CAPSULE (§5). `AppStatusText` is the canonical no-surface
          sibling of `AppStatusBadge` and reads the SAME tone vocabulary, so the
          colour still means exactly what it means everywhere else — only the
          pill is gone. "3 active" is a labelled fact in a key/value row, which
          is precisely the case that primitive exists for; a badge is for the
          value a dense table is SCANNED by.
        */}
        <AppStatusText tone={tone}>{badge}</AppStatusText>
      </div>
      <p className="overview-health-detail">{detail}</p>
    </li>
  );
}

const PERMISSION_LABELS: Record<string, string> = {
  "team.read": "See this team and its work",
  "team.update_settings": "Change the team's name and description",
  "team.archive": "Archive or reopen this team",
  "team.delete": "Permanently delete this team when it holds no records",
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

/**
 * LIFECYCLE CHANGES WHICH HALF OF A CAPABILITY IS AVAILABLE, NOT WHETHER THE
 * ROLE HOLDS IT.
 *
 * `team.archive` is one grant covering two opposite operations, so its label
 * read "Archive or reopen this team" in both states — telling the reader of an
 * ARCHIVED team they can archive it, and the reader of an ACTIVE team they can
 * reopen it. Both halves are false half the time.
 *
 * This is PRESENTATION ONLY and adds no authority: the permission list is
 * still `listCollaborationTeamRolePermissions`, the server still decides, and
 * nothing is added to or removed from the set. Only the sentence changes.
 *
 * Deliberately narrow. Every other permission in the vocabulary means the same
 * thing in both states — a role that may assign work still may, it is simply
 * refused while archived, and the banner above already says so once. Rewriting
 * fifteen labels to say "…when this team is reopened" would be noise.
 */
const LIFECYCLE_SENSITIVE_LABELS: Record<
  string,
  { active: string; archived: string }
> = {
  "team.archive": {
    active: "Archive this team",
    archived: "Reopen this team",
  },
};

function humanizePermission(p: string, isArchived: boolean): string {
  const lifecycle = LIFECYCLE_SENSITIVE_LABELS[p];
  if (lifecycle) return isArchived ? lifecycle.archived : lifecycle.active;
  return PERMISSION_LABELS[p] ?? p;
}

/**
 * The four things a team permission can be ABOUT (§7).
 *
 * Presentation only — this groups the permissions the SERVER granted and
 * invents none. A key the server sends that matches no group still appears,
 * under "Other", because silently dropping a granted capability from the list
 * that claims to show them all is worse than an untidy heading.
 */
const PERMISSION_GROUPS: { title: string; match: (p: string) => boolean }[] = [
  {
    title: "Team management",
    match: (p) =>
      p === "team.update_settings" ||
      p === "team.archive" ||
      p === "team.delete" ||
      p === "team.transfer_lead",
  },
  { title: "Members", match: (p) => p.startsWith("team.member.") },
  { title: "Work", match: (p) => p.startsWith("team.assignment.") },
  {
    title: "Invitations, audit and access",
    match: (p) =>
      p.startsWith("team.invite.") || p === "team.activity.read" || p === "team.read",
  },
];

function groupPermissions(
  permissions: readonly string[]
): { title: string; items: string[] }[] {
  const groups = PERMISSION_GROUPS.map((g) => ({
    title: g.title,
    items: permissions.filter((p) => g.match(p)),
  })).filter((g) => g.items.length > 0);
  const claimed = new Set(groups.flatMap((g) => g.items));
  const rest = permissions.filter((p) => !claimed.has(p));
  return rest.length > 0 ? [...groups, { title: "Other", items: rest }] : groups;
}

/**
 * One sentence, DERIVED from the grants rather than written per role.
 *
 * A hand-written sentence per role is a second permission authority in prose:
 * it keeps claiming what the role used to be able to do. This names only the
 * capability families the caller actually holds.
 */
function summarisePermissions(permissions: readonly string[]): string {
  if (permissions.length === 0) {
    return "You have no management permissions on this team.";
  }
  const can: string[] = [];
  if (permissions.some((p) => p.startsWith("team.member."))) can.push("team membership");
  if (permissions.some((p) => p.startsWith("team.assignment."))) can.push("work assignment");
  if (
    permissions.some(
      (p) =>
        p === "team.update_settings" || p === "team.archive" || p === "team.transfer_lead"
    )
  ) {
    can.push("the team's settings and lifecycle");
  }
  if (can.length === 0) {
    return "You can see this team, its work and its activity history.";
  }
  const list =
    can.length === 1
      ? can[0]
      : `${can.slice(0, -1).join(", ")} and ${can[can.length - 1]}`;
  return `You can manage ${list}.`;
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
/* The attention count: a tinted figure, sized to hold its own beside the
   label, with a fixed min-width so three rows keep one left edge. */
.overview-action-count {
  min-width: 28px;
  font-size: 19px;
  font-weight: 720;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
  text-align: center;
  color: var(--ink-secondary, #475569);
}
.overview-action-count[data-tone="red"] { color: var(--error, #DC2626); }
.overview-action-count[data-tone="amber"] { color: var(--orange-500, #EA580C); }
.overview-action-count[data-tone="indigo"] { color: var(--accent-600, #6D28D9); }
.overview-perm-details { margin-top: 12px; }
.overview-perm-details > summary {
  cursor: pointer;
  font-size: 12.5px;
  font-weight: 650;
  color: var(--accent-600, #6D28D9);
  list-style: none;
}
.overview-perm-details > summary::-webkit-details-marker { display: none; }
.overview-perm-details > summary::before { content: "▸ "; }
.overview-perm-details[open] > summary::before { content: "▾ "; }
.overview-perm-details > summary:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(124, 58, 237, 0.28);
  border-radius: 6px;
}
.overview-perm-groups {
  margin-top: 12px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 14px;
}
.overview-perm-group__title {
  margin: 0 0 6px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #667085;
}
.overview-perm-list { gap: 4px; }
.overview-perm-list li { color: #5F6878; font-size: 12.5px; line-height: 1.45; }
`;

export { OverviewTab };
