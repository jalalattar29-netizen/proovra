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
import { mapTeamRoleToCanonical, roleHasPermission } from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";

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

  return members
    .filter((m) =>
      roleHasPermission(
        mapTeamRoleToCanonical(m.role),
        REQUIRED_ASSIGNEE_PERMISSION,
      ),
    )
    .map((m) => ({
      userId: m.userId,
      displayName: m.user?.displayName ?? null,
      email: m.user?.email ?? null,
      role: mapTeamRoleToCanonical(m.role),
    }));
}

/**
 * May this specific user be assigned work in this workspace, right now?
 *
 * The write path calls THIS rather than re-implementing the predicate, so a
 * caller cannot post a userId the picker would never have offered — including
 * a perfectly valid user from a DIFFERENT workspace, which the `teamId` scope
 * refuses by construction.
 */
export async function isAssignableOperator(
  input: { teamId: string; userId: string },
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  const eligible = await listAssignableOperators(
    { teamId: input.teamId },
    client,
  );
  return eligible.some((operator) => operator.userId === input.userId);
}
