#!/usr/bin/env node
/**
 * Phase O-Final — Production column audit.
 *
 * READ-ONLY diagnostic. Inspects production `information_schema.columns`
 * + `_prisma_migrations` and reports any column the Prisma schema
 * declares but production is missing. Prints a bounded summary
 * suitable for paste into incident notes.
 *
 * Hard rules:
 *   * READ-ONLY — never executes ALTER / DROP / INSERT / UPDATE / DELETE.
 *     The script will abort if a non-SELECT statement is ever
 *     constructed (defensive — there is no code path to one).
 *   * Uses `pg.Pool` directly (same client as `services/api/src/db.ts`).
 *     Does NOT instantiate `new PrismaClient()` because Prisma 7 in
 *     this project requires the `@prisma/adapter-pg` factory, which
 *     would itself fail if the schema is drifted. The whole point of
 *     this audit is to diagnose drift BEFORE Prisma can connect, so we
 *     bypass the ORM and talk to Postgres directly.
 *   * Bounded output — column names + presence boolean only. NEVER
 *     row values, never PII, never connection string. The DB host is
 *     printed pre-redacted for context.
 *   * Exit codes:
 *       0 — no missing columns detected
 *       2 — missing column(s) detected (operator should run the
 *           additive repair migration)
 *       3 — connection / query failure (transient — try again or
 *           verify DATABASE_URL)
 *
 * Usage:
 *   node services/api/scripts/production-column-audit.mjs
 *   # or
 *   pnpm --filter proovra-api column-audit
 */

import { Pool } from "pg";

// ---------------------------------------------------------------------------
// Bounded expected-column set.
//
// Every entry below maps a production table to the columns the Prisma
// schema requires. Audited tables are the ones flagged by the
// FINAL INFRASTRUCTURE CLOSURE brief plus a small set of additional
// at-risk tables we know used `CREATE TABLE IF NOT EXISTS` in their
// original migration — which is the failure mode that produced
// `column discussion_mentions.team_id does not exist` in production.
//
// To extend: add the table_name → [column_names...] entry. NEVER
// remove an entry; that would weaken the audit.
// ---------------------------------------------------------------------------

const EXPECTED_COLUMNS = Object.freeze({
  discussion_mentions: [
    "id",
    "message_id",
    "thread_id",
    "team_id",
    "mentioned_user_id",
    "notified_at_utc",
    "created_at",
  ],
  // Phase 16 sister table — same migration, same CREATE TABLE IF NOT
  // EXISTS trap; audit defensively.
  discussion_participants: [
    "id",
    "thread_id",
    "team_id",
    "user_id",
    "intake_session_id",
    "role",
    "added_by_user_id",
    "added_at_utc",
    "revoked_at_utc",
    "revoked_by_user_id",
  ],
  evidence_workflow_instances: [
    "id",
    "team_id",
    "template_id",
    "status",
    "created_at",
    "updated_at",
  ],
  upload_sessions: [
    "id",
    "evidence_id",
    "team_id",
    "status",
    "is_multipart",
    "completed_part_count",
    "retry_count",
    "last_activity_at_utc",
    "created_at",
    "updated_at",
  ],
  evidence_saved_views: [
    "id",
    "owner_user_id",
    "team_id",
    "name",
    "filters_json",
    "scope",
    "is_default",
    "created_at",
    "updated_at",
  ],
});

const AUDITED_TABLES = Object.keys(EXPECTED_COLUMNS);

// ---------------------------------------------------------------------------
// Connection setup.
// ---------------------------------------------------------------------------

function loadEnvIfPresent() {
  // Honour env first; pnpm scripts typically source .env via dotenv-cli
  // at the api package level. We do NOT use `dotenv/config` here
  // because this script may be invoked from the repo root.
  // The runbook command exports DATABASE_URL explicitly.
  return;
}

loadEnvIfPresent();

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  process.stderr.write(
    "ERROR: DATABASE_URL is not set. Export it before running this audit.\n",
  );
  process.exit(3);
}

