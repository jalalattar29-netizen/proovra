/**
 * Phase 2.7X Stage 2 — Organization compatibility resolver.
 *
 * Dual-read helper that returns the Organization context for a given
 * team/workspace WITHOUT changing runtime behavior. Endpoints (Stage 3+)
 * will call this helper to obtain an `OrgContext` value object that
 * carries the org id, role of the current user (if any), and a
 * `fallbackToTeam` flag indicating whether the team has no org yet.
 *
 * Hard rules:
 *   - This module is READ-ONLY. It never creates, updates, or deletes
 *     Organization rows.
 *   - It NEVER mutates RBAC. Org role information is reported but the
 *     caller decides how/whether to use it.
 *   - It is fail-open: if the org tables are missing data (or the FK
 *     is null), the caller still gets a coherent `OrgContext` with
 *     `fallbackToTeam=true` so legacy endpoints keep working.
 *   - It does NOT cross workspaces. A team is bound to AT MOST one
 *     organization. If a team has org_id=null, the helper synthesizes
 *     a stable "personal-team" context view but does not invent a
 *     persistent org.
 *
 * Design rationale (Phase 2.7 §10 dual-read):
 *   - Stage 2 backfilled every existing team to an org_of_1. Stage 5
 *     will tighten teams.organization_id to NOT NULL, but until then
 *     legacy code paths must still work on un-backfilled teams (e.g.
 *     newly-created teams between Stage 5 design and its migration).
 *   - The `fallbackToTeam` boolean documents this: every caller who
 *     branches on `ctx.fallbackToTeam` is explicitly acknowledging
 *     the legacy code path. Stage 5 will grep for and remove these
 *     branches.
 */

import type { PrismaClient } from "@prisma/client";

/** Stable union of org roles surfaced to callers. */
export type OrgRole =
  | "ORG_OWNER"
  | "ORG_ADMIN"
  | "ORG_SECURITY_ADMIN"
  | "ORG_BILLING_ADMIN"
  | "ORG_AUDITOR"
  | "ORG_MEMBER";

/**
 * Result of `resolveOrgContextForTeam`. Always coherent; never throws.
 */
export type OrgContext = {
  /**
   * The bound team id. ALWAYS present — this is the workspace
   * boundary that every existing RBAC check uses. Org membership is
   * an ADDITIONAL signal layered on top, never a replacement.
   */
  teamId: string;
  /**
   * The bound organization id, or null when the team has no
   * org link yet (only happens for teams created between Stage 2
   * backfill and Stage 5 NOT NULL enforcement, plus any future
   * un-backfilled rows).
   */
  organizationId: string | null;
  /**
   * The user's org role, or null when:
   *   - userId is undefined (anonymous request) OR
   *   - the team has no org OR
   *   - the user is not a member of the org.
   *
   * **IMPORTANT:** A non-null orgRole does NOT grant evidence access,
   * case access, or reviewer authority. It is an org-level governance
   * signal only. RBAC decisions remain bound to team_members /
   * case_access / evidence ownership / reviewer assignments.
   */
  orgRole: OrgRole | null;
  /**
   * True when the team is not linked to any organization. Callers
   * that branch on this are explicitly opting in to the legacy
   * (Team-only) code path.
   */
  fallbackToTeam: boolean;
};

/**
 * Resolve the organization context for a team.
 *
 * Returns null only if the team itself doesn't exist. For any
 * existing team, returns a coherent `OrgContext` even when the
 * team has no org link.
 *
 * @param prisma  Prisma client (must use the live DB adapter — does
 *                NOT validate host classification, that's the
 *                wrapper's job).
 * @param input   `{ teamId, userId? }`
 */
export async function resolveOrgContextForTeam(
  prisma: PrismaClient,
  input: { teamId: string; userId?: string },
): Promise<OrgContext | null> {
  const { teamId, userId } = input;

  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: { id: true, organizationId: true },
  });
  if (!team) return null;

  if (!team.organizationId) {
    return {
      teamId: team.id,
      organizationId: null,
      orgRole: null,
      fallbackToTeam: true,
    };
  }

  // Org is bound. Look up the user's role if a userId was passed.
  let orgRole: OrgRole | null = null;
  if (userId) {
    // ARCH-004 — only an ACTIVE membership confers a role. A suspended or
    // revoked member resolves to `orgRole: null`, which every consumer already
    // treats as "no governance authority here".
    const membership = await prisma.organizationMembership.findFirst({
      where: {
        organizationId: team.organizationId,
        userId,
        status: "ACTIVE",
      },
      select: { role: true },
    });
    if (membership) {
      orgRole = membership.role as OrgRole;
    }
  }

  return {
    teamId: team.id,
    organizationId: team.organizationId,
    orgRole,
    fallbackToTeam: false,
  };
}

/**
 * Inverse lookup: given an organization id, return the bound team
 * ids. Multi-team organizations are not yet supported (Stage 2
 * creates 1:1 orgs) but the API returns an array to keep callers
 * future-compatible.
 */
export async function listTeamIdsForOrg(
  prisma: PrismaClient,
  orgId: string,
): Promise<string[]> {
  const rows = await prisma.team.findMany({
    where: { organizationId: orgId },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => r.id);
}

/**
 * Org membership lookup. Returns the list of orgs the user belongs
 * to, with the user's role in each. Used by the future Stage 4
 * org-switcher UI.
 */
export async function listOrgMembershipsForUser(
  prisma: PrismaClient,
  userId: string,
): Promise<{ organizationId: string; orgName: string; role: OrgRole }[]> {
  // ARCH-004 — the switcher lists Organizations the user may actually enter.
  // A suspended or revoked membership must disappear from it, not appear and
  // then refuse on arrival.
  const rows = await prisma.organizationMembership.findMany({
    where: { userId, status: "ACTIVE" },
    select: {
      organizationId: true,
      role: true,
      organization: { select: { name: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({
    organizationId: r.organizationId,
    orgName: r.organization.name,
    role: r.role as OrgRole,
  }));
}

/**
 * Capability assertion for an org-scoped action. Returns true only
 * when the user has at least the required role IN the bound org.
 * Does NOT grant or check evidence/case/reviewer access — those
 * remain team-scoped.
 *
 * Use this for org-level governance actions (renaming the org,
 * managing org-level policies, viewing org-level audit events).
 * Do NOT use this for any data-plane access.
 */
const ORG_ROLE_PRECEDENCE: Record<OrgRole, number> = {
  ORG_OWNER: 5,
  ORG_ADMIN: 4,
  ORG_SECURITY_ADMIN: 3,
  ORG_BILLING_ADMIN: 3,
  ORG_AUDITOR: 2,
  ORG_MEMBER: 1,
};

export function orgRoleSatisfies(
  actualRole: OrgRole | null,
  requiredRole: OrgRole,
): boolean {
  if (actualRole === null) return false;
  return ORG_ROLE_PRECEDENCE[actualRole] >= ORG_ROLE_PRECEDENCE[requiredRole];
}
