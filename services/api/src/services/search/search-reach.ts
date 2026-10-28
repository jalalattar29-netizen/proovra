/**
 * SEARCH OBEYS CASE REACH (members experience audit, 2026-10-27).
 *
 * `evidence_search_documents` is a denormalised index: a row carries the
 * workspace (`teamId`) and the ids of the Case and Evidence it describes, and
 * no relation to either. Every search read filtered on the workspace and the
 * reviewer-restricted flag only — and the indexers always write that flag
 * false — so a member left off a restricted Case's access list could type a
 * word from its title and read back the Case's title, summary and id, and the
 * evidence linked to it. Workspace membership alone must never reach a
 * restricted Case; every other list (cases, evidence, reports, inbox) already
 * applies `case-visibility.ts`.
 *
 * This is not a second rule. It asks the same authority which restricted
 * Cases in THIS workspace the actor cannot see, and which Evidence that hides
 * (`evidenceVisibleThroughCasesWhere`), and excludes documents naming either.
 * The exclusion is part of the WHERE clause, never a post-filter, so a hidden
 * record cannot surface through a count, a facet or a page length either.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

import {
  caseVisibleToWhere,
  evidenceVisibleThroughCasesWhere,
} from "../cases/case-visibility.js";

type ReachClient = Pick<PrismaClient, "case" | "evidence">;

/** Below PostgreSQL's bind-parameter ceiling with room for the rest of the query. */
export const SEARCH_REACH_EXCLUSION_LIMIT = 20_000;

export async function searchDocumentReachWhere(
  client: ReachClient,
  workspaceId: string,
  actorUserId: string,
): Promise<Prisma.EvidenceSearchDocumentWhereInput> {
  const [hiddenCases, hiddenEvidence] = await Promise.all([
    client.case.findMany({
      // NOT visible already implies restricted (caseVisibleToWhere admits
      // every unrestricted Case), by the canonical rule rather than the flag.
      where: { teamId: workspaceId, NOT: caseVisibleToWhere(actorUserId) },
      select: { id: true },
    }),
    client.evidence.findMany({
      where: { teamId: workspaceId, NOT: evidenceVisibleThroughCasesWhere(actorUserId) },
      select: { id: true },
    }),
  ]);
  /*
   * The exclusion is inlined. A member off restricted Cases holding more
   * Evidence than one statement can carry is refused EVERY match rather than
   * shown any hidden row: the bound fails closed and never truncates the
   * list (an SQL-side NOT EXISTS is the follow-up that removes the bound).
   */
  if (hiddenCases.length + hiddenEvidence.length > SEARCH_REACH_EXCLUSION_LIMIT) {
    return { AND: [{ id: { in: [] } }] };
  }
  const and: Prisma.EvidenceSearchDocumentWhereInput[] = [];
  if (hiddenCases.length > 0) {
    and.push({
      OR: [{ caseId: null }, { caseId: { notIn: hiddenCases.map((c) => c.id) } }],
    });
  }
  if (hiddenEvidence.length > 0) {
    and.push({
      OR: [
        { evidenceId: null },
        { evidenceId: { notIn: hiddenEvidence.map((e) => e.id) } },
      ],
    });
  }
  return and.length > 0 ? { AND: and } : {};
}
