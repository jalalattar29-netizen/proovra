#!/usr/bin/env node
/**
 * PHASE 12 — POINT 6: read-only PRODUCTION migration snapshot collector.
 *
 * This script is the ONLY sanctioned way to read production migration state
 * for Point 6. It is structurally incapable of writing:
 *
 *   * it refuses to start unless `P6_PRODUCTION_READONLY_DATABASE_URL` is set
 *     — `DATABASE_URL`, `DIRECT_URL` and `SHADOW_DATABASE_URL` are IGNORED,
 *     because none of them is known to be a read-only credential and Phase
 *     2.5B is the incident that proves inheriting one is how accidents happen;
 *   * it opens `BEGIN TRANSACTION READ ONLY` and then ASSERTS
 *     `transaction_read_only = on` before issuing a single query;
 *   * every statement it can issue is in a fixed allowlist below. There is no
 *     interpolation of caller-supplied SQL anywhere in this file;
 *   * it selects migration metadata, server version, extensions and catalog
 *     shape ONLY. It never projects an application row, a credential, an
 *     email address, a hash, a storage location or a payload.
 *
 * OUTPUT: a JSON snapshot on stdout (or to `--out <path>`), with the database
 * identity recorded in bounded REDACTED form — host suffix and database name
 * only, never the user, password, or full connection string.
 *
 * USAGE (owner-operated):
 *
 *   P6_PRODUCTION_READONLY_DATABASE_URL="postgresql://<readonly-user>:<pw>@<host>/<db>?sslmode=require" \
 *     node services/api/scripts/p6-production-migration-snapshot.mjs \
 *     --out p6-production-snapshot.json
 *
 * Then hand the JSON back and reconcile it with:
 *
 *   node services/api/scripts/migration-production-reconcile.mjs p6-production-snapshot.json
 */
import { writeFileSync } from "node:fs";

import { Client } from "pg";

const EXIT_NO_URL = 10;
const EXIT_NOT_READ_ONLY = 11;
const EXIT_QUERY_FAILED = 12;

/**
 * The complete permitted statement set. Metadata only. Every one is a plain
 * constant — nothing here is built from input.
 */
const QUERIES = {
  readOnlyProbe: "SHOW transaction_read_only",
  currentRole: "SELECT current_user AS role, session_user AS session_role",
  roleCanWrite: `
    SELECT
      rolsuper    AS is_superuser,
      rolcreatedb AS can_create_db,
      rolcreaterole AS can_create_role,
      rolbypassrls AS bypasses_rls
    FROM pg_roles WHERE rolname = current_user`,
  identity: "SELECT current_database() AS database, inet_server_addr()::text AS server_addr",
  version: "SELECT version() AS version, current_setting('server_version_num') AS version_num",
  extensions: "SELECT extname AS name, extversion AS version FROM pg_extension ORDER BY extname",
  availableExtensions: `
    SELECT name, default_version, installed_version
    FROM pg_available_extensions
    WHERE name IN ('vector', 'pgcrypto', 'uuid-ossp', 'pg_trgm')
    ORDER BY name`,
  migrationsTableExists: `
    SELECT count(*)::int AS n
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = '_prisma_migrations'`,
  migrations: `
    SELECT
      migration_name,
      checksum,
      started_at,
      finished_at,
      rolled_back_at,
      applied_steps_count,
      logs IS NOT NULL AS has_logs
    FROM "_prisma_migrations"
    ORDER BY started_at, migration_name`,
  // Bounded catalog shape — object EXISTENCE only, never row contents. These
  // answer "is the pre-contract expanded schema or the post-contract schema
  // live?" without projecting a single application value.
  keyObjects: `
    SELECT
      (SELECT count(*)::int FROM information_schema.columns
        WHERE table_schema='public' AND table_name='evidence' AND column_name='case_id') AS evidence_case_id_present,
      (SELECT count(*)::int FROM information_schema.tables
        WHERE table_schema='public' AND table_name='case_evidence_links') AS case_evidence_links_present,
      (SELECT count(*)::int FROM information_schema.tables
        WHERE table_schema='public' AND table_name='case_legal_holds') AS case_legal_holds_present,
      (SELECT count(*)::int FROM information_schema.tables
        WHERE table_schema='public' AND table_name='legal_holds') AS legal_holds_present,
      (SELECT count(*)::int FROM information_schema.columns
        WHERE table_schema='public' AND table_name='evidence_legal_holds' AND column_name='scope') AS legal_hold_scope_present,
      (SELECT count(*)::int FROM information_schema.tables
        WHERE table_schema='public' AND table_name='workspace_persona_profiles') AS persona_profiles_present,
      (SELECT count(*)::int FROM information_schema.columns
        WHERE table_schema='public' AND table_name='admin_audit_logs' AND column_name='workspace_id') AS audit_workspace_id_present,
      (SELECT count(*)::int FROM information_schema.tables
        WHERE table_schema='public' AND table_name='report_generation_requests') AS report_generation_requests_present,
      (SELECT count(*)::int FROM information_schema.columns
        WHERE table_schema='public' AND table_name='security_events' AND column_name='severity'
          AND udt_name='SecurityEventSeverity') AS security_event_severity_is_enum,
      (SELECT count(*)::int FROM information_schema.columns
        WHERE table_schema='public' AND table_name='delegated_admin_grants' AND column_name='grantee_user_id') AS duplicate_grantee_col_present,
      (SELECT count(*)::int FROM information_schema.columns
        WHERE table_schema='public' AND column_name='id' AND data_type='uuid' AND column_default IS NULL) AS uuid_ids_without_default`,
};

