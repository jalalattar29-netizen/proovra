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

import { workspaceCaseWhere, workspaceEvidenceWhere } from "@proovra/shared-runtime";

import { prisma as defaultPrisma } from "../../db.js";
import { listAccessibleWorkspaces } from "./accessible-workspaces.js";
import {
  RESTRICTED_CASE_WHERE,
  caseVisibleToWhere,
  evidenceVisibleThroughCasesWhere,
} from "../cases/case-visibility.js";

/**
 * CLOSED RECORDS, FOUND FROM THE CASES THAT CLOSE THEM (capacity, 2026-11-03).
 *
 * `NOT evidenceVisibleThroughCasesWhere` asks, for every record of the scope,
 * whether one of its links reaches a restricted case the caller cannot see. On
 * the capacity fixture that was one correlated probe per record: 1.7 s for a
 * 300,000-record workspace, on every command center, search and summary, when
 * the answer was "none". This asks the same question from the other end: the
 * links whose case is restricted and closed to the caller, inside the scope.
 * Same predicate, same rows; the planner starts from the few restricted cases
 * instead of from every record.
 */
function closedThroughCaseLinkWhere(callerUserId: string | null): Prisma.CaseEvidenceLinkWhereInput {
  return { case: { AND: [RESTRICTED_CASE_WHERE, { NOT: caseVisibleToWhere(callerUserId) }] } };
}

export async function closedEvidenceIdsIn(
  scope: Prisma.EvidenceWhereInput,
  callerUserId: string | null,
  client: Pick<PrismaClient, "caseEvidenceLink">,
): Promise<string[]> {
  const links = await client.caseEvidenceLink.findMany({
    where: { AND: [closedThroughCaseLinkWhere(callerUserId), { evidence: scope }] },
    select: { evidenceId: true },
    distinct: ["evidenceId"],
  });
  return links.map((l) => l.evidenceId);
}

/**
 * Above this many closed records an id list stops being the cheaper filter, so
 * the relation filter is used as before. Below it the list is exact.
 */
const CLOSED_ID_LIST_LIMIT = 2_000;

/** The same narrowing as `evidenceVisibleThroughCasesWhere`, from a resolved list. */
function visibleGivenClosedIds(
  closedIds: readonly string[],
  callerUserId: string | null,
): Prisma.EvidenceWhereInput {
  if (closedIds.length === 0) return {};
  if (closedIds.length > CLOSED_ID_LIST_LIMIT) return evidenceVisibleThroughCasesWhere(callerUserId);
  return { id: { notIn: [...closedIds] } };
}

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

type HiddenRecordClient = Pick<PrismaClient, "case" | "evidence" | "team" | "caseEvidenceLink">;

export async function hiddenRecordIdsInWorkspace(
  workspaceId: string,
  callerUserId: string | null,
  client: HiddenRecordClient = defaultPrisma,
): Promise<HiddenRecordIds> {
  // The workspace population the reads use, so a Personal workspace's legacy
  // NULL-team record is hidden by the same rule as one carrying its team id. The
  // scope helpers read `team` only, which the narrowed client type guarantees.
  const scopeClient = client as PrismaClient;
  const [caseScope, evidenceScope] = await Promise.all([
    workspaceCaseWhere(workspaceId, scopeClient),
    workspaceEvidenceWhere(workspaceId, scopeClient),
  ]);
  const [cases, evidenceIds] = await Promise.all([
    client.case.findMany({
      // NOT visible already implies restricted (caseVisibleToWhere admits
      // every unrestricted Case), by the canonical rule rather than the flag.
      where: { AND: [caseScope], NOT: caseVisibleToWhere(callerUserId) },
      select: { id: true },
    }),
    closedEvidenceIdsIn(evidenceScope, callerUserId, client),
  ]);
  return { caseIds: cases.map((c) => c.id), evidenceIds };
}

/**
 * One caller's reach inside one workspace, for a surface that reads many
 * models: relation filters where a relation exists, id lists where it does not.
 * Every piece is `case-visibility.ts`; none of it is a separate rule.
 */
export type ViewerReach = {
  evidence: Prisma.EvidenceWhereInput;
  cases: Prisma.CaseWhereInput;
  hidden: HiddenRecordIds;
};

