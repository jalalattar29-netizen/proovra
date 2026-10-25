/**
 * THE PLACEMENT PREREQUISITE (owner decision 2026-10-25) — when must a person be
 * placed in an ACTIVE Collaboration Team before they can be given work? PRO /
 * TEAM: always (the workspace owner excepted); ENTERPRISE: when its ACTIVE
 * contract says so. Read by the assignee authority (assignee-eligibility.ts),
 * by the operations assignee resolver and by the review page's Claim offer, so
 * all three give the same answer.
 */
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { isPlacedWorkspaceMember, placedUserIds } from "../collaboration-team/placement.js";
import { resolveWorkspaceCommercialContext } from "../billing/workspace-seats.service.js";

/**
 * Does assignment in this workspace require Collaboration Team placement?
 * PRO / TEAM: yes. ENTERPRISE: the contract term (NULL / false = no). Any
 * other plan has no collaboration and no assignable work, so the question
 * never arises; it answers yes (fail closed).
 */
export async function assignmentRequiresPlacement(
  workspaceId: string,
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  const workspace = await client.team.findUnique({
    where: { id: workspaceId },
    select: { id: true, ownerUserId: true, organizationId: true },
  });
  if (!workspace) return true;
  const context = await resolveWorkspaceCommercialContext(workspace);
  if (context.plan !== "ENTERPRISE") return true;
  if (!workspace.organizationId) return true;
  const contract = await client.enterpriseContract.findUnique({
    where: { organizationId: workspace.organizationId },
    select: { status: true, assignmentRequiresTeamPlacement: true },
  });
  if (!contract || contract.status !== "ACTIVE") return true;
  return contract.assignmentRequiresTeamPlacement === true;
}


/** The placed subset of `userIds` in a workspace (owner always placed) — one query, for pickers. */
export async function placedUserIdsForWorkspace(
  workspaceId: string,
  userIds: readonly string[],
  client: PrismaClient = defaultPrisma,
): Promise<Set<string>> {
  const workspace = await client.team.findUnique({
    where: { id: workspaceId },
    select: { ownerUserId: true },
  });
  if (!workspace) return new Set();
  return placedUserIds({ workspaceId, ownerUserId: workspace.ownerUserId, userIds }, client);
}

/**
 * Does `userId` meet the placement prerequisite in `workspaceId`? For a surface
 * that offers work (Claim): the same answer the writers enforce, so the page
 * never offers what the server would refuse.
 */
export async function meetsPlacementPolicy(
  input: { workspaceId: string; userId: string },
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  if (!(await assignmentRequiresPlacement(input.workspaceId, client))) return true;
  return isPlacedWorkspaceMember(input, client);
}
