#!/usr/bin/env node
/**
 * Phase 2.5D — Destructive migration detection.
 *
 * Scans all `*.sql` files under `prisma/migrations/` and classifies
 * each migration's content into one of four risk levels:
 *
 *   SAFE        — purely additive (CREATE TABLE / CREATE INDEX /
 *                 CREATE TYPE / ALTER TABLE ADD COLUMN with safe
 *                 defaults).
 *   WARNING     — non-destructive but lock-risky (CREATE INDEX
 *                 without CONCURRENTLY on a large table, ALTER
 *                 COLUMN TYPE on a populated column).
 *   DESTRUCTIVE — DROP TABLE / DROP COLUMN / DROP TYPE /
 *                 TRUNCATE / ALTER COLUMN DROP NOT NULL on a
 *                 populated column.
 *   BLOCKED     — patterns that no migration should ever contain
 *                 (e.g. DROP DATABASE, DROP SCHEMA cascade).
 *
 * Output: a structured summary to stdout + a per-file table.
 * Exit codes let CI branch on the failure mode.
 *
 * Exit codes:
 *   0  all migrations are SAFE
 *   1  internal error (file read failure, parse error)
 *   9  at least one BLOCKED pattern found
 *   10 at least one DESTRUCTIVE pattern found (no BLOCKED)
 *   11 at least one WARNING pattern found (no DESTRUCTIVE / BLOCKED)
 *
 * Hard rules:
 *   - The scanner is conservative: pattern matches are line-based
 *     and don't understand multi-line SQL. False positives are
 *     preferred to false negatives.
 *   - The scanner is read-only. It never opens a DB connection.
 *   - Pattern lists are explicit (no "everything not in safe list");
 *     this prevents accidental false-negatives on novel SQL.
 *
 * Usage:
 *   node scripts/migration-risk-scan.mjs
 *   node scripts/migration-risk-scan.mjs --strict   # WARNING also fails
 *   node scripts/migration-risk-scan.mjs --json     # machine-readable output
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
// Phase 2.7X Stage 2 — runtime-protected tables that exist in the
// live DB but are not in schema.prisma (the "drift catalog"). Any
// destructive op on one of these is BLOCKED, not just DESTRUCTIVE,
// because dropping them would break runtime even though the
// schema-level scanner would otherwise call them "destructive but
// allowed with backup ack".
import {
  PROTECTED_RUNTIME_TABLES,
  findProtectedDestructiveOps,
} from "./protected-runtime-tables.mjs";

const MIGRATIONS_ROOT = resolve(process.cwd(), "prisma/migrations");

// ---------------------------------------------------------------------------
// Patterns
//
// Each pattern is an object with `re` (RegExp, case-insensitive,
// line-matched) and `label`. The classifier walks the file
// line-by-line and accumulates the highest-severity match.
// ---------------------------------------------------------------------------

const BLOCKED = [
  { re: /\bdrop\s+database\b/i, label: "DROP DATABASE" },
  { re: /\bdrop\s+schema\s+\S+\s+cascade\b/i, label: "DROP SCHEMA CASCADE" },
  { re: /\bdrop\s+role\b/i, label: "DROP ROLE" },
];

const DESTRUCTIVE = [
  { re: /\bdrop\s+table\b/i, label: "DROP TABLE" },
  { re: /\balter\s+table\s+[\S]+\s+drop\s+column\b/i, label: "DROP COLUMN" },
  { re: /\bdrop\s+type\b/i, label: "DROP TYPE" },
  { re: /\btruncate\s+table\b/i, label: "TRUNCATE TABLE" },
  { re: /\btruncate\s+\S+\s+cascade\b/i, label: "TRUNCATE CASCADE" },
  // ALTER TYPE that REMOVES a value is destructive; ADD VALUE is safe.
  // Postgres only allows ADD VALUE, never REMOVE — so we match the
  // verb names defensively.
  { re: /\balter\s+type\s+\S+\s+rename\s+value\b/i, label: "ALTER TYPE RENAME VALUE" },
];

const WARNING = [
  // Lock-risk operations: indexes / NOT NULL / unique on populated
  // tables. The scanner flags them so the operator can confirm the
  // migration is intended for off-hours / small tables.
  {
    re: /\bcreate\s+(unique\s+)?index\b(?!.*\bconcurrently\b)/i,
    label: "CREATE INDEX without CONCURRENTLY",
  },
  {
    re: /\balter\s+table\s+\S+\s+alter\s+column\s+\S+\s+set\s+not\s+null\b/i,
    label: "ALTER COLUMN SET NOT NULL",
  },
  {
    re: /\balter\s+table\s+\S+\s+alter\s+column\s+\S+\s+type\b/i,
    label: "ALTER COLUMN TYPE",
  },
  {
    re: /\balter\s+table\s+\S+\s+add\s+constraint\s+\S+\s+unique\b/i,
    label: "ADD CONSTRAINT UNIQUE",
  },
  {
    re: /\balter\s+table\s+\S+\s+add\s+constraint\s+\S+\s+foreign\s+key\b(?!.*\bnot\s+valid\b)/i,
    label: "ADD FOREIGN KEY without NOT VALID",
  },
];

const SAFE_HINTS = [
  // These are positive signals — they bump nothing up, but help the
  // operator confirm the migration is additive.
  { re: /^create\s+table\b/i, label: "CREATE TABLE" },
  { re: /^create\s+type\b/i, label: "CREATE TYPE" },
  { re: /^create\s+index\s+.*\bconcurrently\b/i, label: "CREATE INDEX CONCURRENTLY" },
  { re: /^alter\s+table\s+\S+\s+add\s+column\b/i, label: "ADD COLUMN" },
];

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

function readMigrationFiles() {
  const out = [];
  let entries;
  try {
    entries = readdirSync(MIGRATIONS_ROOT);
  } catch (err) {
    console.error(
      `[migration-risk-scan] cannot read migrations directory ${MIGRATIONS_ROOT}: ${(err)?.message ?? err}`,
    );
    process.exit(1);
  }
  for (const entry of entries) {
    const full = join(MIGRATIONS_ROOT, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const sqlPath = join(full, "migration.sql");
      try {
        const content = readFileSync(sqlPath, "utf8");
        out.push({ name: entry, path: sqlPath, content });
      } catch {
        /* migration directory without migration.sql */
      }
    }
  }
  return out;
}