export async function viewerReachInWorkspace(
  workspaceId: string,
  callerUserId: string | null,
  client: HiddenRecordClient = defaultPrisma,
): Promise<ViewerReach> {
  const hidden = await hiddenRecordIdsInWorkspace(workspaceId, callerUserId, client);
  return {
    // Every consumer ANDs this with this workspace's scope, which is the scope
    // the list was resolved in, so the id list and the relation filter select
    // the same records.
    evidence: visibleGivenClosedIds(hidden.evidenceIds, callerUserId),
    cases: caseVisibleToWhere(callerUserId),
    hidden,
  };
}

/** An id column may be NULL, and `NOT IN` drops NULL rows: keep them explicitly. */
function nullableNotIn<K extends string>(column: K, ids: string[]) {
  return ids.length === 0
    ? []
    : [{ OR: [{ [column]: null }, { [column]: { notIn: ids } }] }];
}

/** An operational incident that names a closed record is that record's row. */
export function incidentInReach(reach: ViewerReach): Prisma.OperationalIncidentWhereInput {
  return { AND: nullableNotIn("relatedEvidenceId", reach.hidden.evidenceIds) };
}

/** A legal hold names a record or a case; either may be closed to the caller. */
export function holdInReach(reach: ViewerReach): Prisma.EvidenceLegalHoldWhereInput[] {
  return [
    ...nullableNotIn("evidenceId", reach.hidden.evidenceIds),
    ...nullableNotIn("caseId", reach.hidden.caseIds),
  ];
}

/** For a row whose evidence id is required and has no relation. */
export function evidenceIdInReach(reach: ViewerReach): { evidenceId?: { notIn: string[] } } {
  return reach.hidden.evidenceIds.length > 0 ? { evidenceId: { notIn: reach.hidden.evidenceIds } } : {};
}

/**
 * The review workflows of closed records, for rows that name a workflow with no
 * relation to it (disagreements, QC samples).
 */
export async function hiddenWorkflowIdsInWorkspace(
  workspaceId: string,
  callerUserId: string | null,
  client: Pick<PrismaClient, "evidenceReviewWorkflow"> = defaultPrisma,
): Promise<string[]> {
  const rows = await client.evidenceReviewWorkflow.findMany({
    where: { teamId: workspaceId, NOT: { evidence: evidenceVisibleThroughCasesWhere(callerUserId) } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** True when this record exists and a restricted case closes it to the caller. */
export async function evidenceClosedTo(
  evidenceId: string,
  callerUserId: string | null,
  client: Pick<PrismaClient, "evidence"> = defaultPrisma,
): Promise<boolean> {
  const closed = await client.evidence.count({
    where: { id: evidenceId, NOT: evidenceVisibleThroughCasesWhere(callerUserId) },
  });
  return closed > 0;
}

/** True when this case exists and is restricted away from the caller. */
export async function caseClosedTo(
  caseId: string,
  callerUserId: string | null,
  client: Pick<PrismaClient, "case"> = defaultPrisma,
): Promise<boolean> {
  const closed = await client.case.count({
    where: { id: caseId, NOT: caseVisibleToWhere(callerUserId) },
  });
  return closed > 0;
}

/** Keep a record list to what the caller may open, for a list stored as JSON ids. */
export function allOpen(ids: readonly string[], closedIds: readonly string[]): boolean {
  return !ids.some((id) => closedIds.includes(id));
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

/**
 * `evidenceReachWhere` with the restricted-case narrowing resolved first, for
 * the reads that count or sort a whole workspace (the Evidence Library list and
 * its summary). Same records; see `closedEvidenceIdsIn`.
 */
export async function resolvedEvidenceReachWhere(
  userId: string,
  accessibleWorkspaceIds: readonly string[],
  client: Pick<PrismaClient, "caseEvidenceLink"> = defaultPrisma,
): Promise<Prisma.EvidenceWhereInput> {
  const or: Prisma.EvidenceWhereInput[] = [{ teamId: null, ownerUserId: userId }];
  if (accessibleWorkspaceIds.length > 0) {
    const inWorkspaces: Prisma.EvidenceWhereInput = { teamId: { in: [...accessibleWorkspaceIds] } };
    const closed = await closedEvidenceIdsIn(inWorkspaces, userId, client);
    or.push({ AND: [inWorkspaces, visibleGivenClosedIds(closed, userId)] });
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
