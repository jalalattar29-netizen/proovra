import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";

/**
 * PHASE 10 §item-2 — EXECUTABLE OrganizationSecurityPolicy convergence readiness.
 *
 * Queries the `org_security_policy_conflicts` view (Organizations whose collapsed
 * workspace policy rows disagreed on security-material values). A non-empty
 * result means the org-scoping migration cannot safely pick a winner — the
 * deployment gate FAILS CLOSED (exits non-zero) until an operator reconciles.
 * Returns INTERNAL organization ids only (no public tenant data).
 */
export type PolicyConvergenceReadiness = {
  ready: boolean;
  conflictOrganizationIds: string[];
};

export async function checkOrgSecurityPolicyReadiness(
  client: PrismaClient = defaultPrisma,
): Promise<PolicyConvergenceReadiness> {
  const rows = (await client.$queryRawUnsafe(
    'SELECT organization_id FROM org_security_policy_conflicts',
  )) as Array<{ organization_id: string }>;
  const conflictOrganizationIds = rows.map((r) => r.organization_id);
  return { ready: conflictOrganizationIds.length === 0, conflictOrganizationIds };
}
