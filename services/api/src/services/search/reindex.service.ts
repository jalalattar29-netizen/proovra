/**
 * Production-safe workspace reindex.
 *
 * The canonical workspace-scoped "fill the search index" worker. Same
 * orphan-detection + canonical-indexer-call shape as the existing
 * `POST /v1/search/reconcile` route, extracted into a service module
 * so both:
 *
 *   - the new internal endpoint `POST /v1/internal/search/reindex`
 *     (secret-gated, no user auth required), and
 *   - the production CLI `node dist/scripts/backfill-search-index.js`
 *     (no pnpm/tsx required, runs from the built API image)
 *
 * can call exactly the same code. Both surfaces MUST stay byte-equal
 * in their effect on `evidence_search_documents`, otherwise running
 * one and then the other would produce drift.
 *
 * Hard invariants
 * ---------------
 *
 *   - Reuses the CANONICAL indexers (`indexEvidence`, `indexCase`,
 *     `indexReport`, `indexPackage`, `indexNote`) — does NOT
 *     reimplement projection logic. This means every column the
 *     write-time index sites populate is identical here.
 *   - Idempotent. Every canonical indexer upserts on
 *     `(teamId, documentType, sourceId)` — re-running this is a no-op
 *     for already-current rows.
 *   - Workspace-scoped. Caller MUST pass a teamId; the service never
 *     reads cross-team data, never writes cross-team rows.
 *   - Best-effort per row. Individual failures are counted but DO NOT
 *     halt the run — the goal is "make the index as healthy as
 *     possible," not "fail the whole reindex on one bad row."
 *   - Skip deleted source records. `evidence.deleted_at IS NOT NULL`
 *     records never reach the indexer.
 *
 * Returns workspace-scoped counts so the caller (HTTP response or
 * CLI stdout) can render a meaningful summary. The shape is the
 * same envelope as `POST /v1/search/reconcile` so existing
 * monitoring/dashboards already know how to read it.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import {
  indexEvidence,
  indexIntakeLink,
} from "./evidence-indexing.service.js";
import { indexCase } from "./case-indexing.service.js";
import {
  SEARCH_PROJECTION_VERSION,
  searchIndexableLifecycleSql,
} from "@proovra/shared";
// The ONE durable reconciliation authority. Claiming the slot HERE — rather
// than at each caller — is what makes it impossible to reach the scan/index
// lifecycle without the lock: the CLI, the internal endpoint and any future
// caller all arrive through this function.
import { reconcileSearchIndex } from "@proovra/shared-runtime";
import {
  indexNote,
  indexPackage,
  indexReport,
} from "./artifact-indexing.service.js";

export type WorkspaceReindexInput = {
  teamId: string;
  /** Per-source-type ceiling. Default 10_000 — large enough to fully
   *  drain any single workspace in one call, small enough to bound
   *  memory + tx pressure. */
  batch?: number;
  /** When true (default), also index cases / reports / packages /
   *  notes. Set false to limit to Evidence only — primarily useful
   *  when debugging a single source-type's projection. */
  includeCases?: boolean;
  /** When true, log every row's outcome to the provided logger. The
   *  internal endpoint passes its request logger; the CLI passes a
   *  console-shaped logger. Default: silent. */
  verbose?: boolean;
  /** Optional logger surface — the internal endpoint uses Fastify's
   *  per-request `req.log`; the CLI uses console. Both implement
   *  `.info / .warn / .error`. */
  log?: ReindexLogger;
  /** When true, do not write — only enumerate orphans and return the
   *  plan. Used by the CLI `--dry-run` flag and by tests. */
  dryRun?: boolean;
  /** Which caller claimed the durable run slot. Recorded on the run row. */
  trigger?: "scheduler" | "api" | "cli" | "retry";
};

export type ReindexLogger = {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
  error: (obj: Record<string, unknown>, msg?: string) => void;
};

