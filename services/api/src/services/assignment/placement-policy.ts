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
  const context = await resolveWorkspaceCommercialContext(workspace, client); // AUD-0017: on the caller's connection
  if (context.plan !== "ENTERPRISE") return true;
  if (!workspace.organizationId) return true;
  const contract = await client.enterpriseContract.findUnique({
    where: { organizationId: workspace.organizationId },
    select: { status: true, assignmentRequiresTeamPlacement: true },
  });
  if (!contract || contract.status !== "ACTIVE") return true;
  return contract.assignmentRequiresTeamPlacement === true;
}


/**
 * REVIEW assignment placement (review remediation 2026-11-27). Placement in a
 * Collaboration Team is NOT an unexplained extra prerequisite for ordinary
 * Team review: on Team / Pro it applies only when the workspace's explicit
 * Review policy `review_requires_team_placement` is on (default off). An
 * Enterprise workspace keeps its contract term exactly as
 * `assignmentRequiresPlacement` reads it. Case / work assignment outside
 * Review keeps `assignmentRequiresPlacement` unchanged.
 */
export async function reviewAssignmentRequiresPlacement(
  workspaceId: string,
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  const workspace = await client.team.findUnique({
    where: { id: workspaceId },
    select: { id: true, ownerUserId: true, organizationId: true },
  });
  if (!workspace) return true;
  const context = await resolveWorkspaceCommercialContext(workspace, client);
  if (context.plan === "ENTERPRISE") return assignmentRequiresPlacement(workspaceId, client);
  const policy = await client.workspaceGovernancePolicy.findUnique({
    where: { teamId: workspaceId },
    select: { reviewRequiresTeamPlacement: true },
  });
  return policy?.reviewRequiresTeamPlacement === true;
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

/** The Review form of meetsPlacementPolicy (2026-11-27): reviewAssignmentRequiresPlacement. */
export async function meetsReviewPlacementPolicy(
  input: { workspaceId: string; userId: string },
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  if (!(await reviewAssignmentRequiresPlacement(input.workspaceId, client))) return true;
  return isPlacedWorkspaceMember(input, client);
}
