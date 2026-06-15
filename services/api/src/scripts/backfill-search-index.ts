#!/usr/bin/env node
/**
 * Production-safe `evidence_search_documents` backfill CLI.
 *
 * INVOCATION (production — no pnpm / no tsx required):
 *
 *   node dist/scripts/backfill-search-index.js \
 *     --team <teamId> \
 *     [--include-cases] \
 *     [--batch <N>] \
 *     [--dry-run]
 *
 * Default in PRODUCTION: `--team` is REQUIRED. The "all teams" sweep
 * (no `--team`) is gated behind `--all-teams` to make accidental
 * cluster-wide reindexing impossible with a typo.
 *
 * Why this entrypoint lives in `src/scripts` (not the repo-root
 * `scripts/` directory):
 *
 *   - The API tsconfig.build.json's rootDir is `src`. Files outside
 *     `src/` are NOT compiled into `dist/`. To ship a `node`-runnable
 *     CLI in the production Docker image (which contains only `dist/`
 *     + production node_modules), the entry point MUST live under
 *     `src/`. This is the same pattern the existing
 *     `src/services/...` modules use.
 *
 *   - The existing `scripts/backfill-search-index.ts` (repo-root)
 *     remains as the developer-mode `tsx` entry; in PROD use the
 *     `dist/scripts/backfill-search-index.js` produced from THIS
 *     file. Both call the SAME canonical
 *     `runWorkspaceReindex()` service, so they cannot drift.
 *
 * Hard guarantees:
 *
 *   - Only depends on production `node_modules` (`@prisma/client`,
 *     `pino`, etc.). No `tsx`, no `ts-node`, no devDeps.
 *   - Idempotent. Re-running for the same team is a no-op for
 *     already-current rows.
 *   - Workspace-scoped. CANNOT write cross-team rows.
 *   - Does NOT modify source records (Evidence, Case, Report,
 *     Package, Note). Only `evidence_search_documents`.
 *   - Skips deleted evidence (evidence.deleted_at IS NOT NULL).
 *   - Continues on per-row failure; prints a summary at the end.
 *
 * Exit codes:
 *
 *   0  success — every reachable row indexed or already current
 *   1  fatal error (DB connection, missing flag, etc.)
 *   2  partial success — some rows failed (still wrote the rest)
 */

import { runWorkspaceReindex } from "../services/search/reindex.service.js";
import { prisma } from "../db.js";

type Flags = {
  team: string | null;
  batch: number;
  includeCases: boolean;
  dryRun: boolean;
  allTeams: boolean;
  verbose: boolean;
};

function parseFlags(argv: string[]): Flags {
  const out: Flags = {
    team: null,
    batch: 10_000,
    includeCases: false,
    dryRun: false,
    allTeams: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--team") {
      out.team = argv[++i] ?? null;
    } else if (a === "--batch") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 1) {
        throw new Error(`Invalid --batch value`);
      }
      out.batch = Math.min(50_000, Math.max(1, Math.floor(n)));
    } else if (a === "--include-cases") {
      out.includeCases = true;
    } else if (a === "--all" || a === "--include-all") {
      // Convenience alias — matches the legacy
      // `services/api/scripts/backfill-search-index.ts` flag.
      out.includeCases = true;
    } else if (a === "--all-teams") {
      // Cluster-wide opt-in. Required to run without --team.
      out.allTeams = true;
    } else if (a === "--dry-run") {
      out.dryRun = true;
    } else if (a === "--verbose" || a === "-v") {
      out.verbose = true;
    } else if (a === "--help" || a === "-h") {
      // eslint-disable-next-line no-console
      console.log(usage());
      process.exit(0);
    } else if (a.startsWith("--")) {
      throw new Error(`Unknown flag: ${a}`);
    }
  }
  return out;
}

function usage(): string {
  return [
    "Usage: node dist/scripts/backfill-search-index.js [flags]",
    "",
    "Flags:",
    "  --team <uuid>       Workspace to reindex (REQUIRED unless --all-teams)",
    "  --include-cases     Also index cases / reports / packages / notes",
    "  --batch <N>         Max rows per source-type (default 10000)",
    "  --all-teams         Reindex every workspace (USE WITH CARE)",
    "  --dry-run           Enumerate orphans without writing",
    "  --verbose, -v       Log every row outcome",
    "  --help, -h          Show this message",
  ].join("\n");
}

const consoleLog = {
  // eslint-disable-next-line no-console
  info: (obj: Record<string, unknown>, msg?: string) =>
    console.log(JSON.stringify({ level: "info", msg, ...obj })),
  // eslint-disable-next-line no-console
  warn: (obj: Record<string, unknown>, msg?: string) =>
    console.warn(JSON.stringify({ level: "warn", msg, ...obj })),
  // eslint-disable-next-line no-console
  error: (obj: Record<string, unknown>, msg?: string) =>
    console.error(JSON.stringify({ level: "error", msg, ...obj })),
};

async function runForTeam(flags: Flags, teamId: string) {
  const result = await runWorkspaceReindex({
    teamId,
    includeCases: flags.includeCases,
    batch: flags.batch,
    dryRun: flags.dryRun,
    verbose: flags.verbose,
    log: consoleLog,
  });
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        level: "info",
        msg: "search.reindex.summary",
        teamId,
        durationMs: result.durationMs,
        dryRun: result.dryRun,
        evidence: result.evidence,
        cases: result.cases,
        reports: result.reports,
        packages: result.packages,
        notes: result.notes,
      },
      null,
      2,
    ),
  );
  const failed =
    result.evidence.failed +
    result.cases.failed +
    result.reports.failed +
    result.packages.failed +
    result.notes.failed;
  return failed;
}

async function main() {
  let flags: Flags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : String(err));
    // eslint-disable-next-line no-console
    console.error(usage());
    process.exit(1);
  }

  if (!flags.team && !flags.allTeams) {
    // eslint-disable-next-line no-console
    console.error(
      "Refusing to run: pass --team <uuid> or --all-teams explicitly.",
    );
    // eslint-disable-next-line no-console
    console.error(usage());
    process.exit(1);
  }

  let totalFailed = 0;
  try {
    if (flags.team) {
      totalFailed += await runForTeam(flags, flags.team);
    } else if (flags.allTeams) {
      const teams = await prisma.team.findMany({
        select: { id: true, name: true, isPersonal: true },
        orderBy: { id: "asc" },
      });
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          level: "info",
          msg: "search.reindex.all_teams.start",
          teamCount: teams.length,
        }),
      );
      for (const t of teams) {
        totalFailed += await runForTeam(flags, t.id);
      }
    }
  } catch (err) {
    consoleLog.error(
      { err: err instanceof Error ? err.message : String(err) },
      "search.reindex.cli.fatal",
    );
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  }

  await prisma.$disconnect().catch(() => {});
  if (totalFailed > 0) {
    // Partial success — some rows didn't index. Operator should
    // inspect the logs and rerun for the failed sources.
    process.exit(2);
  }
  process.exit(0);
}

// Only auto-execute when invoked as the script entrypoint. When this
// module is imported by tests, the `main()` block does NOT run.
const isDirectInvocation =
  typeof process !== "undefined" &&
  process.argv[1] &&
  /backfill-search-index(\.[cm]?js)?$/.test(process.argv[1]);
if (isDirectInvocation) {
  // Top-level await is fine; tsconfig targets ESM with NodeNext.
  await main();
}

export {
  // Exported for tests — the same function the CLI's main() calls
  // when given a single --team.
  runWorkspaceReindex,
};
