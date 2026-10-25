/**
 * WHO MAY SEE A CASE (2026-09-29) — the restricted-case rule, once.
 *
 * Roles define capability; access lists define reach. A case is RESTRICTED
 * when it carries an access list: any `CaseAccess` row (a named member) or any
 * `CaseCollaborationTeamAccess` row (a Collaboration Team). A restricted case
 * is visible only to
 *
 *   - its owner,
 *   - the members on its CaseAccess list,
 *   - the ACTIVE members of an ACTIVE Collaboration Team granted the case;
 *
 * an unrestricted case is visible to its workspace. Workspace membership alone
 * — OWNER and ADMIN included — never reaches a restricted case: management
 * authority is not content authority (members audit ACC-01).
 *
 * EVIDENCE INHERITS IT. Evidence linked to a restricted case the caller cannot
 * see is not visible to the caller either, however broad their workspace role.
 * Before this, the case was hidden while its evidence, reports and packages
 * stayed readable by every member (ACC-01).
 *
 * This module is the NARROWING rule only. Whether the caller is a current,
 * active, unexpired member of the workspace at all is the canonical membership
 * authority's question (`evaluateMemberAccess` / `listAccessibleWorkspaces`),
 * asked first by every caller; a case owner or a list entry NEVER stands in for
 * membership.
 *
 * With no caller (a machine path) only unrestricted cases are visible.
 */
import type { Prisma } from "@prisma/client";

/** A case carrying any access list — a named member or a Collaboration Team. */
export const RESTRICTED_CASE_WHERE: Prisma.CaseWhereInput = {
  OR: [{ access: { some: {} } }, { teamAccess: { some: {} } }],
};

const UNRESTRICTED_CASE_WHERE: Prisma.CaseWhereInput = {
  AND: [{ access: { none: {} } }, { teamAccess: { none: {} } }],
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

/** What a record-level check must load to apply the rule to one case. */
export const CASE_VISIBILITY_SELECT = {
  ownerUserId: true,
  teamId: true,
  access: { select: { userId: true } },
  teamAccess: {
    select: {
      collaborationTeam: {
        select: {
          workspaceId: true,
          status: true,
          members: { select: { userId: true, status: true } },
        },
      },
    },
  },
} as const satisfies Prisma.CaseSelect;

export type CaseVisibilityRow = {
  ownerUserId: string;
  teamId: string | null;
  access: Array<{ userId: string }>;
  teamAccess: Array<{
    collaborationTeam: {
      workspaceId: string;
      status: string;
      members: Array<{ userId: string; status: string }>;
    };
  }>;
};

/**
 * The same rule for one loaded case. A team grant counts only for a team of
 * the case's OWN workspace (a grant can never carry reach across tenants).
 */
export function caseRowVisibleTo(row: CaseVisibilityRow, callerUserId: string): boolean {
  if (row.ownerUserId === callerUserId) return true;
  if (row.access.length === 0 && row.teamAccess.length === 0) return true;
  if (row.access.some((a) => a.userId === callerUserId)) return true;
  return row.teamAccess.some(
    (g) =>
      g.collaborationTeam.status === "ACTIVE" &&
      g.collaborationTeam.workspaceId === row.teamId &&
      g.collaborationTeam.members.some((m) => m.userId === callerUserId && m.status === "ACTIVE"),
  );
}
