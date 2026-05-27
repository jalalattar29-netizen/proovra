#!/usr/bin/env node
/**
 * Phase 2.5E — Migration preflight aggregator.
 *
 * Runs every Phase 2.5C/D/E safety check in sequence and produces a
 * single structured pass/fail summary. Designed to be the ONE command
 * an operator runs before pressing "apply migration" — and the ONE
 * command CI runs to validate platform discipline.
 *
 * Checks run, in order:
 *   1. DATABASE_URL classification (Phase 2.5C wrapper logic).
 *      - PASS if local.
 *      - WARN if remote (with required dual override).
 *      - FAIL if remote without override.
 *   2. Migration risk scan (Phase 2.5D).
 *      - PASS if no BLOCKED patterns.
 *      - WARN if DESTRUCTIVE patterns exist (historical baseline).
 *      - FAIL on BLOCKED.
 *   3. Drift check (Phase 2.5C `drift-check.mjs`).
 *      - Skipped if classification is non-local AND no override
 *        (avoid hitting a remote DB without acknowledgement).
 *      - PASS on exit 0.
 *      - FAIL on any non-zero exit.
 *
 * Exit codes:
 *   0  all checks passed
 *   12 at least one PRELIGHT check failed (composite signal)
 *
 * Designed to be called from:
 *   - `pnpm db:preflight` (operator)
 *   - CI as a non-DB-touching gate (skip drift-check by setting
 *     PRELIGHT_SKIP_DRIFT=1 — CI runs drift-check in its own job)
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// Phase 2.7X Stage 2 — drift catalog awareness.
import { PROTECTED_RUNTIME_TABLES } from "./protected-runtime-tables.mjs";

// Resolve paths relative to THIS script, not process.cwd(), so the
// preflight works whether invoked from the repo root or from
// services/api.
const __dirname = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dirname, "..");

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
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

const SAFE_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "host.docker.internal",
  "postgres",
  "proovra_postgres",
]);
const REMOTE_PATTERNS = [
  /\.neon\.tech$/i,
  /\.amazonaws\.com$/i,
  /\.azure\.com$/i,
  /\.googleusercontent\.com$/i,
  /\.cloudsql\./i,
  /\.pooler\./i,
  /-pooler\./i,
];

function classifyHost(host) {
  if (!host || host.length === 0) return "unknown";
  if (REMOTE_PATTERNS.some((re) => re.test(host))) return "remote";
  if (SAFE_HOSTS.has(host)) return "local";
  return "unknown";
}

function parseHost(url) {
  try {
    return new URL(url).hostname || "";
  } catch {
    return "";
  }
}

const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
const host = parseHost(databaseUrl);
const classification = classifyHost(host);

const results = [];
let failCount = 0;
let warnCount = 0;

function recordResult({ name, status, detail }) {
  results.push({ name, status, detail });
  if (status === "FAIL") failCount++;
  if (status === "WARN") warnCount++;
}

// =============================================================================
// Check 1 — DATABASE_URL classification
// =============================================================================
if (!databaseUrl) {
  recordResult({
    name: "DATABASE_URL classification",
    status: "FAIL",
    detail: "DATABASE_URL is not set",
  });
} else {
  const allowRemote =
    process.env.MIGRATE_ALLOW_REMOTE === "1" &&
    process.argv.includes("--allow-remote");
  if (classification === "local") {
    recordResult({
      name: "DATABASE_URL classification",
      status: "PASS",
      detail: `host=${host} (local)`,
    });
  } else if (allowRemote) {
    recordResult({
      name: "DATABASE_URL classification",
      status: "WARN",
      detail: `host=${host} (${classification}) — dual override active`,
    });
  } else {
    recordResult({
      name: "DATABASE_URL classification",
      status: "FAIL",
      detail: `host=${host} (${classification}) — refusing without --allow-remote + MIGRATE_ALLOW_REMOTE=1`,
    });
  }
}

// =============================================================================
// Check 2 — Migration risk scan
// =============================================================================
{
  const riskResult = spawnSync(
    "node",
    [resolve(__dirname, "migration-risk-scan.mjs")],
    {
      encoding: "utf8",
      cwd: API_ROOT,
    },
  );
  const rc = riskResult.status ?? -1;
  if (rc === 0) {
    recordResult({
      name: "Migration risk scan",
      status: "PASS",
      detail: "all migrations classified SAFE",
    });
  } else if (rc === 9) {
    recordResult({
      name: "Migration risk scan",
      status: "FAIL",
      detail: "BLOCKED pattern detected — refusing to proceed",
    });
  } else if (rc === 10) {
    recordResult({
      name: "Migration risk scan",
      status: "WARN",
      detail: "DESTRUCTIVE patterns detected (historical baseline; review manually)",
    });
  } else if (rc === 11) {
    recordResult({
      name: "Migration risk scan",
      status: "WARN",
      detail: "WARNING patterns detected (lock-risk; review manually)",
    });
  } else {
    recordResult({
      name: "Migration risk scan",
      status: "FAIL",
      detail: `unexpected exit code ${rc}`,
    });
  }
}

// =============================================================================
// Check 3 — Drift check (only when we can safely hit the DB)
// =============================================================================
const skipDrift =
  process.env.PRELIGHT_SKIP_DRIFT === "1" || classification !== "local";

if (skipDrift) {
  recordResult({
    name: "Drift check",
    status: "WARN",
    detail:
      classification !== "local"
        ? `skipped (host ${classification}; would require connecting to a non-local DB)`
        : "skipped (PRELIGHT_SKIP_DRIFT=1)",
  });
} else {
  const driftResult = spawnSync(
    "node",
    [resolve(__dirname, "drift-check.mjs")],
    {
      encoding: "utf8",
      cwd: API_ROOT,
    },
  );
  const rc = driftResult.status ?? -1;
  if (rc === 0) {
    recordResult({
      name: "Drift check",
      status: "PASS",
      detail: "no drift; migrations in sync",
    });
  } else {
    recordResult({
      name: "Drift check",
      status: "FAIL",
      detail: `drift-check exited ${rc} — see docs/operations/MIGRATION_DISCIPLINE.md`,
    });
  }
}

// =============================================================================
// Summary
// =============================================================================
process.stderr.write("\n");
process.stderr.write("═══════════════════════════════════════════════════════════════\n");
process.stderr.write("  PROOVRA migration preflight (Phase 2.5E)\n");
process.stderr.write("═══════════════════════════════════════════════════════════════\n");
for (const r of results) {
  const icon = r.status === "PASS" ? "✓" : r.status === "WARN" ? "⚠" : "✗";
  process.stderr.write(`  [${r.status.padEnd(4, " ")}] ${icon}  ${r.name}\n`);
  process.stderr.write(`         ${r.detail}\n`);
}
process.stderr.write("═══════════════════════════════════════════════════════════════\n");
process.stderr.write(
  `  Result: ${failCount} fail / ${warnCount} warn / ${results.length - failCount - warnCount} pass\n`,
);
process.stderr.write("═══════════════════════════════════════════════════════════════\n");
// Phase 2.7X Stage 2 — protected runtime tables (drift catalog).
process.stderr.write(
  `  Protected runtime tables (drift catalog): ${PROTECTED_RUNTIME_TABLES.length}\n` +
    `    Any destructive op on these names is BLOCKED by\n` +
    `    \`db:risk-scan\` and refused by \`db:diff-guard\`.\n` +
    `    Source: services/api/scripts/protected-runtime-tables.mjs\n`,
);
process.stderr.write("═══════════════════════════════════════════════════════════════\n\n");

process.exit(failCount > 0 ? 12 : 0);
