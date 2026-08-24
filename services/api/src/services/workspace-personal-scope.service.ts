/**
 * Phase HOME-DATA-OWNERSHIP — personal-workspace read fallback.
 *
 * History: until this phase the capture write path stored personal
 * evidence with `team_id = NULL` ("NULL means personal"), while the
 * Home dashboard reads by the personal Team row's UUID. The write path
 * now stamps a real team id on every new row and the backfill script
 * (`scripts/backfill-personal-team-ownership.ts`) migrates legacy NULL
 * rows — but reads must stay correct on databases where the backfill
 * has not run yet (local checkouts, restored snapshots).
 *
 * `resolvePersonalScope(teamId)` answers one question: "is this teamId
 * a personal workspace, and who owns it?" Read endpoints use it to
 * widen `WHERE team_id = X` into
 *
 *   WHERE team_id = X OR (owner_user_id = <owner> AND team_id IS NULL)
 *
 * for personal workspaces ONLY. Real team workspaces keep the strict
 * teamId filter — the fallback can never leak cross-tenant data
 * because a personal team has exactly one owner and the OR arm is
 * bound to that owner's userId.
 *
 * Read-only. Never mutates. Safe to call on every request (single
 * indexed primary-key lookup).
 */

import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../db.js";

export type PersonalScope = {
  isPersonal: boolean;
  ownerUserId: string | null;
};

/**
 * The client is optional and defaults to the module prisma. It exists so a
 * caller that already holds a transaction — or a test with an in-memory fake —
 * resolves the scope through the SAME connection it runs its query on, rather
 * than silently reaching a second one.
 */
export async function resolvePersonalScope(
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<PersonalScope> {
  const team = await client.team.findUnique({
    where: { id: teamId },
    select: { isPersonal: true, ownerUserId: true },
  });
  return {
    isPersonal: team?.isPersonal === true,
    ownerUserId: team?.ownerUserId ?? null,
  };
}

/**
 * Workspace filter for Evidence reads. Personal workspaces include the
 * owner's legacy `team_id NULL` rows; team workspaces are strict.
 */
export async function workspaceEvidenceWhere(
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<Prisma.EvidenceWhereInput> {
  const scope = await resolvePersonalScope(teamId, client);
  if (scope.isPersonal && scope.ownerUserId) {
    return {
      OR: [
        { teamId },
        { AND: [{ ownerUserId: scope.ownerUserId }, { teamId: null }] },
      ],
    };
  }
  return { teamId };
}

/**
 * Workspace filter for Case reads — same contract as
 * `workspaceEvidenceWhere`, typed for the Case model.
 */
export async function workspaceCaseWhere(
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<Prisma.CaseWhereInput> {
  const scope = await resolvePersonalScope(teamId, client);
  if (scope.isPersonal && scope.ownerUserId) {
    return {
      OR: [
        { teamId },
        { AND: [{ ownerUserId: scope.ownerUserId }, { teamId: null }] },
      ],
    };
  }
  return { teamId };
}