export type WorkspaceReindexResult = {
  teamId: string;
  evidence: ReindexBucket;
  cases: ReindexBucket;
  reports: ReindexBucket;
  packages: ReindexBucket;
  notes: ReindexBucket;
  /**
   * External intake REQUESTS.
   *
   * Their own family rather than a subset of evidence: a request that has
   * been sent and not answered has no evidence row to be reindexed through,
   * and it is exactly the record an operator is looking for when they type a
   * Customer ID into search.
   */
  intakeLinks: ReindexBucket;
  durationMs: number;
  dryRun: boolean;
};

export type ReindexBucket = {
  /** Source rows with NO document at all. */
  orphans: number;
  /**
   * Documents that EXIST but were written by an older build of the
   * projection, and so cannot answer questions the current builder would
   * allow. Counted apart from orphans because they are a different failure:
   * an orphan is a record search has never seen, a stale document is one
   * search answers WRONGLY, which is worse and looks like success.
   */
  stale: number;
  indexed: number;
  skipped: number;
  failed: number;
};

const NULL_LOGGER: ReindexLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function emptyBucket(): ReindexBucket {
  return { orphans: 0, stale: 0, indexed: 0, skipped: 0, failed: 0 };
}

/**
 * What a caller that did NOT win the lock reports.
 *
 * Zero everywhere, because this caller reconciled nothing. It is not a claim
 * that there was nothing to reconcile — the holder of the slot is doing it.
 */
function emptyResult(teamId: string): WorkspaceReindexResult {
  return {
    teamId,
    evidence: emptyBucket(),
    cases: emptyBucket(),
    reports: emptyBucket(),
    packages: emptyBucket(),
    notes: emptyBucket(),
    intakeLinks: emptyBucket(),
    durationMs: 0,
    dryRun: false,
  };
}

/**
 * Run a full workspace reindex. Returns counts per source-type
 * (evidence + cases + reports + packages + notes). Idempotent.
 */
/**
 * Run a workspace reindex under the durable per-workspace lock.
 *
 * Every production caller of the reindex lifecycle resolves through here, so
 * the cron sweep, the API endpoint, the internal reindex route and the backfill
 * CLI all contend for one slot. Contention is a truthful no-op — the returned
 * result reports zero work because this caller did none, not because there was
 * none to do.
 */
export async function runWorkspaceReindex(
  input: WorkspaceReindexInput,
  client: PrismaClient = defaultPrisma,
): Promise<WorkspaceReindexResult> {
  let inner: WorkspaceReindexResult | null = null;
  const outcome = await reconcileSearchIndex(client, {
    teamId: input.teamId,
    trigger: input.trigger ?? "cli",
    body: async () => {
      inner = await runWorkspaceReindexUnlocked(input, client);
      return {
        scanned:
          inner.evidence.orphans +
          inner.cases.orphans +
          inner.reports.orphans +
          inner.packages.orphans +
          inner.notes.orphans +
          inner.intakeLinks.orphans,
        indexed:
          inner.evidence.indexed +
          inner.cases.indexed +
          inner.reports.indexed +
          inner.packages.indexed +
          inner.notes.indexed +
          inner.intakeLinks.indexed,
        removed: 0,
        failed:
          inner.evidence.failed +
          inner.cases.failed +
          inner.reports.failed +
          inner.packages.failed +
          inner.notes.failed +
          inner.intakeLinks.failed,
      };
    },
  });

  if (inner) return inner;
  // Another caller holds the slot, or the body never ran. An empty result is
  // the honest report: THIS caller reconciled nothing.
  (input.log ?? NULL_LOGGER).info(
    { teamId: input.teamId, outcome: outcome.kind },
    "search.reindex.skipped_locked",
  );
  return emptyResult(input.teamId);
}

/**
 * THE REINDEX BODY, for a caller that already holds the run slot.
 *
 * `runWorkspaceReindex` above takes the durable per-workspace lock and then
 * runs this. `POST /v1/search/reconcile` takes the SAME lock itself — it
 * needs the run row for its 202-while-running answer — so it cannot call the
 * locked entry point without deadlocking against itself, and it had therefore
 * grown its own copy of the queries instead.
 *
 * That copy is why fixing the reindex did not fix the endpoint: two
 * implementations of one job, and the one an operator actually reaches was
 * the one that was not maintained. This export is what makes them one again.
 *
 * DO NOT call this without holding the slot.
 */
