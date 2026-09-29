/**
 * SEARCH-DRIFT ISOLATION FOR INTEGRATION SUITES.
 *
 * The search-index reconciler's tick is GLOBAL by design — production must
 * reconcile every workspace that drifted — and its counters (workspaces
 * reconciled / failed / locked, and whether the tick is healthy) describe that
 * whole population. The integration suites run serially against one database,
 * so every workspace an EARLIER suite left with drifting evidence is part of
 * that population too. A suite that asserts "no workspace could be claimed"
 * or "no workspace failed" was therefore measuring other suites' leftovers,
 * and passed only on a fresh database.
 *
 * This takes every workspace OTHER than the suite's own out of the drift
 * population, the same way the suites already take one of their own out
 * (evidence DESTROYED, its EVIDENCE documents gone). It changes test data in
 * the disposable integration database only; the reconciler is untouched.
 */
import type { PrismaClient } from "@prisma/client";

export async function quiesceSearchDriftOutside(
  prisma: PrismaClient,
  keepTeamIds: readonly string[],
): Promise<void> {
  const keep = [...new Set(keepTeamIds)];
  await prisma.$executeRawUnsafe(
    `DELETE FROM "evidence_search_documents"
      WHERE "document_type" = 'EVIDENCE'
        AND "team_id" IS NOT NULL
        AND NOT ("team_id" = ANY($1::uuid[]))`,
    keep,
  );
  await prisma.$executeRawUnsafe(
    `UPDATE "evidence"
        SET "lifecycle_state" = 'DESTROYED'
      WHERE "team_id" IS NOT NULL
        AND NOT ("team_id" = ANY($1::uuid[]))
        AND "lifecycle_state" <> 'DESTROYED'`,
    keep,
  );
}
