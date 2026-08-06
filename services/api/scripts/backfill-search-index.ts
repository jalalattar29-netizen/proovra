/**
 * Phase SEARCH-REMEDIATION — backfill evidence_search_documents.
 *
 * Idempotent walk over every non-deleted Evidence row that calls
 * `indexEvidence({ teamId, evidenceId })` per row. The indexer
 * upserts on `(teamId, documentType, sourceId)` so re-running this
 * script is safe.
 *
 * Why this exists: the indexing pipeline was wired only into the
 * `completeEvidence` finalize fanout, which is bypassed by every
 * seed/dev-populate script AND fails silently when the BullMQ
 * worker is offline. The result was a search index with **0 rows**
 * for 622 evidence records — empirically verified by direct DB
 * query during the audit. After this backfill runs once, the
 * matching reconciliation sweeper (see
 * `services/api/src/services/search/reconciliation.service.ts`)
 * keeps the index healthy.
 *
 * Usage:
 *   pnpm --filter proovra-api exec tsx scripts/backfill-search-index.ts
 *   pnpm --filter proovra-api exec tsx scripts/backfill-search-index.ts --batch 50
 *   pnpm --filter proovra-api exec tsx scripts/backfill-search-index.ts --team <teamId>
 *
 * Flags:
 *   --batch N       Batch size (default 100)
 *   --team <id>     Scope to one workspace (default: all teams)
 *   --dry-run       Print plan without writing
 *   --include-cases Also index cases / reports / packages (Phase B)
 *
 * Exit codes:
 *   0  success (all reachable rows indexed or already current)
 *   1  fatal error
 */

import { prisma } from "../src/db.js";
import { indexEvidence } from "../src/services/search/evidence-indexing.service.js";
import { indexCase } from "../src/services/search/case-indexing.service.js";
import {
  indexNote,
  indexPackage,
  indexReport,
} from "../src/services/search/artifact-indexing.service.js";

type Flags = {
  batch: number;
  team: string | null;
  dryRun: boolean;
  includeCases: boolean;
  includeAll: boolean;
};

function parseFlags(argv: string[]): Flags {
  const out: Flags = {
    batch: 100,
    team: null,
    dryRun: false,
    includeCases: false,
    includeAll: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--batch") {
      out.batch = Math.max(1, Number(argv[++i]));
    } else if (a === "--team") {
      out.team = argv[++i] ?? null;
    } else if (a === "--dry-run") {
      out.dryRun = true;
    } else if (a === "--include-cases") {
      out.includeCases = true;
    } else if (a === "--all") {
      // Phase SEARCH-REMEDIATION-2 — convenience flag that runs
      // every projection (evidence + cases + reports + packages +
      // notes). Use this on a fresh dev DB or after a major
      // schema change.
      out.includeCases = true;
      out.includeAll = true;
    }
  }
  return out;
}

