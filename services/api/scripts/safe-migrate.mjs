#!/usr/bin/env node
/**
 * Phase 2.5C — Migration safety wrapper.
 *
 * Wraps `prisma migrate <subcommand>` with a hard host-allowlist
 * preflight. Refuses to proceed if `DATABASE_URL` resolves to a host
 * outside the local-development allowlist UNLESS the caller passes
 * BOTH `--allow-remote` AND has `MIGRATE_ALLOW_REMOTE=1` set in env.
 *
 * Why this exists:
 *   Phase 2.5B accidentally fired `prisma migrate deploy` against a
 *   Neon production-like database because the active `DATABASE_URL`
 *   was inherited from the repo-root `.env`. The migration failed
 *   before applying SQL (a pre-existing migration was in a failed
 *   state on that DB blocked it), but the attempt itself violated
 *   the Phase 0 hard rule "Do NOT modify live Neon production data".
 *
 *   This wrapper prevents the same mistake by making the migration
 *   target VISIBLE BEFORE any SQL runs, and refusing to continue
 *   when the target is non-local.
 *
 * Behaviour:
 *   - Reads DATABASE_URL (env first, then .env files via the same
 *     loader as prisma.config.ts).
 *   - Parses the URL host.
 *   - Classifies SAFE (localhost / 127.0.0.1 / ::1 / postgres docker
 *     container hostname / "host.docker.internal").
 *   - For UNSAFE hosts, refuses unless BOTH:
 *       * the `--allow-remote` flag is passed
 *       * env `MIGRATE_ALLOW_REMOTE=1` is set
 *     The double-acknowledgement makes accidental remote migration
 *     materially harder than a single flag.
 *   - Prints the resolved host + database name + classification in
 *     bold to stderr BEFORE spawning prisma. This is the
 *     last-chance signal an operator sees before SQL hits the DB.
 *   - Fails CLOSED — any error in classification refuses by default.
 *
 * Usage:
 *   node scripts/safe-migrate.mjs <subcommand> [args...]
 *
 * Examples:
 *   pnpm db:migrate                           # safe; defaults to deploy
 *   pnpm db:migrate dev --name add-foo        # safe; explicit subcmd
 *   MIGRATE_ALLOW_REMOTE=1 \
 *     pnpm db:migrate deploy --allow-remote   # required override
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
// Phase 2.5D — single source of truth for host classification.
// Both this wrapper AND the in-process prisma.config.ts hook
// import from this module so a policy change in one place updates
// every enforcement point.
import {
  classifyHost,
  parseDatabaseHost,
  shouldAllowMigration,
} from "./db-host-policy.mjs";

// ---------------------------------------------------------------------------
// .env loader (mirrors services/api/prisma.config.ts to keep behavior
// identical between the wrapper and the prisma client).
// ---------------------------------------------------------------------------
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
    if (!key) continue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const cwdEnv = resolve(process.cwd(), ".env");
const serviceEnv = resolve(process.cwd(), "services/api/.env");
loadEnvFile(cwdEnv);
if (serviceEnv !== cwdEnv) loadEnvFile(serviceEnv);

// Host classification + policy now imported from
// `./db-host-policy.mjs` (Phase 2.5D) so this file and the in-process
// prisma.config hook share the same enforcement logic.

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const allowRemoteFlag = args.includes("--allow-remote");
const filteredArgs = args.filter((a) => a !== "--allow-remote");

// Default subcommand is `deploy` — matches the legacy
// `prisma:migrate` script in package.json so we don't regress
// developer ergonomics.
if (filteredArgs.length === 0) filteredArgs.push("deploy");

const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
if (!databaseUrl) {
  // Fail closed — refuse to spawn prisma without a DATABASE_URL.
  // prisma itself would error, but we surface a clearer message
  // and avoid a partial command running.
  console.error(
    "[safe-migrate] REFUSED: DATABASE_URL is not set.\n" +
      "  Set it in services/api/.env (or .env at the repo root) before\n" +
      "  running migrations. Do not run migrations against an unset target.",
  );
  process.exit(2);
}

const { host, port, database, protocol } = parseDatabaseHost(databaseUrl);
const classification = classifyHost(host);
const envOverride = process.env.MIGRATE_ALLOW_REMOTE === "1";

// ---------------------------------------------------------------------------
// Preflight banner — ALWAYS printed, regardless of safe/unsafe.
// This is the operator's last visible signal before SQL is applied.
// ---------------------------------------------------------------------------
const subcmd = filteredArgs[0] ?? "deploy";
process.stderr.write("\n");
process.stderr.write("───────────────────────────────────────────────────────────────\n");
process.stderr.write("  PROOVRA migration safety wrapper (Phase 2.5C)\n");
process.stderr.write("───────────────────────────────────────────────────────────────\n");
process.stderr.write(`  subcommand   : prisma migrate ${subcmd}\n`);
process.stderr.write(`  protocol     : ${protocol || "(unknown)"}\n`);
process.stderr.write(`  host         : ${host || "(empty)"}\n`);
process.stderr.write(`  port         : ${port || "(default)"}\n`);
process.stderr.write(`  database     : ${database || "(none)"}\n`);
process.stderr.write(`  classification: ${classification.toUpperCase()}\n`);
process.stderr.write(`  --allow-remote flag : ${allowRemoteFlag ? "YES" : "no"}\n`);
process.stderr.write(`  MIGRATE_ALLOW_REMOTE: ${envOverride ? "1" : "(unset)"}\n`);
process.stderr.write("───────────────────────────────────────────────────────────────\n");

// ---------------------------------------------------------------------------
// Refusal logic — fail CLOSED. Decision routed through the shared
// policy in db-host-policy.mjs so the in-process prisma.config hook
// applies the same rules.
// ---------------------------------------------------------------------------
const decision = shouldAllowMigration({
  classification,
  allowRemoteFlag,
  envOverride,
});
if (!decision.allow) {
    process.stderr.write(
      `\n[safe-migrate] REFUSED: target host "${host}" is not in the local\n` +
        `  allowlist (classification=${classification}). To run a migration against\n` +
        `  a non-local database you must:\n` +
        `\n` +
        `    1. pass the flag      --allow-remote\n` +
        `    2. set the env var    MIGRATE_ALLOW_REMOTE=1\n` +
        `\n` +
        `  Both are required. This is intentional: passing the flag alone is\n` +
        `  not enough, and setting only the env var is not enough. The double\n` +
        `  acknowledgement makes accidental remote migration materially harder.\n` +
        `\n` +
        `  If you didn't intend to touch ${host}, set DATABASE_URL to your\n` +
        `  local Postgres in services/api/.env and re-run.\n` +
        `\n` +
        `  Phase 2.5B incident: this guard exists because a prisma migrate\n` +
        `  command fired against a Neon production-like DB on Phase 2.5B —\n` +
        `  see docs/product/PHASE_2_5B_LIFECYCLE_AND_BULK.md section 1.5.\n\n`,
    );
    process.exit(3);
}
// Decision allowed past this point. If we're past the local
// fast-path, emit the explicit-override banner AND enforce the
// Phase 2.5D backup-acknowledgement check.
if (classification !== "local") {
  // Phase 2.5D — backup discipline. For non-local migrations the
  // operator MUST also acknowledge a backup by setting
  // `MIGRATE_BACKUP_ID=<some-identifier>`. The identifier is a free-
  // form string the operator records in the incident / change log
  // (e.g. the snapshot id from the cloud provider, the path to a
  // local pg_dump, or a ticket id). The wrapper itself does not
  // CREATE the backup — Prisma migration tooling cannot reliably
  // automate that across providers — but it MAKES the
  // acknowledgement visible in CI logs.
  //
  // To skip with explicit acknowledgement (e.g. local DR drills),
  // set `MIGRATE_BACKUP_ID=NONE_ACKNOWLEDGED_DR_RISK`. The string
  // is intentionally long and ugly so it never appears in someone's
  // shell history by accident.
  const backupId = process.env.MIGRATE_BACKUP_ID?.trim() ?? "";
  if (backupId.length < 4) {
    process.stderr.write(
      "\n[safe-migrate] REFUSED: remote migration requires a backup\n" +
        "  acknowledgement. Take a snapshot (cloud provider, pg_dump,\n" +
        "  or your standard backup process) and re-run with:\n" +
        "\n" +
        "    MIGRATE_BACKUP_ID=<snapshot-id-or-incident-id>\n" +
        "\n" +
        "  If you intentionally want to skip backup (e.g. local DR\n" +
        "  drill against a throwaway DB), set:\n" +
        "\n" +
        "    MIGRATE_BACKUP_ID=NONE_ACKNOWLEDGED_DR_RISK\n" +
        "\n" +
        "  See docs/operations/MIGRATION_DISCIPLINE.md.\n\n",
    );
    process.exit(11);
  }

  process.stderr.write(
    "\n[safe-migrate] EXPLICIT REMOTE MIGRATION OVERRIDE.\n" +
      `  Both --allow-remote and MIGRATE_ALLOW_REMOTE=1 were supplied.\n` +
      `  Backup acknowledged via MIGRATE_BACKUP_ID=${backupId}\n` +
      `  Proceeding to run "prisma migrate ${subcmd}" against ${host}.\n` +
      `  This is logged.\n\n`,
  );
}

// ---------------------------------------------------------------------------
// Spawn prisma. The wrapper is transparent for everything below this
// line — we forward stdio, preserve the exit code, and never mutate
// arguments after the classification check.
// ---------------------------------------------------------------------------
const result = spawnSync("pnpm", ["exec", "prisma", "migrate", ...filteredArgs], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
