/**
 * RECORD REACH FOR LISTS — the canonical list scopes for Cases and Evidence.
 *
 * Not a new rule: a composition of the two authorities that already decide
 * one record at a time (members audit ACC-02 / ACC-03 / ACC-04):
 *
 *   1. WHICH WORKSPACES — `listAccessibleWorkspaces`: ACTIVE membership,
 *      unexpired access, provable kind, live organization. A suspended,
 *      revoked, removed or expired member contributes no workspace at all.
 *   2. WHICH RECORDS INSIDE THEM — `case-visibility.ts`: a restricted Case
 *      admits its owner, its CaseAccess list and the active members of an
 *      ACTIVE Collaboration Team granted it; Evidence inherits that.
 *
 * Before this, the case list, case detail, evidence list, Evidence Library
 * summary and duplicate detection each OR-ed in "cases I own", "cases I was
 * granted" and "evidence I created" with NO membership condition, so a former
 * member kept seeing those records; and the workspace arm read every record
 * of every case, restricted or not.
 *
 * Personal-scope records (no workspace binding) stay owner-only.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { listAccessibleWorkspaces } from "./accessible-workspaces.js";
import {
  caseVisibleToWhere,
  evidenceVisibleThroughCasesWhere,
} from "../cases/case-visibility.js";

/**
 * WHICH RECORDS OF ONE WORKSPACE ARE CLOSED TO THIS CALLER — the same rule,
 * answered as id lists, for the surfaces that cannot join the Case or Evidence
 * relation: raw SQL (the investigation graph, the aggregators) and denormalised
 * rows that hold an evidence id with no relation (search documents, discussion
 * threads, signals). Pass `null` for a machine path: only unrestricted records
 * stay open.
 *
 * It is not a second predicate: both lists are `case-visibility.ts` applied by
 * the database. The caller must already have established workspace authority.
 */
export type HiddenRecordIds = {
  caseIds: string[];
  evidenceIds: string[];
};

type HiddenRecordClient = Pick<PrismaClient, "case" | "evidence">;

export async function hiddenRecordIdsInWorkspace(
  workspaceId: string,
  callerUserId: string | null,
  client: HiddenRecordClient = defaultPrisma,
): Promise<HiddenRecordIds> {
  const [cases, evidence] = await Promise.all([
    client.case.findMany({
      // NOT visible already implies restricted (caseVisibleToWhere admits
      // every unrestricted Case), by the canonical rule rather than the flag.
      where: { teamId: workspaceId, NOT: caseVisibleToWhere(callerUserId) },
      select: { id: true },
    }),
    client.evidence.findMany({
      where: { teamId: workspaceId, NOT: evidenceVisibleThroughCasesWhere(callerUserId) },
      select: { id: true },
    }),
  ]);
  return { caseIds: cases.map((c) => c.id), evidenceIds: evidence.map((e) => e.id) };
}

export async function accessibleWorkspaceIdsFor(
  userId: string,
  client: PrismaClient = defaultPrisma,
): Promise<string[]> {
  return (await listAccessibleWorkspaces({ userId }, client)).map((w) => w.workspaceId);
}

/** Cases this user may see, across every workspace they may currently operate in. */
export function caseReachWhere(
  userId: string,
  accessibleWorkspaceIds: readonly string[],
): Prisma.CaseWhereInput {
  const or: Prisma.CaseWhereInput[] = [{ teamId: null, ownerUserId: userId }];
  if (accessibleWorkspaceIds.length > 0) {
    or.push({
      AND: [{ teamId: { in: [...accessibleWorkspaceIds] } }, caseVisibleToWhere(userId)],
    });
  }
  return { OR: or };
}

/** Evidence this user may see, across every workspace they may currently operate in. */
export function evidenceReachWhere(
  userId: string,
  accessibleWorkspaceIds: readonly string[],
): Prisma.EvidenceWhereInput {
  const or: Prisma.EvidenceWhereInput[] = [{ teamId: null, ownerUserId: userId }];
  if (accessibleWorkspaceIds.length > 0) {
    or.push({
      AND: [
        { teamId: { in: [...accessibleWorkspaceIds] } },
        evidenceVisibleThroughCasesWhere(userId),
      ],
    });
  }
  return { OR: or };
}