async function backfillEvidence(flags: Flags): Promise<{
  scanned: number;
  indexed: number;
  skipped: number;
  failed: number;
}> {
  const where: { deletedAt: null; teamId?: string } = { deletedAt: null };
  if (flags.team) where.teamId = flags.team;

  const total = await prisma.evidence.count({ where });
  console.log(`[backfill] evidence total to consider: ${total}`);

  let cursor: string | undefined;
  let scanned = 0;
  let indexed = 0;
  let skipped = 0;
  let failed = 0;

  // Cursor pagination: terminates when a page comes back empty. The cursor
  // is a strictly increasing primary key (`skip: 1`), so the scan is finite.
  for (;;) {
    const page = await prisma.evidence.findMany({
      where,
      select: { id: true, teamId: true, title: true, displayFileName: true },
      orderBy: { id: "asc" },
      take: flags.batch,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1].id;

    for (const row of page) {
      scanned += 1;
      if (!row.teamId) {
        skipped += 1;
        continue;
      }
      if (flags.dryRun) {
        const sample = row.title ?? row.displayFileName ?? "(unnamed)";
        console.log(`[dry-run] would index ${row.id} (${sample})`);
        continue;
      }
      try {
        const result = await indexEvidence({
          teamId: row.teamId,
          evidenceId: row.id,
        });
        if (result.ok) {
          indexed += 1;
        } else {
          skipped += 1;
        }
      } catch (err) {
        failed += 1;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[backfill] FAILED ${row.id}: ${msg.slice(0, 200)}`);
      }
    }
    console.log(
      `[backfill] progress  scanned=${scanned}/${total}  indexed=${indexed}  skipped=${skipped}  failed=${failed}`,
    );
  }

  return { scanned, indexed, skipped, failed };
}

async function backfillCases(flags: Flags): Promise<{
  scanned: number;
  indexed: number;
  skipped: number;
  failed: number;
}> {
  const where: Record<string, unknown> = {};
  if (flags.team) where.teamId = flags.team;

  const total = await prisma.case.count({ where });
  console.log(`[backfill] case total to consider: ${total}`);

  let cursor: string | undefined;
  let scanned = 0;
  let indexed = 0;
  let skipped = 0;
  let failed = 0;

  // Cursor pagination: terminates when a page comes back empty. The cursor
  // is a strictly increasing primary key (`skip: 1`), so the scan is finite.
  for (;;) {
    const page = await prisma.case.findMany({
      where,
      select: { id: true, teamId: true, name: true },
      orderBy: { id: "asc" },
      take: flags.batch,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1].id;

    for (const row of page) {
      scanned += 1;
      if (!row.teamId) {
        skipped += 1;
        continue;
      }
      if (flags.dryRun) {
        console.log(`[dry-run] would index case ${row.id} (${row.name})`);
        continue;
      }
      try {
        const result = await indexCase({ teamId: row.teamId, caseId: row.id });
        if (result.ok) indexed += 1;
        else skipped += 1;
      } catch (err) {
        failed += 1;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[backfill] CASE FAILED ${row.id}: ${msg.slice(0, 200)}`);
      }
    }
    console.log(
      `[backfill] case progress  scanned=${scanned}/${total}  indexed=${indexed}  skipped=${skipped}  failed=${failed}`,
    );
  }

  return { scanned, indexed, skipped, failed };
}

async function backfillArtifacts(
  flags: Flags,
  kind: "REPORT" | "PACKAGE" | "NOTE",
): Promise<{ scanned: number; indexed: number; skipped: number; failed: number }> {
  let scanned = 0;
  let indexed = 0;
  let skipped = 0;
  let failed = 0;
  let cursor: string | undefined;

  // Cursor pagination: terminates when a page comes back empty. The cursor
  // is a strictly increasing primary key (`skip: 1`), so the scan is finite.
  for (;;) {
    let rows: Array<{ id: string }>;
    if (kind === "REPORT") {
      rows = await prisma.report.findMany({
        where: flags.team
          ? { evidence: { teamId: flags.team } }
          : undefined,
        select: { id: true },
        orderBy: { id: "asc" },
        take: flags.batch,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
    } else if (kind === "PACKAGE") {
      rows = await prisma.verificationPackage.findMany({
        where: flags.team
          ? { evidence: { teamId: flags.team } }
          : undefined,
        select: { id: true },
        orderBy: { id: "asc" },
        take: flags.batch,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
    } else {
      rows = await prisma.caseComment.findMany({
        where: flags.team ? { teamId: flags.team } : undefined,
        select: { id: true },
        orderBy: { id: "asc" },
        take: flags.batch,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
    }
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      scanned += 1;
      if (flags.dryRun) {
        console.log(`[dry-run] would index ${kind} ${row.id}`);
        continue;
      }
      try {
        const r =
          kind === "REPORT"
            ? await indexReport({ reportId: row.id })
            : kind === "PACKAGE"
              ? await indexPackage({ packageId: row.id })
              : await indexNote({ noteId: row.id });
        if (r.ok) indexed += 1;
        else skipped += 1;
      } catch (err) {
        failed += 1;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[backfill] ${kind} FAILED ${row.id}: ${msg.slice(0, 200)}`);
      }
    }
    console.log(
      `[backfill] ${kind} progress  scanned=${scanned}  indexed=${indexed}  skipped=${skipped}  failed=${failed}`,
    );
  }

  return { scanned, indexed, skipped, failed };
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  console.log(
    `[backfill] flags=${JSON.stringify(flags)}  ${flags.dryRun ? "(DRY RUN)" : ""}`,
  );

  const evidenceResult = await backfillEvidence(flags);
  console.log("[backfill] evidence done", evidenceResult);

  if (flags.includeCases) {
    const caseResult = await backfillCases(flags);
    console.log("[backfill] cases done", caseResult);
  }
  if (flags.includeAll) {
    for (const kind of ["REPORT", "PACKAGE", "NOTE"] as const) {
      const r = await backfillArtifacts(flags, kind);
      console.log(`[backfill] ${kind} done`, r);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill] FATAL", err);
    process.exit(1);
  });
