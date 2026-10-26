/**
 * ELIGIBLE OPERATORS FOR ASSIGNMENT (Attention Architecture closure pass).
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS REPLACES
 * ---------------------------------------------------------------------------
 * The assign route validated its target with
 *
 *     prisma.teamMember.findFirst({ where: { teamId, userId } })
 *
 * and NO status predicate. So an incident could be assigned to somebody who
 * had been SUSPENDED, REVOKED, or whose temporary access had expired — a
 * person who cannot open the workspace, let alone the condition. The work then
 * looks owned and is not, which is worse than unassigned: an unassigned
 * condition is visibly waiting, and one assigned to a departed colleague is
 * invisibly stuck.
 *
 * ---------------------------------------------------------------------------
 * TWO SEPARATE QUESTIONS, BOTH REQUIRED
 * ---------------------------------------------------------------------------
 *   1. Is this person still IN the workspace?   ACTIVE membership, live
 *                                               parent organization, unexpired
 *                                               access.
 *   2. Can they DO operational work?            they hold the acknowledge/
 *                                               resolve permission tier. A
 *                                               VIEWER may look at Operations
 *                                               and cannot act, so handing
 *                                               them a condition would create
 *                                               an owner who is not allowed to
 *                                               close it.
 *
 * Both are enforced here and re-enforced on the write path — this module
 * powers the picker AND validates the mutation, so the list an operator is
 * shown and the set the server accepts cannot drift apart.
 */

import type { PrismaClient } from "@prisma/client";
import { mapTeamRoleToCanonical } from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { evaluateAccess, loadMemberAccessSnapshot } from "../identity/access-policy.service.js";
import {
  AssigneeEligibilityError,
  assertWorkAssigneeEligible,
  assignmentRequiresPlacement,
  placedUserIdsForWorkspace,
} from "../assignment/assignee-eligibility.js";

export type AssignableOperator = {
  userId: string;
  displayName: string | null;
  email: string | null;
  /** Canonical role, so the picker can show why somebody is eligible. */
  role: string;
};

/**
 * The permission an assignee must hold to be a meaningful owner.
 *
 * `operations.acknowledge` and not `operations.assign`: the person RECEIVING
 * the work needs to be able to work it, not to be able to hand it on. Using
 * `assign` here would have restricted ownership to admins and made the
 * feature useless for the reviewers who actually do the triage.
 */
const REQUIRED_ASSIGNEE_PERMISSION = "operations.acknowledge" as const;

/**
 * Every member of `teamId` who may currently be handed operational work.
 *
 * Deliberately NOT "every user" and not "every member": the picker offers
 * exactly the set the mutation will accept.
 */
export async function listAssignableOperators(
  input: { teamId: string },
  client: PrismaClient = defaultPrisma,
): Promise<AssignableOperator[]> {
  const members = await client.teamMember.findMany({
    where: {
      teamId: input.teamId,
      // ACTIVE only. A suspended or revoked member is not an operator.
      status: "ACTIVE",
      // Temporary access that has lapsed is lapsed, whatever the row says.
      OR: [{ accessExpiresAtUtc: null }, { accessExpiresAtUtc: { gt: new Date() } }],
    },
    select: {
      userId: true,
      role: true,
      user: { select: { displayName: true, email: true } },
    },
    orderBy: [{ role: "asc" }],
  });

  // Queue work follows the one assignee rule (members audit, unassigned-member
  // decision): where placement is required, an unplaced non-owner is not an
  // operator yet — the picker never offers them and the server refuses them.
  const placementRequired = await assignmentRequiresPlacement(input.teamId, client);
  const placed = placementRequired
    ? await placedUserIdsForWorkspace(input.teamId, members.map((m) => m.userId), client)
    : null;
  // Members re-audit (second round) — the picker offers exactly whom the
  // write accepts: the permission engine's own decision over each member's
  // snapshot (role, capability grants, delegated scopes, expiry, the parent
  // Organization's lifecycle) — not a role-only rule, which hid people holding
  // the permission through a grant and offered people a suspended
  // Organization refuses. The pure evaluator records nothing: listing
  // candidates is not a permission attempt. Reach is per record and is decided
  // at the write.
  const holds = new Set<string>();
  for (const m of members) {
    const snapshot = await loadMemberAccessSnapshot({ teamId: input.teamId, userId: m.userId }, client);
    if (!snapshot) continue;
    const decision = evaluateAccess({ kind: "MEMBER", member: snapshot }, { permission: REQUIRED_ASSIGNEE_PERMISSION });
    if (decision.allowed) holds.add(m.userId);
  }
  return members
    .filter((m) => holds.has(m.userId))
    .filter((m) => placed === null || placed.has(m.userId))
    .map((m) => ({
      userId: m.userId,
      displayName: m.user?.displayName ?? null,
      email: m.user?.email ?? null,
      role: mapTeamRoleToCanonical(m.role),
    }));
}

/**
 * May this specific user be assigned this work, right now?
 *
 * THE ONE ASSIGNEE AUTHORITY decides (members re-audit 2, B4). This was a
 * second eligibility rule — the picker's role-only filter re-run per write —
 * which ignored delegated capability grants and the parent Organization's
 * lifecycle, read placement outside the write, and never asked whether the
 * person could open the record the work is about. It now asks
 * `assertWorkAssigneeEligible` with the Operations permission: an ACTIVE,
 * unexpired member of THIS workspace (another workspace's user has no
 * membership here and is refused by construction) whose role or grant holds
 * `operations.acknowledge`, who can reach the work's evidence and case when
 * it names them, and — on PRO/TEAM — is placed. Pass the write's transaction
 * client with `inTransaction: true` and the placement stays share-locked
 * until the assignment commits (B5).
 */
export async function isAssignableOperator(
  input: { teamId: string; userId: string; evidenceId?: string | null; caseId?: string | null },
  client: PrismaClient = defaultPrisma,
  options: { inTransaction?: boolean } = {},
): Promise<boolean> {
  try {
    await assertWorkAssigneeEligible(
      {
        workspaceId: input.teamId,
        assigneeUserId: input.userId,
        permission: REQUIRED_ASSIGNEE_PERMISSION,
        evidenceId: input.evidenceId ?? null,
        caseId: input.caseId ?? null,
      },
      client,
      options,
    );
    return true;
  } catch (err) {
    if (err instanceof AssigneeEligibilityError) return false;
    throw err;
  }
}
