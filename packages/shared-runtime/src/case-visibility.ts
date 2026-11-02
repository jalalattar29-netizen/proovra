/**
 * THE RESTRICTED-CASE RULE AS A QUERY, for both the API and the worker.
 *
 * The narrative of the rule lives in the API's `services/cases/case-visibility.ts`,
 * which re-exports these. They sit here because a worker build reads records on
 * behalf of the person who asked for it and must apply the same rule, not a copy.
 */
import type { Prisma } from "@prisma/client";

/** A restricted case — flagged, or carrying any access list. */
export const RESTRICTED_CASE_WHERE: Prisma.CaseWhereInput = {
  OR: [{ restrictedAtUtc: { not: null } }, { access: { some: {} } }, { teamAccess: { some: {} } }],
};

const UNRESTRICTED_CASE_WHERE: Prisma.CaseWhereInput = {
  AND: [{ restrictedAtUtc: null }, { access: { none: {} } }, { teamAccess: { none: {} } }],
};

/**
 * The grant a Collaboration Team confers: only while the team is ACTIVE, and
 * only to its ACTIVE members. An archived team, or a suspended/removed group
 * member, confers nothing.
 */
function teamGrantReaches(callerUserId: string): Prisma.CaseCollaborationTeamAccessWhereInput {
  return {
    collaborationTeam: {
      status: "ACTIVE",
      members: { some: { userId: callerUserId, status: "ACTIVE" } },
    },
  };
}

export function caseVisibleToWhere(callerUserId: string | null | undefined): Prisma.CaseWhereInput {
  return callerUserId
    ? {
        OR: [
          UNRESTRICTED_CASE_WHERE,
          { access: { some: { userId: callerUserId } } },
          { teamAccess: { some: teamGrantReaches(callerUserId) } },
          { ownerUserId: callerUserId },
        ],
      }
    : UNRESTRICTED_CASE_WHERE;
}

/**
 * Evidence the caller may see THROUGH its cases: no link to a restricted case
 * the caller cannot see. AND it with the workspace scope; it never widens it.
 */
export function evidenceVisibleThroughCasesWhere(
  callerUserId: string | null | undefined,
): Prisma.EvidenceWhereInput {
  return {
    caseLinks: {
      none: {
        case: { AND: [RESTRICTED_CASE_WHERE, { NOT: caseVisibleToWhere(callerUserId) }] },
      },
    },
  };
}
