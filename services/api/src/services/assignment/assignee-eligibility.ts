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
import { isPlacedWorkspaceMember } from "../collaboration-team/placement.js";
import { assignmentRequiresPlacement } from "./placement-policy.js";

export { assignmentRequiresPlacement, meetsPlacementPolicy, placedUserIdsForWorkspace } from "./placement-policy.js";

export type AssigneeIneligibility = "NOT_ELIGIBLE" | "NOT_PLACED";

export class AssigneeEligibilityError extends Error {
  constructor(readonly reason: AssigneeIneligibility) {
    super(reason);
    this.name = "AssigneeEligibilityError";
  }
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
  options: {
    /**
     * Members audit defect 5 — the caller passes its OWN transaction client and
     * the check runs inside the write's transaction: the placement it relies on
     * is read under a share lock (`FOR SHARE`) on the Collaboration Team row and
     * the group-membership row, held until the assignment commits. A concurrent
     * archive of the group (or removal from it) therefore either commits first
     * — and this check sees it and refuses NOT_PLACED — or waits until the
     * assignment has committed. Before this the check ran outside the write,
     * so an archive landing between the two left an unplaced assignee.
     */
    inTransaction?: boolean;
  } = {},
): Promise<void> {
  const membership = await evaluateMemberAccess(
    { teamId: input.workspaceId, userId: input.assigneeUserId, permission: input.permission },
    // Inside a transaction the capability is read on the shared client (same
    // READ COMMITTED visibility): a refusal writes a permission-denied
    // security event, and that write must not ride a transaction this very
    // refusal is about to roll back.
    options.inTransaction ? defaultPrisma : client,
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
    const placed = options.inTransaction
      ? await isPlacedLockingPlacement(input.workspaceId, input.assigneeUserId, client)
      : await isPlacedWorkspaceMember(
          { workspaceId: input.workspaceId, userId: input.assigneeUserId },
          client,
        );
    if (!placed) throw new AssigneeEligibilityError("NOT_PLACED");
  }
}

/**
 * The placement predicate of `isPlacedWorkspaceMember` (the owner is always
 * placed; anyone else by an EFFECTIVE membership — ACTIVE in the group and in
 * the workspace — of an ACTIVE, unarchived Collaboration Team), read under a
 * share lock on the placing rows so the placement cannot change until the
 * caller's transaction ends. Only meaningful on a transaction client.
 */
async function isPlacedLockingPlacement(
  workspaceId: string,
  userId: string,
  client: PrismaClient,
): Promise<boolean> {
  const workspace = await client.team.findUnique({
    where: { id: workspaceId },
    select: { ownerUserId: true },
  });
  if (!workspace) return false;
  if (workspace.ownerUserId === userId) return true;
  const rows = await client.$queryRaw<Array<{ id: string }>>`
    SELECT ctm.id
      FROM collaboration_team_members ctm
      JOIN collaboration_teams ct ON ct.id = ctm.team_id
     WHERE ctm.user_id = ${userId}::uuid
       AND ctm.status = 'ACTIVE'
       AND ct.workspace_id = ${workspaceId}::uuid
       AND ct.status = 'ACTIVE'
       AND ct.archived_at_utc IS NULL
       AND EXISTS (
             SELECT 1 FROM team_members tm
              WHERE tm.team_id = ${workspaceId}::uuid
                AND tm.user_id = ${userId}::uuid
                AND tm.status = 'ACTIVE'
           )
     FOR SHARE OF ctm, ct`;
  return rows.length > 0;
}

