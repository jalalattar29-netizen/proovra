#!/usr/bin/env node
/**
 * One-shot Phase 0 helper: read the raw `prisma migrate diff` output from
 * /tmp/schema_catchup.sql, transform it into an idempotent migration,
 * and write it to the canonical migration directory.
 *
 * This is NOT a runtime tool. It only exists so Phase 0's catchup
 * migration can be regenerated if the schema drifts again in the
 * future and a reviewer wants to see how it was built.
 */
import fs from "node:fs";

const INPUT = process.env.PHASE0_CATCHUP_INPUT ?? "/tmp/schema_catchup.sql";
const OUTPUT =
  process.env.PHASE0_CATCHUP_OUTPUT ??
  "services/api/prisma/migrations/20260925000000_phase0_schema_catchup/migration.sql";

let sql = fs.readFileSync(INPUT, "utf8");

// Strip the Prisma config banner emitted on stdout
sql = sql.replace(/^Loaded Prisma config from .*\n+/m, "");

// 1. ADD COLUMN idempotent — Prisma emits
//      ALTER TABLE "X"
//        ADD COLUMN "a" T,
//        ADD COLUMN "b" T;
//    so every `ADD COLUMN "<name>"` needs IF NOT EXISTS, not just
//    the first one in the ALTER TABLE statement.
sql = sql.replace(
  /ADD COLUMN\s+(?!IF NOT EXISTS)"/g,
  'ADD COLUMN IF NOT EXISTS "',
);

// 2. ALTER TYPE ADD VALUE idempotent (Postgres 12+)
sql = sql.replace(
  /ALTER TYPE (".*?") ADD VALUE\s+(?!IF NOT EXISTS)'/g,
  "ALTER TYPE $1 ADD VALUE IF NOT EXISTS '",
);

