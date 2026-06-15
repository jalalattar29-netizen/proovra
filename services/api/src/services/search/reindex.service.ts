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
 * Run a full workspace reindex. Returns counts per source-type
 * (evidence + cases + reports + packages + notes). Idempotent.
 */
export async function runWorkspaceReindex(
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
  // Evidence — find non-deleted rows for this team that have no
  // matching evidence_search_documents row of documentType=EVIDENCE.
  // -------------------------------------------------------------------------
  const orphanEvidence = await client.$queryRaw<Array<{ id: string }>>`
    SELECT e.id::text AS id
      FROM evidence e
      LEFT JOIN evidence_search_documents esd
        ON esd.team_id      = e.team_id
       AND esd.document_type = 'EVIDENCE'
       AND esd.source_id    = e.id
     WHERE e.deleted_at IS NULL
       AND e.team_id = ${teamId}::uuid
       AND esd.id IS NULL
     LIMIT ${limit}`;
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
