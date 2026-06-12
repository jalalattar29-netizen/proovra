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

import type { Prisma } from "@prisma/client";

import { prisma } from "../db.js";

export type PersonalScope = {
  isPersonal: boolean;
  ownerUserId: string | null;
};

export async function resolvePersonalScope(
  teamId: string,
): Promise<PersonalScope> {
  const team = await prisma.team.findUnique({
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
): Promise<Prisma.EvidenceWhereInput> {
  const scope = await resolvePersonalScope(teamId);
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
): Promise<Prisma.CaseWhereInput> {
  const scope = await resolvePersonalScope(teamId);
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
