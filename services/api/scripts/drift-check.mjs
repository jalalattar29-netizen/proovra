#!/usr/bin/env node
/**
 * Phase 2.5C — Schema drift detection.
 *
 * Wraps `prisma migrate status` with structured output and a
 * non-zero exit code on failed or pending migrations. Designed to
 * be invoked from CI (as a gate before deploys) and locally
 * (to quickly answer "is my DB in sync with the migrations folder?").
 *
 * Output:
 *   - Lists APPLIED / PENDING / FAILED migration counts.
 *   - Re-emits the underlying prisma output for full context.
 *   - Exits 0 if everything is applied + healthy.
 *   - Exits 4 if any migration is FAILED.
 *   - Exits 5 if any migration is PENDING (not yet applied).
 *   - Exits 6 if drift is detected.
 *
 * Hard rules:
 *   - Does not run any migration. Read-only.
 *   - Does not require --allow-remote because it does not mutate.
 *   - Prints the same target banner as safe-migrate.mjs for
 *     visibility, so operators can see which DB the status reflects.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(resolve(process.cwd(), ".env"));
loadEnvFile(resolve(process.cwd(), "services/api/.env"));

const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
let host = "(unknown)";
let database = "(unknown)";
try {
  const u = new URL(databaseUrl);
  host = u.hostname || "(empty)";
  database = (u.pathname || "").replace(/^\//, "") || "(none)";
} catch {
  /* leave defaults */
}

process.stderr.write("\n");
process.stderr.write("───────────────────────────────────────────────────────────────\n");
process.stderr.write("  PROOVRA schema drift check (Phase 2.5C)\n");
process.stderr.write("───────────────────────────────────────────────────────────────\n");
process.stderr.write(`  host    : ${host}\n`);
process.stderr.write(`  database: ${database}\n`);
process.stderr.write("───────────────────────────────────────────────────────────────\n");

const result = spawnSync("pnpm", ["exec", "prisma", "migrate", "status"], {
  encoding: "utf8",
  shell: process.platform === "win32",
});

const stdout = result.stdout ?? "";
const stderr = result.stderr ?? "";
const combined = `${stdout}\n${stderr}`;

// Echo the prisma output to the user verbatim — they need to see
// the full prisma signal, not our summarised version.
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);

// Heuristic parsing of `prisma migrate status` output. The exact
// wording varies between Prisma versions, so we look for the
// canonical phrases. Each phrase produces a distinct exit code so CI
// can branch on the failure mode.
const lower = combined.toLowerCase();

let exitCode = 0;
const diagnoses = [];

if (
  lower.includes("failed migration") ||
  lower.includes("migration failed") ||
  lower.includes("migrations are in a failed state")
) {
  diagnoses.push("FAILED migrations present.");
  exitCode = 4;
}

if (
  lower.includes("following migrations have not yet been applied") ||
  lower.includes("not yet been applied") ||
  lower.includes("yet to be applied") ||
  // Newer prisma phrasing
  (lower.includes("pending migration") && !lower.includes("no pending"))
) {
  diagnoses.push("PENDING migrations present (not yet applied).");
  if (exitCode === 0) exitCode = 5;
}

if (
  lower.includes("drift detected") ||
  lower.includes("the schema is out of sync") ||
  lower.includes("schema has drifted")
) {
  diagnoses.push("DRIFT detected between schema.prisma and the live DB.");
  if (exitCode === 0) exitCode = 6;
}

// Also surface prisma's own non-zero exit explicitly.
if (
  exitCode === 0 &&
  typeof result.status === "number" &&
  result.status !== 0
) {
  diagnoses.push(
    `prisma migrate status exited non-zero (${result.status}) — see output above.`,
  );
  exitCode = 7;
}

process.stderr.write("\n");
process.stderr.write("───────────────────────────────────────────────────────────────\n");
if (exitCode === 0) {
  process.stderr.write("  drift-check: OK — schema and migrations are in sync.\n");
} else {
  process.stderr.write("  drift-check: ISSUES FOUND\n");
  for (const d of diagnoses) {
    process.stderr.write(`    - ${d}\n`);
  }
  process.stderr.write(
    "\n" +
      "  Refer to docs/operations/MIGRATION_DISCIPLINE.md for the\n" +
      "  drift-recovery runbook.\n",
  );
}
process.stderr.write("───────────────────────────────────────────────────────────────\n\n");

process.exit(exitCode);
