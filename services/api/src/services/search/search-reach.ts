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

import { hiddenRecordIdsInWorkspace } from "../access/record-reach.js";

type ReachClient = Pick<PrismaClient, "case" | "evidence" | "team" | "caseEvidenceLink" | "$queryRaw">;

/**
 * The most ids one inlined list may carry: below PostgreSQL's bind-parameter
 * ceiling (65,535 per statement) with room for the rest of the query.
 */
export const SEARCH_REACH_EXCLUSION_LIMIT = 20_000;

/**
 * T-132 (audit JRN-09) — raised only when BOTH the hidden and the visible
 * document sets of one workspace exceed the inline bound for one caller
 * (more than 20,000 index rows on each side). Search then answers an explicit
 * refusal, never a silent "no results" and never a hidden row.
 */
export class SearchReachTooLargeError extends Error {
  readonly statusCode = 503;
  readonly code = "SEARCH_SCOPE_TOO_LARGE";
  constructor() {
    super("Search is not available for this workspace scope right now.");
    this.name = "SearchReachTooLargeError";
  }
}

export async function searchDocumentReachWhere(
  client: ReachClient,
  workspaceId: string,
  actorUserId: string,
): Promise<Prisma.EvidenceSearchDocumentWhereInput> {
  const { caseIds: hiddenCases, evidenceIds: hiddenEvidence } = await hiddenRecordIdsInWorkspace(
    workspaceId,
    actorUserId,
    client,
  );
  /*
   * T-132 — past the inline bound the audited code answered `id in []`: a
   * member off more than 20,000 restricted records found NOTHING, for every
   * query. The exclusion is now resolved by the database instead, with each
   * hidden-id list bound as ONE array parameter (`= ANY($n::uuid[])`, no
   * bound): the index rows of this workspace that name a hidden Case or
   * record. The smaller side (those hidden rows, or the rows left visible) is
   * then applied as the id filter, so the rule stays part of the WHERE (no
   * post-filter; counts, facets and page lengths never see a hidden row).
   */
  if (hiddenCases.length + hiddenEvidence.length > SEARCH_REACH_EXCLUSION_LIMIT) {
    const hiddenDocs = await client.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM evidence_search_documents
       WHERE team_id = ${workspaceId}::uuid
         AND (case_id = ANY(${hiddenCases}::uuid[]) OR evidence_id = ANY(${hiddenEvidence}::uuid[]))
       LIMIT ${SEARCH_REACH_EXCLUSION_LIMIT + 1}::int`;
    if (hiddenDocs.length <= SEARCH_REACH_EXCLUSION_LIMIT) {
      return hiddenDocs.length > 0 ? { AND: [{ id: { notIn: hiddenDocs.map((d) => d.id) } }] } : {};
    }
    const visibleDocs = await client.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM evidence_search_documents
       WHERE team_id = ${workspaceId}::uuid
         AND (case_id IS NULL OR NOT (case_id = ANY(${hiddenCases}::uuid[])))
         AND (evidence_id IS NULL OR NOT (evidence_id = ANY(${hiddenEvidence}::uuid[])))
       LIMIT ${SEARCH_REACH_EXCLUSION_LIMIT + 1}::int`;
    if (visibleDocs.length <= SEARCH_REACH_EXCLUSION_LIMIT) {
      return { AND: [{ id: { in: visibleDocs.map((d) => d.id) } }] };
    }
    throw new SearchReachTooLargeError();
  }
  const and: Prisma.EvidenceSearchDocumentWhereInput[] = [];
  if (hiddenCases.length > 0) {
    and.push({
      OR: [{ caseId: null }, { caseId: { notIn: hiddenCases } }],
    });
  }
  if (hiddenEvidence.length > 0) {
    and.push({
      OR: [
        { evidenceId: null },
        { evidenceId: { notIn: hiddenEvidence } },
      ],
    });
  }
  return and.length > 0 ? { AND: and } : {};
}
