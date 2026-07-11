"use client";

import type { CollaborationTeamDetail } from "../../../../../lib/api/collaboration-teams";
import { listCollaborationTeamRolePermissions } from "@proovra/shared";
import type { TabId } from "../page";

// =============================================================================
// Overview tab — operational snapshot on the neutral app-* design system.
// Every value is derived from the `team` prop; nothing is fabricated. Where a
// metric has no backing data it reads 0 / "—" honestly.
// =============================================================================

function OverviewTab({
  team,
  onJumpTab,
}: {
  team: CollaborationTeamDetail;
  onJumpTab: (t: TabId) => void;
}) {
  const activeMembers = team.members.filter((m) => m.status === "ACTIVE");
  const suspendedMembers = team.members.filter((m) => m.status === "SUSPENDED");
  const pendingInvites = team.invites.filter((i) => i.status === "PENDING");
  const managerCount = activeMembers.filter(
    (m) => m.role === "LEAD" || m.role === "ADMIN",
  ).length;
  const openAssignments = team.assignmentCount;

  const permissions = listCollaborationTeamRolePermissions(team.viewerRole);

  return (
    <section
      data-testid="tab-overview-content"
      className="app-section-stack"
    >
      {/* §3 — the four KPI cards (Active members / Pending invites / Open
          assignments / Guest collaborators) were removed. The Overview now
          opens straight into the operational panels; the same counts remain
          available in the Members / Invites / Assignments tabs. */}

      {/* Team health --------------------------------------------------- */}
      <div className="app-panel" data-testid="overview-team-health">
        <div className="app-panel__head">
          <h2 className="app-panel__title">Team health</h2>
        </div>
        <div className="app-panel__body">
          <ul className="overview-health-list">
            <HealthRow
              label="Membership"
              tone={activeMembers.length > 0 ? "green" : "amber"}
              badge={`${activeMembers.length}/${team.members.length} active`}
              detail="Members currently able to participate."
            />
            <HealthRow
              label="Role coverage"
              tone={managerCount > 0 ? "green" : "amber"}
              badge={
                managerCount > 0
                  ? `${managerCount} lead/admin`
                  : "No manager"
              }
              detail={
                managerCount > 0
                  ? "At least one member can manage the team."
                  : "No active LEAD or ADMIN to manage the team."
              }
            />
            <HealthRow
              label="Pending access review"
              tone={pendingInvites.length > 0 ? "amber" : "green"}
              badge={`${pendingInvites.length} pending`}
              detail="Invitations still awaiting acceptance."
            />
            <HealthRow
              label="Inactive members"
              tone={suspendedMembers.length > 0 ? "amber" : "green"}
              badge={`${suspendedMembers.length} suspended`}
              detail="Members suspended from participation."
            />
            <HealthRow
              label="Unresolved assignments"
              tone={openAssignments > 0 ? "indigo" : "green"}
              badge={`${openAssignments} open`}
              detail="Assignments not yet completed or cancelled."
            />
          </ul>
        </div>
      </div>

      {/* Pending actions ----------------------------------------------- */}
      <div className="app-panel" data-testid="overview-pending-actions">
        <div className="app-panel__head">
          <h2 className="app-panel__title">Pending actions</h2>
        </div>
        <div className="app-panel__body">
          {pendingInvites.length === 0 &&
          suspendedMembers.length === 0 &&
          openAssignments === 0 ? (
            <p style={{ margin: 0, color: "#5F6878", fontSize: 13.5 }}>
              Nothing needs your attention right now.
            </p>
          ) : (
            <ul className="overview-action-list">
              {pendingInvites.length > 0 ? (
                <ActionRow
                  label={`${pendingInvites.length} pending ${
                    pendingInvites.length === 1 ? "invite" : "invites"
                  }`}
                  hint="Review or resend invitations."
                  cta="Go to invites"
                  onClick={() => onJumpTab("invites")}
                />
              ) : null}
              {openAssignments > 0 ? (
                <ActionRow
                  label={`${openAssignments} open ${
                    openAssignments === 1 ? "assignment" : "assignments"
                  }`}
                  hint="Track and complete assigned work."
                  cta="Go to assignments"
                  onClick={() => onJumpTab("assignments")}
                />
              ) : null}
              {suspendedMembers.length > 0 ? (
                <ActionRow
                  label={`${suspendedMembers.length} suspended ${
                    suspendedMembers.length === 1 ? "member" : "members"
                  }`}
                  hint="Reinstate or remove suspended members."
                  cta="Go to members"
                  onClick={() => onJumpTab("members")}
                />
              ) : null}
            </ul>
          )}
        </div>
      </div>

      {/* Recent activity + Your role — side by side on wide screens ----- */}
      <div className="overview-two-col">
        <div className="app-panel" data-testid="overview-recent-activity">
          <div className="app-panel__head">
            <h2 className="app-panel__title">Recent activity</h2>
            <button
              type="button"
              className="app-ghost-action"
              onClick={() => onJumpTab("activity")}
            >
              View activity
            </button>
          </div>
          <div className="app-panel__body">
            <p style={{ margin: 0, color: "#5F6878", fontSize: 13.5 }}>
              Membership changes, invitations, and assignment updates are
              recorded on the activity timeline.
            </p>
          </div>
        </div>

        <div className="app-panel" data-testid="overview-your-role">
          <div className="app-panel__head">
            <h2 className="app-panel__title">Your role &amp; permissions</h2>
            <AppRoleBadge role={team.viewerRole} />
          </div>
          <div className="app-panel__body">
            <p
              style={{
                margin: "0 0 10px",
                color: "#5F6878",
                fontSize: 13,
              }}
            >
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
      </div>

      <style>{OVERVIEW_STYLES}</style>
    </section>
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

function ActionRow({
  label,
  hint,
  cta,
  onClick,
}: {
  label: string;
  hint: string;
  cta: string;
  onClick: () => void;
}) {
  return (
    <li className="overview-action-row">
      <div style={{ minWidth: 0 }}>
        <div className="overview-action-label">{label}</div>
        <p className="overview-action-hint">{hint}</p>
      </div>
      <button type="button" className="app-secondary-action" onClick={onClick}>
        {cta}
      </button>
    </li>
  );
}

function AppRoleBadge({ role }: { role: string }) {
  const tone =
    role === "LEAD" || role === "ADMIN"
      ? "indigo"
      : role === "EXTERNAL"
        ? "amber"
        : "slate";
  return (
    <span className="app-status-badge" data-tone={tone}>
      {role}
    </span>
  );
}

/** Turn a `team.*` permission token into a readable capability phrase. */
function humanizePermission(permission: string): string {
  const MAP: Record<string, string> = {
    "team.read": "View team details",
    "team.update_settings": "Update team settings",
    "team.archive": "Archive the team",
    "team.transfer_lead": "Transfer team leadership",
    "team.member.invite": "Invite people to the team",
    "team.member.remove": "Remove members",
    "team.member.suspend": "Suspend members",
    "team.member.change_role": "Change member roles",
    "team.invite.revoke": "Revoke pending invites",
    "team.invite.resend": "Resend invites",
    "team.assignment.create": "Create assignments",
    "team.assignment.reassign": "Reassign work",
    "team.assignment.complete": "Complete assignments",
    "team.assignment.cancel": "Cancel assignments",
    "team.activity.read": "View the activity timeline",
  };
  return MAP[permission] ?? permission;
}

const OVERVIEW_STYLES = `
.overview-kpi-button {
  text-align: left;
  cursor: pointer;
  font: inherit;
  transition: box-shadow 140ms ease, transform 140ms ease;
}
.overview-kpi-button:hover {
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.08);
  transform: translateY(-1px);
}
.overview-kpi-button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(139, 124, 246, 0.3);
}
.overview-two-col {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
@media (max-width: 860px) {
  .overview-two-col { grid-template-columns: 1fr; }
}
.overview-health-list,
.overview-action-list,
.overview-perm-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.overview-health-list > li + li {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid rgba(15, 23, 42, 0.05);
}
.overview-health-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.overview-health-label {
  font-size: 13.5px;
  font-weight: 650;
  color: #172033;
}
.overview-health-detail {
  margin: 4px 0 0;
  font-size: 12.5px;
  line-height: 1.45;
  color: #5F6878;
}
.overview-action-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.overview-action-row + .overview-action-row {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid rgba(15, 23, 42, 0.05);
}
.overview-action-label {
  font-size: 13.5px;
  font-weight: 650;
  color: #172033;
}
.overview-action-hint {
  margin: 3px 0 0;
  font-size: 12.5px;
  color: #5F6878;
}
.overview-perm-list li {
  position: relative;
  padding-left: 20px;
  font-size: 13px;
  color: #344054;
  line-height: 1.5;
}
.overview-perm-list li + li {
  margin-top: 6px;
}
.overview-perm-list li::before {
  content: "";
  position: absolute;
  left: 4px;
  top: 8px;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: #6b5bff;
}
`;

export { OverviewTab };