function redactedHost(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || 5432}/${u.pathname.replace(/^\//, "")}`;
  } catch {
    return "(unparseable)";
  }
}

// ---------------------------------------------------------------------------
// Query helpers — bounded, SELECT-only.
// ---------------------------------------------------------------------------

const READ_ONLY_PREFIX = /^\s*SELECT\b/i;

async function safeQuery(pool, sql, params = []) {
  if (!READ_ONLY_PREFIX.test(sql)) {
    throw new Error(
      "production-column-audit refusal: non-SELECT statement constructed",
    );
  }
  return pool.query(sql, params);
}

async function fetchActualColumns(pool, tableName) {
  const { rows } = await safeQuery(
    pool,
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = $1
      ORDER BY ordinal_position`,
    [tableName],
  );
  return new Set(rows.map((r) => r.column_name));
}

async function fetchMigrationStatus(pool) {
  // Return the most-recently applied row plus any FAILED row. Bounded
  // to 20 results so a verbose history cannot bloat the audit output.
  const { rows } = await safeQuery(
    pool,
    `SELECT migration_name, started_at, finished_at, rolled_back_at
       FROM _prisma_migrations
      ORDER BY started_at DESC
      LIMIT 20`,
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Audit runner.
// ---------------------------------------------------------------------------

async function main() {
  process.stderr.write("\n");
  process.stderr.write("───────────────────────────────────────────────────────────────\n");
  process.stderr.write("  PROOVRA production column audit (Phase O-Final)\n");
  process.stderr.write("───────────────────────────────────────────────────────────────\n");
  process.stderr.write(`  target  : ${redactedHost(databaseUrl)}\n`);
  process.stderr.write(`  tables  : ${AUDITED_TABLES.length}\n`);
  process.stderr.write("───────────────────────────────────────────────────────────────\n\n");

  const pool = new Pool({ connectionString: databaseUrl, max: 2 });

  let missingCount = 0;
  try {
    // 1. Per-table column audit.
    for (const tableName of AUDITED_TABLES) {
      const expected = EXPECTED_COLUMNS[tableName];
      let actual;
      try {
        actual = await fetchActualColumns(pool, tableName);
      } catch (err) {
        process.stdout.write(
          `[error] ${tableName}: query failed (${err?.message ?? "unknown"})\n`,
        );
        process.exitCode = 3;
        continue;
      }
      if (actual.size === 0) {
        process.stdout.write(`[MISSING-TABLE] ${tableName}\n`);
        missingCount += expected.length;
        continue;
      }
      const missing = expected.filter((c) => !actual.has(c));
      if (missing.length === 0) {
        process.stdout.write(`[ok] ${tableName} (${actual.size} cols)\n`);
        continue;
      }
      missingCount += missing.length;
      for (const c of missing) {
        process.stdout.write(`[MISSING-COLUMN] ${tableName}.${c}\n`);
      }
    }

    // 2. Migration status snapshot.
    process.stdout.write("\nrecent migrations (last 20, by started_at):\n");
    try {
      const migs = await fetchMigrationStatus(pool);
      for (const m of migs) {
        const state = m.rolled_back_at
          ? "ROLLED_BACK"
          : m.finished_at
            ? "OK"
            : "PENDING";
        process.stdout.write(`  ${state}  ${m.migration_name}\n`);
      }
    } catch (err) {
      process.stdout.write(
        `  [error] _prisma_migrations unreachable (${err?.message ?? "unknown"})\n`,
      );
      process.exitCode = 3;
    }

    process.stdout.write("\n");
    if (missingCount === 0) {
      process.stdout.write(
        "[result] no missing columns detected. Production schema matches expected.\n",
      );
      process.exitCode = process.exitCode ?? 0;
    } else {
      process.stdout.write(
        `[result] ${missingCount} missing column(s) detected. Run the additive repair migration:\n`,
      );
      process.stdout.write(
        "         prisma/migrations/20261006000000_phase_o_final_production_column_repair\n",
      );
      process.exitCode = 2;
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err?.message ?? err}\n`);
  process.exit(3);
});
