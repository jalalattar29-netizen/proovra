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

import { classifyHost, parseDatabaseHost } from "./db-host-policy.mjs";

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

// -----------------------------------------------------------------------------
// PHASE 12 POINT 4 — explicit, task-scoped target selection.
//
// The target was previously whatever `DATABASE_URL` happened to be, filled in
// silently from `.env` when the caller supplied nothing. A verification run
// against a disposable database therefore looked identical to a run that
// quietly fell back to the developer's configured host — and the second is
// what actually happened when this gate was invoked during Point 4.
//
// Resolution order, reported explicitly and never silent:
//   1. `--database-url=<url>` argument;
//   2. `DRIFT_CHECK_DATABASE_URL` env var (task-scoped, ignored by everything
//      else, so a CI job can point ONE check at a throwaway database);
//   3. `DATABASE_URL` from the environment (the existing CI/production path);
//   4. `.env` files — used ONLY when nothing above was supplied, and announced.
//
// Behaviour for CI and production is unchanged: neither passes 1 or 2, so both
// still resolve `DATABASE_URL` exactly as before.
// -----------------------------------------------------------------------------

const argUrl = (() => {
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--database-url=")) return arg.slice("--database-url=".length).trim();
  }
  return "";
})();
const envTaskUrl = process.env.DRIFT_CHECK_DATABASE_URL?.trim() ?? "";
const ambientUrl = process.env.DATABASE_URL?.trim() ?? "";

let databaseUrl = argUrl || envTaskUrl || ambientUrl;
let urlSource =
  (argUrl && "--database-url argument") ||
  (envTaskUrl && "DRIFT_CHECK_DATABASE_URL") ||
  (ambientUrl && "DATABASE_URL (environment)") ||
  "";

if (!databaseUrl) {
  // No explicit target: fall back to the .env files, but SAY SO.
  loadEnvFile(resolve(process.cwd(), ".env"));
  loadEnvFile(resolve(process.cwd(), "services/api/.env"));
  databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
  urlSource = databaseUrl ? ".env file (no explicit target supplied)" : "";
}

if (!databaseUrl) {
  process.stderr.write(
    "\n  drift-check: no database target resolved.\n" +
      "    Supply one of: --database-url=<url>, DRIFT_CHECK_DATABASE_URL, DATABASE_URL.\n" +
      "    The check refuses to guess a default database.\n\n",
  );
  process.exit(2);
}

// A task-scoped target is for DISPOSABLE verification databases. Refuse to
// point one at a remote/unknown host: a caller who explicitly names a target
// is doing throwaway work, and this check would otherwise be an easy way to
// aim tooling at production by copy-paste.
if (argUrl || envTaskUrl) {
  const { host } = parseDatabaseHost(databaseUrl);
  const classification = classifyHost(host);
  if (classification !== "local") {
    process.stderr.write(
      `\n  drift-check: REFUSING an explicit target on a ${classification} host (${host}).\n` +
        "    --database-url / DRIFT_CHECK_DATABASE_URL are for disposable local\n" +
        "    databases only. For a deployed environment, run the check the way CI\n" +
        "    does: with DATABASE_URL set in the job environment.\n\n",
    );
    process.exit(3);
  }
}

// Everything downstream (including the spawned prisma CLI, which inherits the
// environment) must see the resolved target — not a stale ambient value.
process.env.DATABASE_URL = databaseUrl;
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
process.stderr.write(`  source  : ${urlSource}\n`);
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