function redactTarget(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname;
    // Keep only enough of the host to identify the deployment, never the
    // full address and never a credential.
    const parts = host.split(".");
    const shownHost =
      parts.length <= 2 ? host : `***.${parts.slice(-3).join(".")}`;
    return {
      host: shownHost,
      port: u.port || "5432",
      database: u.pathname.replace(/^\//, "") || "(default)",
      user: "<redacted>",
      password: "<redacted>",
    };
  } catch {
    return { host: "<unparseable>", port: null, database: null, user: "<redacted>", password: "<redacted>" };
  }
}

function die(code, payload) {
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(code);
}

async function main() {
  const outIdx = process.argv.indexOf("--out");
  const outPath = outIdx !== -1 ? process.argv[outIdx + 1] : null;

  const url = process.env.P6_PRODUCTION_READONLY_DATABASE_URL;
  if (!url) {
    die(EXIT_NO_URL, {
      ok: false,
      error: "P6_PRODUCTION_READONLY_DATABASE_URL is not set",
      detail:
        "This collector deliberately does NOT fall back to DATABASE_URL, DIRECT_URL or SHADOW_DATABASE_URL. Point 6 requires an explicitly named read-only credential so that no configured URL can be mistaken for a safe one.",
      remedy:
        'Create (or reuse) a PostgreSQL role with SELECT-only rights, then run: P6_PRODUCTION_READONLY_DATABASE_URL="postgresql://<readonly-user>:<pw>@<host>/<db>?sslmode=require" node services/api/scripts/p6-production-migration-snapshot.mjs --out p6-production-snapshot.json',
    });
  }

  const target = redactTarget(url);
  const client = new Client({ connectionString: url, application_name: "p6-readonly-snapshot" });
  await client.connect();

  const snapshot = {
    $schema: "proovra/p6-production-migration-snapshot@1",
    collectedAtUtc: new Date().toISOString(),
    target,
    readOnlyProof: null,
    role: null,
    postgres: null,
    extensions: null,
    availableExtensions: null,
    migrationsTablePresent: null,
    rows: null,
    keyObjects: null,
  };

  try {
    // Every read happens inside an explicitly READ ONLY transaction. If the
    // server does not honour it, nothing else runs.
    await client.query("BEGIN TRANSACTION READ ONLY");
    const ro = await client.query(QUERIES.readOnlyProbe);
    const roValue = ro.rows[0]?.transaction_read_only;
    if (roValue !== "on") {
      await client.query("ROLLBACK").catch(() => {});
      die(EXIT_NOT_READ_ONLY, {
        ok: false,
        error: "transaction_read_only is not 'on'",
        observed: roValue,
        target,
        detail: "Refusing to issue any further statement against this connection.",
      });
    }
    snapshot.readOnlyProof = { transaction_read_only: roValue, mode: "BEGIN TRANSACTION READ ONLY" };

    const role = (await client.query(QUERIES.currentRole)).rows[0];
    const rolePrivs = (await client.query(QUERIES.roleCanWrite)).rows[0] ?? {};
    snapshot.role = {
      // The role NAME is deployment metadata, not user data, and the operator
      // needs it to confirm the right credential was used.
      currentUser: role?.role ?? null,
      sessionUser: role?.session_role ?? null,
      isSuperuser: rolePrivs.is_superuser ?? null,
      canCreateDb: rolePrivs.can_create_db ?? null,
      canCreateRole: rolePrivs.can_create_role ?? null,
      bypassesRls: rolePrivs.bypasses_rls ?? null,
      note:
        rolePrivs.is_superuser === true
          ? "WARNING: this is a SUPERUSER credential. The snapshot is still read-only (the transaction enforces it), but Point 6 recommends a dedicated SELECT-only role."
          : "Role is not a superuser.",
    };

    const identity = (await client.query(QUERIES.identity)).rows[0];
    snapshot.target.database = identity?.database ?? snapshot.target.database;

    const v = (await client.query(QUERIES.version)).rows[0];
    snapshot.postgres = { version: v?.version ?? null, versionNum: v?.version_num ?? null };

    snapshot.extensions = (await client.query(QUERIES.extensions)).rows;
    snapshot.availableExtensions = (await client.query(QUERIES.availableExtensions)).rows;

    const present = (await client.query(QUERIES.migrationsTableExists)).rows[0]?.n ?? 0;
    snapshot.migrationsTablePresent = present > 0;

    if (present > 0) {
      const rows = (await client.query(QUERIES.migrations)).rows;
      snapshot.rows = rows.map((r) => ({
        migration_name: r.migration_name,
        checksum: r.checksum,
        started_at: r.started_at ? new Date(r.started_at).toISOString() : null,
        finished_at: r.finished_at ? new Date(r.finished_at).toISOString() : null,
        rolled_back_at: r.rolled_back_at ? new Date(r.rolled_back_at).toISOString() : null,
        applied_steps_count: r.applied_steps_count,
        hasLogs: r.has_logs,
        status: r.rolled_back_at
          ? "ROLLED_BACK"
          : r.finished_at
            ? "APPLIED"
            : r.started_at
              ? "STARTED_NOT_FINISHED"
              : "UNKNOWN",
      }));
    }

    snapshot.keyObjects = (await client.query(QUERIES.keyObjects)).rows[0] ?? null;

    await client.query("ROLLBACK");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    await client.end().catch(() => {});
    die(EXIT_QUERY_FAILED, {
      ok: false,
      error: "snapshot query failed",
      message: err instanceof Error ? err.message : String(err),
      target,
    });
  }
  await client.end();

  const json = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (outPath) {
    writeFileSync(outPath, json, "utf8");
    process.stderr.write(
      `p6 snapshot: wrote ${outPath} — ${snapshot.rows?.length ?? 0} _prisma_migrations row(s) from ${target.host}/${target.database} (READ ONLY, nothing was written).\n`,
    );
  } else {
    process.stdout.write(json);
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