function scanFile(content) {
  const blockedHits = [];
  const destructiveHits = [];
  const warningHits = [];
  const safeHints = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("--")) continue;
    for (const p of BLOCKED) if (p.re.test(line)) blockedHits.push({ ...p, line });
    for (const p of DESTRUCTIVE) if (p.re.test(line)) destructiveHits.push({ ...p, line });
    for (const p of WARNING) if (p.re.test(line)) warningHits.push({ ...p, line });
    for (const p of SAFE_HINTS) if (p.re.test(line)) safeHints.push({ ...p, line });
  }
  // Phase 2.7X Stage 2 — protected-runtime-table guard.
  // Any destructive op on a table in the drift catalog is UPGRADED
  // from DESTRUCTIVE to BLOCKED. This closes the structural risk
  // class discovered in Stage 1 (prisma migrate diff proposed
  // DROP TABLE on 13 runtime-critical tables not in schema.prisma).
  const protectedHits = findProtectedDestructiveOps(content);
  for (const hit of protectedHits) {
    blockedHits.push({
      label: `PROTECTED_RUNTIME_TABLE ${hit.op} on "${hit.table}"`,
      line: hit.line,
    });
  }
  let level = "SAFE";
  if (blockedHits.length > 0) level = "BLOCKED";
  else if (destructiveHits.length > 0) level = "DESTRUCTIVE";
  else if (warningHits.length > 0) level = "WARNING";
  return { level, blockedHits, destructiveHits, warningHits, safeHints };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const strictMode = args.includes("--strict");
const jsonMode = args.includes("--json");

const files = readMigrationFiles();
const report = files.map((f) => ({
  migration: f.name,
  ...scanFile(f.content),
}));

if (jsonMode) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} else {
  process.stdout.write("\n");
  process.stdout.write("───────────────────────────────────────────────────────────────\n");
  process.stdout.write("  PROOVRA migration risk scan (Phase 2.5D + 2.7X Stage 2)\n");
  process.stdout.write("───────────────────────────────────────────────────────────────\n");
  process.stdout.write(`  scanned: ${report.length} migration files\n`);
  process.stdout.write(
    `  protected runtime tables (drift catalog): ${PROTECTED_RUNTIME_TABLES.length}\n`,
  );
  process.stdout.write("───────────────────────────────────────────────────────────────\n");
  for (const r of report) {
    const summary = [
      `B:${r.blockedHits.length}`,
      `D:${r.destructiveHits.length}`,
      `W:${r.warningHits.length}`,
    ].join(" ");
    process.stdout.write(`  [${r.level.padEnd(11, " ")}] ${r.migration} (${summary})\n`);
    for (const h of r.blockedHits) {
      process.stdout.write(`      BLOCKED:     ${h.label}  — line: ${h.line.slice(0, 80)}\n`);
    }
    for (const h of r.destructiveHits) {
      process.stdout.write(`      DESTRUCTIVE: ${h.label}  — line: ${h.line.slice(0, 80)}\n`);
    }
    for (const h of r.warningHits) {
      process.stdout.write(`      WARNING:     ${h.label}  — line: ${h.line.slice(0, 80)}\n`);
    }
  }
  process.stdout.write("───────────────────────────────────────────────────────────────\n\n");
}

// Aggregate exit code
let exitCode = 0;
const hasBlocked = report.some((r) => r.level === "BLOCKED");
const hasDestructive = report.some((r) => r.level === "DESTRUCTIVE");
const hasWarning = report.some((r) => r.level === "WARNING");
if (hasBlocked) exitCode = 9;
else if (hasDestructive) exitCode = 10;
else if (hasWarning && strictMode) exitCode = 11;

if (!jsonMode) {
  if (exitCode === 0) {
    process.stderr.write("  migration-risk-scan: OK (all SAFE).\n\n");
  } else {
    process.stderr.write(
      `  migration-risk-scan: ISSUES (exit code ${exitCode}).\n` +
        `  See docs/operations/MIGRATION_DISCIPLINE.md for handling.\n\n`,
    );
  }
}

process.exit(exitCode);
