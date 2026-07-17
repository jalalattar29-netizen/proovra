/**
 * Phase 2.7X Stage 3 — Organization access gates.
 *
 * Pure-data helpers (no Fastify dep) that the route layer composes
 * into preHandlers. Kept separate from
 * `organization-resolver.service.ts` because resolution and
 * authorization are different concerns and this module is the
 * single point where "user X may read org Y at level Z" is decided.
 *
 * Hard rules (carried over from Stage 2):
 *
 *   - Org membership grants ONLY org-level governance reads.
 *   - Org membership NEVER grants evidence access, case access,
 *     reviewer authority, or any data-plane permission. Those
 *     remain bound to team_members / case_access / evidence
 *     ownership / reviewer assignments.
 *   - Cross-org enumeration MUST return the same response shape as
 *     "org doesn't exist" so non-members cannot infer org existence
 *     by observing the response code. The Phase 2.6B/C/D pattern
 *     used here: 403 for authed non-members on a real org, 404 for
 *     truly missing org. Either is acceptable from the route's
 *     standpoint; defense-in-depth happens at the test layer.
 *   - This module is READ-ONLY. No org rows are mutated here.
 */

import type { PrismaClient } from "@prisma/client";
import type { OrgRole } from "./organization-resolver.service.js";

/** Precedence — `ORG_OWNER` is highest, `ORG_MEMBER` is lowest. */
const ORG_ROLE_PRECEDENCE: Record<OrgRole, number> = {
  ORG_OWNER: 5,
  ORG_ADMIN: 4,
  ORG_SECURITY_ADMIN: 3,
  ORG_BILLING_ADMIN: 3,
  ORG_AUDITOR: 2,
  ORG_MEMBER: 1,
};

export type OrgAccessOutcome =
  | { kind: "ok"; orgId: string; role: OrgRole }
  | { kind: "not_found" }
  | { kind: "forbidden" };

/**
 * Resolve whether `userId` has at least `minRole` in org `orgId`.
 *
 * - Returns `{kind:"not_found"}` if the org doesn't exist (route
 *   layer SHOULD still respond 403 for defense-in-depth, but this
 *   helper distinguishes the case for logging).
 * - Returns `{kind:"forbidden"}` if the user is not a member, or
 *   is a member at a lower precedence than `minRole`.
 * - Returns `{kind:"ok"}` if the membership exists at sufficient
 *   precedence.
 *
 * Does NOT throw. Caller is the source of truth for HTTP status.
 */
export async function checkOrgAccess(
  prisma: PrismaClient,
  input: { orgId: string; userId: string; minRole?: OrgRole },
): Promise<OrgAccessOutcome> {
  const minRole: OrgRole = input.minRole ?? "ORG_MEMBER";
  const requiredRank = ORG_ROLE_PRECEDENCE[minRole];

  const org = await prisma.organization.findUnique({
    where: { id: input.orgId },
    select: { id: true, status: true },
  });
  if (!org) return { kind: "not_found" };
  // Lifecycle Phase 6 — a closed (ARCHIVED) organization is dark for
  // every org surface at once. Memberships are retained for history but
  // grant nothing anymore.
  if (org.status === "ARCHIVED") return { kind: "forbidden" };

  const membership = await prisma.organizationMembership.findFirst({
    where: { organizationId: input.orgId, userId: input.userId },
    select: { role: true },
  });
  if (!membership) return { kind: "forbidden" };

  const actualRole = membership.role as OrgRole;
  const actualRank = ORG_ROLE_PRECEDENCE[actualRole];
  if (actualRank < requiredRank) return { kind: "forbidden" };

  return { kind: "ok", orgId: input.orgId, role: actualRole };
}

/**
 * Convenience matrix shape consumed by future capability surfaces.
 * Phase 2.7X Stage 3 emits the same role precedence the access
 * gate uses, so any UI / docs / tests checking the precedence
 * pulls from one source of truth.
 */
export const ORG_ROLE_CATALOG = [
  { id: "ORG_OWNER", label: "Owner", rank: ORG_ROLE_PRECEDENCE.ORG_OWNER },
  { id: "ORG_ADMIN", label: "Admin", rank: ORG_ROLE_PRECEDENCE.ORG_ADMIN },
  {
    id: "ORG_SECURITY_ADMIN",
    label: "Security admin",
    rank: ORG_ROLE_PRECEDENCE.ORG_SECURITY_ADMIN,
  },
  {
    id: "ORG_BILLING_ADMIN",
    label: "Billing admin",
    rank: ORG_ROLE_PRECEDENCE.ORG_BILLING_ADMIN,
  },
  { id: "ORG_AUDITOR", label: "Auditor", rank: ORG_ROLE_PRECEDENCE.ORG_AUDITOR },
  { id: "ORG_MEMBER", label: "Member", rank: ORG_ROLE_PRECEDENCE.ORG_MEMBER },
] as const;
