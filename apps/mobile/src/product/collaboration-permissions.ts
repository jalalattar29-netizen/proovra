/**
 * Group-role affordances, from the SAME shared role table the web and the API
 * use (`collaborationTeamRoleHasPermission`). Kept apart from collaboration.ts,
 * which stays dependency-free so its unit tests can load it on their own.
 */
import { COLLABORATION_TEAM_ROLES, collaborationTeamRoleHasPermission } from "@proovra/shared";

/**
 * Whether the viewer's GROUP role may add members — the web's `canInvite`
 * (collaboration-teams/[teamId]/page.tsx:439). Not authorization: the bulk and
 * single routes re-check `team.member.invite` with `requireActiveTeam`. This
 * only stops the screen offering a write that cannot succeed.
 */
export function canAddTeamMembers(team: { status: string; viewerRole: string | null }): boolean {
  if (team.status !== "ACTIVE") return false;
  // An unrecognised role holds nothing (the shared table would throw on it).
  const role = COLLABORATION_TEAM_ROLES.find((r) => r === team.viewerRole);
  return role ? collaborationTeamRoleHasPermission(role, "team.member.invite") : false;
}

/**
 * The groups this viewer may hand work to — ACTIVE groups whose viewer role
 * holds `team.assignment.create`, the SAME permission POST
 * /:teamId/assignments enforces (TeamResponsibilityPanel.tsx). Display only:
 * the server still refuses anyone who lacks it.
 */
export function assignableTeams<T extends { status?: string | null; viewerRole?: string | null }>(teams: readonly T[]): T[] {
  return teams.filter((t) => {
    if (t.status !== "ACTIVE") return false;
    const role = COLLABORATION_TEAM_ROLES.find((r) => r === t.viewerRole);
    return role ? collaborationTeamRoleHasPermission(role, "team.assignment.create") : false;
  });
}
