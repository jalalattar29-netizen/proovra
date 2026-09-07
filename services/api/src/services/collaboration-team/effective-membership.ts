import type { Prisma } from "@prisma/client";

/**
 * WCR-11 (2026-09-07) — THE ONE DEFINITION OF AN EFFECTIVE GROUP MEMBER.
 *
 * A `CollaborationTeamMember` row says the person was put in the group. It does
 * NOT say they can still get into the workspace that contains it, and nothing
 * reconciled the two: removing, suspending or revoking a workspace membership
 * left the group row `status = "ACTIVE"` for ever.
 *
 * Authorization was never affected — `authorizeCollaborationTeam` proves
 * workspace authority before it ever looks at a group role, so a departed
 * person is refused at the door on every request. What WAS affected is every
 * number and every list built from those rows:
 *
 *   * the roster showed leavers as active members;
 *   * `activeMemberCount` counted them;
 *   * `assertCollaborationTeamMemberLimit` counted them against the ceiling, so
 *     a group could be "full" of people who cannot enter the workspace, and a
 *     legitimate addition was refused on their behalf;
 *   * an access review asked a human to adjudicate access that was already gone.
 *
 * =============================================================================
 * DERIVED, NOT RECONCILED — and why
 * =============================================================================
 * The alternative was a cleanup pass that retires group rows when workspace
 * membership ends. That creates a SECOND truth which is correct only as often
 * as it runs, and it leaves "which one is right?" live in the codebase — the
 * exact shape of drift this whole closure exists to remove. Deriving costs one
 * join, cannot go stale, and cannot disagree with the authorization gate
 * because both read the same `TeamMember.status`.
 *
 * The historical row is RETAINED and can still be read deliberately: an
 * explicit `status` filter is a request for history (who was suspended, who was
 * removed) and is honoured as asked. It is simply never counted as effective.
 *
 * =============================================================================
 * WHY THIS LIVES IN ITS OWN MODULE
 * =============================================================================
 * Both `collaboration-team.service` (rosters, counts, previews) and
 * `billing-guards` (capacity) need it, and those two already import in one
 * direction. Putting the predicate in either would have made the cycle real.
 * A definition that two modules share belongs to neither of them.
 */
export function effectiveGroupMemberWhere(
  workspaceId: string,
): Prisma.CollaborationTeamMemberWhereInput {
  return {
    status: "ACTIVE",
    user: { teamMembers: { some: { teamId: workspaceId, status: "ACTIVE" } } },
  };
}
