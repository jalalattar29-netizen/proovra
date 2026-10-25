/**
 * WHO MAY BE GIVEN WORK — the one assignee-eligibility authority (members audit,
 * owner decision 2026-10-25, "unassigned member").
 *
 * Every writer that hands a person operational work goes through here:
 * reviewer assignment (single, reviewer-ops console, bulk triage), a reviewer
 * claiming queue work, escalation routing and reassignment, and case
 * assignment. A person may be given the work only when ALL of these hold:
 *
 *   1. CAPABILITY — an ACTIVE workspace membership whose role (or delegated
 *      scope) holds the permission the work needs;
 *   2. REACH — they can open the object itself (a restricted case keeps its
 *      own access list, and evidence inherits it);
 *   3. PLACEMENT — on PRO and TEAM, a non-owner must be placed in an ACTIVE
 *      Collaboration Team. Placement is NECESSARY, never sufficient: it does not
 *      replace (1) or (2). The workspace OWNER is exempt from placement only —
 *      they still need the capability and the reach. ENTERPRISE follows its
 *      contract: direct eligible assignment is allowed unless the contract
 *      states `assignmentRequiresTeamPlacement`; without an ACTIVE contract the
 *      rule fails closed and placement is required.
 *
 * The refusal names WHICH rule failed only where the caller may know it:
 * placement (the assigner sees the roster's "Unassigned" marker anyway). A
 * capability or reach refusal stays one indistinct answer, so an assigner
 * learns nothing about a person's access they could not already see.
 */
import type { Permission } from "@proovra/shared";
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { evaluateMemberAccess } from "../identity/access-policy.service.js";
import { resolveEvidenceRecordAccess } from "../evidence/evidence-record-access.service.js";
import { resolveCaseRecordAccess } from "../cases/case-permission.service.js";
import { isPlacedWorkspaceMember, placedUserIds } from "../collaboration-team/placement.js";
import { resolveWorkspaceCommercialContext } from "../billing/workspace-seats.service.js";

export type AssigneeIneligibility = "NOT_ELIGIBLE" | "NOT_PLACED";

export class AssigneeEligibilityError extends Error {
  constructor(readonly reason: AssigneeIneligibility) {
    super(reason);
    this.name = "AssigneeEligibilityError";
  }
}

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

export async function assertWorkAssigneeEligible(
  input: {
    workspaceId: string;
    assigneeUserId: string;
    permission: Permission;
    evidenceId?: string | null;
    caseId?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  const membership = await evaluateMemberAccess(
    { teamId: input.workspaceId, userId: input.assigneeUserId, permission: input.permission },
    client,
  );
  if (!membership.allowed) throw new AssigneeEligibilityError("NOT_ELIGIBLE");

  if (input.evidenceId) {
    const record = await resolveEvidenceRecordAccess(
      { userId: input.assigneeUserId, evidenceId: input.evidenceId, permission: "evidence.read" },
      client,
    );
    if (!record.allowed) throw new AssigneeEligibilityError("NOT_ELIGIBLE");
  }
  if (input.caseId) {
    const reach = await resolveCaseRecordAccess(
      { userId: input.assigneeUserId, caseId: input.caseId },
      client,
    );
    if (!reach.allowed) throw new AssigneeEligibilityError("NOT_ELIGIBLE");
  }

  if (await assignmentRequiresPlacement(input.workspaceId, client)) {
    const placed = await isPlacedWorkspaceMember(
      { workspaceId: input.workspaceId, userId: input.assigneeUserId },
      client,
    );
    if (!placed) throw new AssigneeEligibilityError("NOT_PLACED");
  }
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