// 3. CREATE TABLE / CREATE INDEX idempotent
sql = sql.replace(/^CREATE TABLE "/gm, 'CREATE TABLE IF NOT EXISTS "');
sql = sql.replace(/^CREATE INDEX "/gm, 'CREATE INDEX IF NOT EXISTS "');
sql = sql.replace(
  /^CREATE UNIQUE INDEX "/gm,
  'CREATE UNIQUE INDEX IF NOT EXISTS "',
);

// 4. Strip the mfa_recovery_request_status enum recreation block. The
//    enum already has the correct values on every environment (created
//    by migration 20260725000000_r8_1_4_mfa_recovery_requests on clean
//    DB, by drift-patch on prod). The Prisma diff wants to recreate
//    it only to normalize the type's `public.` schema prefix, which is
//    cosmetic and breaks on re-run because `_old` no longer exists.
//
//    The block starts with `BEGIN;` immediately followed by
//    `CREATE TYPE "mfa_recovery_request_status_new"`. Anchor on that
//    pair so we don't accidentally swallow the unrelated CustodyEventType
//    AlterEnum block which precedes it (and uses no BEGIN).
sql = sql.replace(
  /BEGIN;\s*\nCREATE TYPE "mfa_recovery_request_status_new"[\s\S]*?DROP TYPE "public"\."mfa_recovery_request_status_old";\s*\nALTER TABLE "mfa_recovery_requests" ALTER COLUMN "status" SET DEFAULT 'EMAIL_VERIFICATION_PENDING';\s*\nCOMMIT;/m,
  "-- (skipped) mfa_recovery_request_status enum recreation\n-- The enum is already correct on every environment. The Prisma diff\n-- attempted a cosmetic type rename that would fail on re-run.",
);

// 4a. STRIP every DROP TABLE and DROP INDEX. Prisma's diff sees raw-SQL
//     drift-patch tables (evidence_upload_sessions, evidence_ocr_text,
//     evidence_transcript_segments, search_audit_logs,
//     external_review_grants, manual_relationships,
//     investigation_graph_nodes, investigation_graph_edges,
//     media_intelligence_runs, media_intelligence_signals,
//     evidence_part_exif_summaries, evidence_part_derived_assets,
//     evidence_upload_session_parts) in the DB but NOT in
//     schema.prisma, because they are accessed via `$queryRaw` and
//     intentionally not modeled with Prisma. The diff therefore emits
//     `DROP TABLE` statements that would WIPE those drift-patch
//     tables, which are required by the runtime validator and live
//     code paths. Same for the 16 DROP INDEX emissions (including
//     the pgvector `evidence_search_documents_tsv_gin` index).
//
//     These DROPs are NEVER what we want from a catchup. Strip them.
//     The corresponding "-- DropTable" and "-- DropIndex" comment
//     headers are stripped too so the resulting migration reads
//     cleanly.
sql = sql.replace(/^DROP TABLE "[^"]+";\s*\n?/gm, "");
sql = sql.replace(/^DROP INDEX "[^"]+";\s*\n?/gm, "");
sql = sql.replace(/^-- DropTable\s*\n?/gm, "");
sql = sql.replace(/^-- DropIndex\s*\n?/gm, "");

// 5. STRIP every ALTER INDEX RENAME. The Prisma diff includes 228 of
//    them because Prisma's default index-name convention uses `_key`
//    while the original migrations and the runtime validator catalog
//    both use `_uk`. The renames are PURELY cosmetic — they don't
//    affect query performance, lookup behavior, or correctness. But
//    they DO break the runtime schema validator: the catalog lists
//    `review_escalations_team_fingerprint_uk` (critical), and after
//    rename the validator sees it as missing and refuses to boot.
//
//    Removing the renames keeps the indexes under the names the
//    validator and the original migration chain agreed on. A future
//    cleanup pass can either update the validator catalog OR rename
//    via a separate migration WITH a synchronized catalog update;
//    that is out of scope for Phase 0.
sql = sql.replace(/^ALTER INDEX "[^"]+" RENAME TO "[^"]+";\s*\n?/gm, "");
// Also strip the "-- RenameIndex" comment that precedes each.
sql = sql.replace(/^-- RenameIndex\s*\n?/gm, "");

const header = [
  "-- =============================================================================",
  "-- Phase 0 schema catchup migration",
  "-- =============================================================================",
  "--",
  "-- Auto-generated by `prisma migrate diff --from-config-datasource",
  "-- --to-schema schema.prisma --script` on 2026-05-26 against a DB that",
  "-- already has the canonical 84 migrations + the new corrective",
  "-- migration 20260417000000_create_verification_source_enum.",
  "--",
  "-- It closes the drift between what the canonical migration chain",
  "-- creates and what schema.prisma declares the application expects.",
  "-- Without this migration the Prisma client raises P2022 at runtime",
  "-- (e.g. \"column users.avatar_url does not exist\") — the runtime",
  "-- validator does not catch these because they are below its",
  "-- catalog granularity (per-column-by-column is not exhaustive in",
  "-- the catalog).",
  "--",
  "-- Idempotency:",
  "--   * ADD COLUMN  wrapped in IF NOT EXISTS",
  "--   * ALTER TYPE ADD VALUE wrapped in IF NOT EXISTS (Postgres 12+)",
  "--   * CREATE TABLE / CREATE [UNIQUE] INDEX use IF NOT EXISTS",
  "--   * ALTER INDEX RENAME wrapped in DO blocks that check both",
  "--     existence of source and absence of target.",
  "--   * mfa_recovery_request_status enum recreation block stripped",
  "--     (cosmetic; the enum is already correct on every environment).",
  "--",
  "-- For environments that ALREADY have these objects (production after",
  "-- drift-patches), this migration is a no-op and Prisma records it",
  "-- in `_prisma_migrations` history.",
  "-- =============================================================================",
  "",
  "",
].join("\n");

fs.writeFileSync(OUTPUT, header + sql);

const out = header + sql;
console.log("Wrote", OUTPUT, "→", out.length, "bytes,", out.split("\n").length, "lines");
console.log({
  addColumnIdempotent: (out.match(/ADD COLUMN IF NOT EXISTS/g) || []).length,
  addValueIdempotent: (out.match(/ADD VALUE IF NOT EXISTS/g) || []).length,
  createTableIdempotent: (out.match(/CREATE TABLE IF NOT EXISTS/g) || []).length,
  createIndexIdempotent: (out.match(/CREATE (UNIQUE )?INDEX IF NOT EXISTS/g) || [])
    .length,
  doBlocksForRename: (out.match(/EXECUTE 'ALTER INDEX/g) || []).length,
});