export async function runWorkspaceReindexBodyUnderLock(
  input: WorkspaceReindexInput,
  client: PrismaClient = defaultPrisma,
): Promise<WorkspaceReindexResult> {
  return runWorkspaceReindexUnlocked(input, client);
}

async function runWorkspaceReindexUnlocked(
  input: WorkspaceReindexInput,
  client: PrismaClient = defaultPrisma,
): Promise<WorkspaceReindexResult> {
  const start = Date.now();
  const log = input.log ?? NULL_LOGGER;
  const verbose = input.verbose === true;
  const dryRun = input.dryRun === true;
  const limit = input.batch ?? 10_000;
  const includeCases = input.includeCases !== false;
  const teamId = input.teamId;

  log.info(
    {
      teamId,
      limit,
      includeCases,
      dryRun,
      surface: "runWorkspaceReindex",
    },
    "search.reindex.start",
  );

  const evidence = emptyBucket();
  const cases = emptyBucket();
  const reports = emptyBucket();
  const packages = emptyBucket();
  const notes = emptyBucket();
  const intakeLinks = emptyBucket();

  // -------------------------------------------------------------------------
  // Evidence — find INDEXABLE rows for this team that have no
  // matching evidence_search_documents row of documentType=EVIDENCE.
  //
  // Search-inclusion-audit (trash decision): "indexable" means
  // every row EXCEPT lifecycle DESTROYED / PENDING_DESTRUCTION.
  // Soft-deleted (deletedAt IS NOT NULL but still restorable)
  // records ARE indexable and surface in search with an
  // "In trash" badge. Hard-deleted rows are physically absent
  // from `evidence` and so cannot be orphans by definition.
  // -------------------------------------------------------------------------
  // The eligibility clause is EMITTED from the shared authority, not typed
  // out here. Typed out, it was one of three copies that had to agree forever.
  /*
   * ORPHANS **AND** STALE DOCUMENTS.
   *
   * This selected only `esd.id IS NULL` — evidence with no document — so a
   * record that already had one was never revisited by ANY path: not this
   * sweep, not `POST /v1/search/reconcile`, not the cron, not the backfill
   * CLI. When the projection began indexing External Intake identity, every
   * document written before that change became permanently unable to answer
   * a Customer ID or phone query, and every subsequent reindex reported
   * success while changing nothing.
   *
   * That was proven rather than reasoned: a document with the identity
   * stripped from its body failed all four identity probes, a full workspace
   * reconcile reported 14 documents indexed, and the stripped body came back
   * byte-for-byte identical. The only way to repair one record was to delete
   * its document and reconcile again — by hand, one at a time.
   *
   * `projection_version` makes the second case visible, and it is repaired
   * by the SAME indexer, in the same bounded batch, under the same lock.
   * Orphans come first: a record search cannot see at all is a worse state
   * than one it can see incompletely, and under a batch limit the worse state
   * should be fixed first.
   */
  const staleOrMissing = await client.$queryRawUnsafe<
    Array<{ id: string; stale: boolean }>
  >(
    `
    SELECT e.id::text AS id,
           (esd.id IS NOT NULL) AS stale
      FROM evidence e
      LEFT JOIN evidence_search_documents esd
        ON esd.team_id       = e.team_id
       AND esd.document_type = 'EVIDENCE'
       AND esd.source_id     = e.id
     WHERE ${searchIndexableLifecycleSql("e.lifecycle_state")}
       AND e.team_id = $1::uuid
       AND (esd.id IS NULL OR esd.projection_version < $2)
     ORDER BY (esd.id IS NOT NULL) ASC, e.id ASC
     LIMIT $3`,
    teamId,
    SEARCH_PROJECTION_VERSION,
    limit,
  );
  evidence.orphans = staleOrMissing.filter((r) => !r.stale).length;
  evidence.stale = staleOrMissing.filter((r) => r.stale).length;

  if (!dryRun) {
    for (const row of staleOrMissing) {
      const r = await indexEvidence(
        { teamId, evidenceId: row.id },
        client,
      );
      if (r.ok) {
        evidence.indexed += 1;
        if (verbose) {
          log.info(
            { teamId, evidenceId: row.id, documentId: r.documentId },
            "search.reindex.evidence.indexed",
          );
        }
      } else {
        evidence.failed += 1;
        log.warn(
          {
            teamId,
            evidenceId: row.id,
            reason: r.reason,
            prismaCode: r.prismaCode ?? null,
            prismaMeta: r.prismaMeta ?? null,
            prismaMessage: r.prismaMessage ?? null,
          },
          "search.reindex.evidence.failed",
        );
      }
    }
  }

  if (includeCases) {
    // ---------------------------------------------------------------------
    // Cases — non-deleted-by-design (cases use a status enum, no
    // deletedAt). Orphan = no CASE-type doc in the projection.
    // ---------------------------------------------------------------------
    const orphanCases = await client.$queryRaw<Array<{ id: string }>>`
      SELECT c.id::text AS id
        FROM cases c
        LEFT JOIN evidence_search_documents esd
          ON esd.team_id      = c.team_id
         AND esd.document_type = 'CASE'
         AND esd.source_id    = c.id
       WHERE c.team_id = ${teamId}::uuid
         AND esd.id IS NULL
       LIMIT ${limit}`;
    cases.orphans = orphanCases.length;
    if (!dryRun) {
      for (const row of orphanCases) {
        const r = await indexCase({ teamId, caseId: row.id }, client);
        if (r.ok) {
          cases.indexed += 1;
        } else {
          cases.failed += 1;
          log.warn(
            {
              teamId,
              caseId: row.id,
              reason: r.reason,
              prismaCode: r.prismaCode ?? null,
              prismaMeta: r.prismaMeta ?? null,
              prismaMessage: r.prismaMessage ?? null,
            },
            "search.reindex.case.failed",
          );
        }
      }
    }

    // ---------------------------------------------------------------------
    // Reports — join through evidence so deleted evidence (which
    // implicitly hides its reports) is excluded.
    // ---------------------------------------------------------------------
    const orphanReports = await client.$queryRaw<Array<{ id: string }>>`
      SELECT r.id::text AS id
        FROM reports r
        JOIN evidence e ON e.id = r.evidence_id
        LEFT JOIN evidence_search_documents esd
          ON esd.team_id      = e.team_id
         AND esd.document_type = 'REPORT'
         AND esd.source_id    = r.id
       WHERE e.deleted_at IS NULL
         AND e.team_id = ${teamId}::uuid
         AND esd.id IS NULL
       LIMIT ${limit}`;
    reports.orphans = orphanReports.length;
    if (!dryRun) {
      for (const row of orphanReports) {
        const r = await indexReport({ reportId: row.id }, client);
        if (r.ok) {
          reports.indexed += 1;
        } else {
          reports.failed += 1;
          log.warn(
            {
              teamId,
              reportId: row.id,
              reason: r.reason,
              prismaCode: r.prismaCode ?? null,
              prismaMeta: r.prismaMeta ?? null,
              prismaMessage: r.prismaMessage ?? null,
            },
            "search.reindex.report.failed",
          );
        }
      }
    }

    // ---------------------------------------------------------------------
    // Packages — same shape as reports.
    // ---------------------------------------------------------------------
    const orphanPackages = await client.$queryRaw<Array<{ id: string }>>`
      SELECT p.id::text AS id
        FROM verification_packages p
        JOIN evidence e ON e.id = p.evidence_id
        LEFT JOIN evidence_search_documents esd
          ON esd.team_id      = e.team_id
         AND esd.document_type = 'PACKAGE'
         AND esd.source_id    = p.id
       WHERE e.deleted_at IS NULL
         AND e.team_id = ${teamId}::uuid
         AND esd.id IS NULL
       LIMIT ${limit}`;
    packages.orphans = orphanPackages.length;
    if (!dryRun) {
      for (const row of orphanPackages) {
        const r = await indexPackage({ packageId: row.id }, client);
        if (r.ok) {
          packages.indexed += 1;
        } else {
          packages.failed += 1;
          log.warn(
            {
              teamId,
              packageId: row.id,
              reason: r.reason,
              prismaCode: r.prismaCode ?? null,
              prismaMeta: r.prismaMeta ?? null,
              prismaMessage: r.prismaMessage ?? null,
            },
            "search.reindex.package.failed",
          );
        }
      }
    }

    // ---------------------------------------------------------------------
    // Notes — case_comments. Cascade is via team_id directly (notes
    // don't have a deletedAt either).
    // ---------------------------------------------------------------------
    const orphanNotes = await client.$queryRaw<Array<{ id: string }>>`
      SELECT cc.id::text AS id
        FROM case_comments cc
        LEFT JOIN evidence_search_documents esd
          ON esd.team_id      = cc.team_id
         AND esd.document_type = 'NOTE'
         AND esd.source_id    = cc.id
       WHERE cc.team_id = ${teamId}::uuid
         AND esd.id IS NULL
       LIMIT ${limit}`;
    notes.orphans = orphanNotes.length;
    if (!dryRun) {
      for (const row of orphanNotes) {
        const r = await indexNote({ noteId: row.id }, client);
        if (r.ok) {
          notes.indexed += 1;
        } else {
          notes.failed += 1;
          log.warn(
            {
              teamId,
              noteId: row.id,
              reason: r.reason,
              prismaCode: r.prismaCode ?? null,
              prismaMeta: r.prismaMeta ?? null,
              prismaMessage: r.prismaMessage ?? null,
            },
            "search.reindex.note.failed",
          );
        }
      }
    }

    // ---------------------------------------------------------------------
    // External intake requests.
    //
    // ORPHANS **AND** STALE, the same way evidence is swept and for the same
    // reason: this document type is new, so on the first run after deploy
    // every existing request in the workspace is an orphan, and a later
    // change to what the body holds must be able to reach the documents
    // already written. Both cases are repaired by the same indexer, under
    // the same lock, inside the same batch limit — orphans first, because a
    // request search cannot see at all is worse than one it sees
    // incompletely.
    //
    // No lifecycle exclusion: revoked, expired and archived requests stay
    // indexed. They are the ones an operator asking "what happened with this
    // customer" needs most, and the row carries the state so the surface can
    // say which it is.
    // ---------------------------------------------------------------------
    const staleOrMissingLinks = await client.$queryRawUnsafe<
      Array<{ id: string; stale: boolean }>
    >(
      `
      SELECT l.id::text AS id,
             (esd.id IS NOT NULL) AS stale
        FROM workflow_intake_links l
        LEFT JOIN evidence_search_documents esd
          ON esd.team_id       = l.team_id
         AND esd.document_type = 'INTAKE_LINK'
         AND esd.source_id     = l.id
       WHERE l.team_id = $1::uuid
         AND (esd.id IS NULL OR esd.projection_version < $2)
       ORDER BY (esd.id IS NOT NULL) ASC, l.id ASC
       LIMIT $3`,
      teamId,
      SEARCH_PROJECTION_VERSION,
      limit,
    );
    intakeLinks.orphans = staleOrMissingLinks.filter((r) => !r.stale).length;
    intakeLinks.stale = staleOrMissingLinks.filter((r) => r.stale).length;
    if (!dryRun) {
      for (const row of staleOrMissingLinks) {
        const r = await indexIntakeLink(
          { teamId, intakeLinkId: row.id },
          client,
        );
        if (r.ok) {
          intakeLinks.indexed += 1;
        } else {
          intakeLinks.failed += 1;
          log.warn(
            {
              teamId,
              intakeLinkId: row.id,
              reason: r.reason,
            },
            "search.reindex.intake_link.failed",
          );
        }
      }
    }
  }

  const result: WorkspaceReindexResult = {
    teamId,
    evidence,
    cases,
    reports,
    packages,
    notes,
    intakeLinks,
    durationMs: Date.now() - start,
    dryRun,
  };
  log.info(
    {
      teamId,
      durationMs: result.durationMs,
      evidenceIndexed: evidence.indexed,
      caseIndexed: cases.indexed,
      reportIndexed: reports.indexed,
      packageIndexed: packages.indexed,
      noteIndexed: notes.indexed,
      intakeLinkIndexed: intakeLinks.indexed,
      dryRun,
    },
    "search.reindex.complete",
  );
  return result;
}
