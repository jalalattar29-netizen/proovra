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
import { indexEvidence } from "./evidence-indexing.service.js";
import { indexCase } from "./case-indexing.service.js";
import { searchIndexableLifecycleSql } from "@proovra/shared";
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
  durationMs: number;
  dryRun: boolean;
};

export type ReindexBucket = {
  orphans: number;
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
  return { orphans: 0, indexed: 0, skipped: 0, failed: 0 };
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
          inner.notes.orphans,
        indexed:
          inner.evidence.indexed +
          inner.cases.indexed +
          inner.reports.indexed +
          inner.packages.indexed +
          inner.notes.indexed,
        removed: 0,
        failed:
          inner.evidence.failed +
          inner.cases.failed +
          inner.reports.failed +
          inner.packages.failed +
          inner.notes.failed,
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
  const orphanEvidence = await client.$queryRawUnsafe<Array<{ id: string }>>(
    `
    SELECT e.id::text AS id
      FROM evidence e
      LEFT JOIN evidence_search_documents esd
        ON esd.team_id      = e.team_id
       AND esd.document_type = 'EVIDENCE'
       AND esd.source_id    = e.id
     WHERE ${searchIndexableLifecycleSql("e.lifecycle_state")}
       AND e.team_id = $1::uuid
       AND esd.id IS NULL
     LIMIT $2`,
    teamId,
    limit,
  );
  evidence.orphans = orphanEvidence.length;

  if (!dryRun) {
    for (const row of orphanEvidence) {
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
  }

  const result: WorkspaceReindexResult = {
    teamId,
    evidence,
    cases,
    reports,
    packages,
    notes,
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
      dryRun,
    },
    "search.reindex.complete",
  );
  return result;
}
