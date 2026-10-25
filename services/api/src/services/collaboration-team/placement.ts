/**
 * PLACEMENT — is this workspace member in an operational group yet?
 *
 * Members audit (owner decision 2026-10-25): Workspace membership establishes a
 * person's relationship and role in the workspace; Collaboration Team
 * membership PLACES them into an operational group. A member may sit
 * unassigned for a while after accepting an invitation, and while they do they
 * receive no restricted Case or Evidence access (that already follows from the
 * restricted-case rule) and no Team task (a task is held by a group member).
 * Their workspace ROLE still decides what they may do; placement is projected
 * so the surface can say honestly that they are not yet in a group.
 *
 * The workspace owner is always placed: the workspace is theirs. Everyone else
 * is placed by an EFFECTIVE membership (ACTIVE in the group and in the
 * workspace) of at least one ACTIVE Collaboration Team. One predicate, for the
 * members projection that has to show "unassigned" honestly.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { effectiveGroupMemberWhere } from "./effective-membership.js";

/** Where a group membership places its holder in `workspaceId`. */
export function placingGroupMembershipWhere(
  workspaceId: string,
): Prisma.CollaborationTeamMemberWhereInput {
  return {
    ...effectiveGroupMemberWhere(workspaceId),
    team: { workspaceId, status: "ACTIVE", archivedAtUtc: null },
  };
}

export async function isPlacedWorkspaceMember(
  input: { workspaceId: string; userId: string },
  client: Pick<PrismaClient, "team" | "collaborationTeamMember"> = defaultPrisma,
): Promise<boolean> {
  const workspace = await client.team.findUnique({
    where: { id: input.workspaceId },
    select: { ownerUserId: true },
  });
  if (!workspace) return false;
  if (workspace.ownerUserId === input.userId) return true;
  const placing = await client.collaborationTeamMember.count({
    where: { userId: input.userId, ...placingGroupMembershipWhere(input.workspaceId) },
  });
  return placing > 0;
}

/** The subset of `userIds` placed in `workspaceId` — one query, for projections. */
export async function placedUserIds(
  input: { workspaceId: string; ownerUserId: string; userIds: readonly string[] },
  client: Pick<PrismaClient, "collaborationTeamMember"> = defaultPrisma,
): Promise<Set<string>> {
  const placed = new Set<string>();
  if (input.userIds.includes(input.ownerUserId)) placed.add(input.ownerUserId);
  const others = input.userIds.filter((id) => id !== input.ownerUserId);
  if (others.length === 0) return placed;
  const rows = await client.collaborationTeamMember.findMany({
    where: { userId: { in: others }, ...placingGroupMembershipWhere(input.workspaceId) },
    select: { userId: true },
    distinct: ["userId"],
  });
  for (const r of rows) placed.add(r.userId);
  return placed;
}
