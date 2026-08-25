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
// The objects the RUNNING code requires of the database it is pointed at.
import { RUNTIME_SCHEMA_REQUIREMENTS } from "./runtime-schema-requirements.mjs";

const RUNTIME_REQUIREMENT_COUNT = RUNTIME_SCHEMA_REQUIREMENTS.length;

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
// Check 4 — runtime schema requirements (does the CONNECTED database have the
// objects this release's readers name?)
//
// Checks 1–3 are all about the REPOSITORY: the URL's shape, the migration
// files' contents, whether those files match the schema. A deploy that ships
// the code before the migrations passes all three and then answers its first
// Operations request with `column "scope" does not exist`. This check is the
// one that asks the database.
//
// It is skipped when the drift check is skipped, and for the same reason —
// both need a connection, and neither may open one to a non-local host without
// the dual override. A SKIP is recorded as WARN, never as PASS: "we did not
// look" must not read like "it is there".
// =============================================================================
{
  const { checkRuntimeSchemaRequirements, describeRuntimeSchemaFailure } =
    await import("./runtime-schema-requirements.mjs");

  if (skipDrift || !databaseUrl) {
    recordResult({
      name: "Runtime schema requirements",
      status: "WARN",
      detail: !databaseUrl
        ? "skipped (no DATABASE_URL)"
        : "skipped (would require connecting to a non-local DB)",
    });
  } else {
    let pool = null;
    try {
      const { Pool } = await import("pg");
      pool = new Pool({ connectionString: databaseUrl, max: 1 });
      const result = await checkRuntimeSchemaRequirements(async (sql) => {
        const rows = await pool.query(sql);
        return rows.rowCount > 0;
      });
      if (result.ok) {
        recordResult({
          name: "Runtime schema requirements",
          status: "PASS",
          detail: `all ${RUNTIME_REQUIREMENT_COUNT} required objects present`,
        });
      } else {
        recordResult({
          name: "Runtime schema requirements",
          status: "FAIL",
          detail: describeRuntimeSchemaFailure(result),
        });
      }
    } catch {
      // Could not even connect or probe. FAIL CLOSED, and say so in the
      // repository's own vocabulary rather than forwarding a driver message.
      recordResult({
        name: "Runtime schema requirements",
        status: "FAIL",
        detail:
          "could not read the database catalog — the required objects are treated as absent. " +
          "Check DATABASE_URL and that the server is reachable, then re-run.",
      });
    } finally {
      await pool?.end().catch(() => {});
    }
  }
}

// =============================================================================
// Check 5 — the Operations writer schema contract.
//
// Check 4 asks whether the database has the objects this release DECLARES, one
// hand-written requirement at a time. That is the right shape for "which
// migration supplies this", and it is the wrong shape for the failure that
// prompted this check: a workspace reported six failed Operations sources and
// zero conditions because ONE column the deployed Prisma model declared was
// absent from `operational_incidents`, and no hand-maintained list had it.
//
// This check does not enumerate objects. It asks the deployed data model for
// the writer's tables and requires the database to satisfy ALL of it. It
// cannot fall behind a model change, because it IS the model.
//
// Skipped under the same rule as Check 4, recorded as WARN, never as PASS.
// =============================================================================
{
  const { checkOperationsWriterContract, describeWriterContractFailure, loadDeployedDatamodel } =
    await import("./operations-writer-schema-contract.mjs");

  if (skipDrift || !databaseUrl) {
    recordResult({
      name: "Operations writer schema contract",
      status: "WARN",
      detail: !databaseUrl
        ? "skipped (no DATABASE_URL)"
        : "skipped (would require connecting to a non-local DB)",
    });
  } else {
    let pool = null;
    try {
      const { Pool } = await import("pg");
      pool = new Pool({ connectionString: databaseUrl, max: 1 });
      const dmmf = await loadDeployedDatamodel();
      const result = await checkOperationsWriterContract(dmmf, async (sql) => {
        const rows = await pool.query(sql);
        return rows.rows;
      });
      if (result.ok) {
        recordResult({
          name: "Operations writer schema contract",
          status: "PASS",
          detail: `every column the deployed model declares is present on ${result.checkedTables.join(", ")}`,
        });
      } else {
        recordResult({
          name: "Operations writer schema contract",
          status: "FAIL",
          detail: describeWriterContractFailure(result),
        });
      }
    } catch {
      recordResult({
        name: "Operations writer schema contract",
        status: "FAIL",
        detail:
          "could not read the database catalog — the writer contract is treated as unsatisfied. " +
          "Check DATABASE_URL and that the server is reachable, then re-run.",
      });
    } finally {
      await pool?.end().catch(() => {});
    }
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
