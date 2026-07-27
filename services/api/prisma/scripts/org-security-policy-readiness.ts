/**
 * PHASE 10 §item-2 — DEPLOYMENT READINESS COMMAND for OrganizationSecurityPolicy
 * org-scoping convergence. Exits NON-ZERO when any Customer Organization has a
 * divergent-conflict policy (must be reconciled before the org-scoping migration
 * is applied). Wire into the deployment gate:
 *
 *   npx tsx prisma/scripts/org-security-policy-readiness.ts
 *
 * Exit 0 = ready (no conflicts). Exit 1 = conflicts (internal org ids logged).
 */

import { PrismaClient } from "@prisma/client";

import { checkOrgSecurityPolicyReadiness } from "../../src/services/identity/org-security-policy-readiness.js";

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const result = await checkOrgSecurityPolicyReadiness(prisma);
    if (result.ready) {
      // eslint-disable-next-line no-console
      console.log("[org-security-policy-readiness] OK — no convergence conflicts.");
      process.exit(0);
    }
    // eslint-disable-next-line no-console
    console.error(
      `[org-security-policy-readiness] CONFLICT — ${result.conflictOrganizationIds.length} organization(s) require reconciliation: ${result.conflictOrganizationIds.join(", ")}`,
    );
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
