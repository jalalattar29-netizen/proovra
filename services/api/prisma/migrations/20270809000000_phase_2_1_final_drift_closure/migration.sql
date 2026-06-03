-- Phase 2.1 — FINAL DRIFT CLOSURE BEFORE DEPLOY.
--
-- ============================================================================
-- SCOPE (4 items)
-- ============================================================================
--
--   1. CREATE TABLE IF NOT EXISTS "redaction_policy_audits"  (Prisma plural;
--      legacy singular "redaction_policy_audit" left untouched — see below).
--   2. ADD COLUMN IF NOT EXISTS "entitlements"."team_seats" (INTEGER NOT NULL DEFAULT 0).
--   3. ADD COLUMN IF NOT EXISTS "verification_packages"."package_type" (VARCHAR(64) NULL).
--   4. ADD COLUMN IF NOT EXISTS "verification_packages"."trust_decision_snapshot" (JSONB NULL).
--
-- ============================================================================
-- USER BRIEF CONSTRAINT (HARD RULES)
-- ============================================================================
--   * ADDITIVE-ONLY. No DROP TABLE / DROP COLUMN / DROP INDEX / DROP CONSTRAINT.
--   * IDEMPOTENT. Every action uses IF NOT EXISTS. Re-running is a no-op.
--   * NO RENAME. NO DELETE. NO TRUNCATE. NO destructive UPDATE.
--   * NO ALTER COLUMN DROP NOT NULL / SET NOT NULL on existing columns.
--   * NO destructive enum rewrite.
--   * NULLABLE-FIRST for new columns where Prisma allows; NOT NULL DEFAULT
--     allowed only when the Prisma schema declares a default value and the
--     DEFAULT clause auto-backfills existing rows.
--
-- ============================================================================
-- ITEM 1 — redaction_policy_audits (plural Prisma @@map; was previously
--          materialised only as singular "redaction_policy_audit").
-- ============================================================================
--
-- Production drift summary (Phase 2 finding):
--   Prisma model `RedactionPolicyAudit` (schema.prisma:10451) declares
--   `@@map("redaction_policy_audits")` (PLURAL). Phase 3A Elite migration
--   (`20261201000000_phase_3a_elite_closure_policy_video/migration.sql:117`)
--   created the singular `redaction_policy_audit` table. The plural table
--   never landed, so every Prisma query against `RedactionPolicyAudit` today
--   fails with P2021 (table does not exist), which the central error handler
--   at `services/api/src/server.ts:665-686` maps to HTTP 503 SCHEMA_NOT_READY.
--
-- Repair path chosen: Path A from the Phase 2 manual-decision table —
--   CREATE the plural table additively so Prisma queries succeed. The
--   singular table is NOT dropped, NOT renamed, NOT truncated. Pre-existing
--   audit history in the singular table remains exactly as it was. A future
--   data-move migration can backfill plural from singular under a planned
--   maintenance window; this migration is concerned only with making the
--   Prisma client work today without data loss.
--
-- Table shape is taken verbatim from the Prisma model + R7-redaction additive
-- columns (policy_version_id + occurred_at_utc) so the table matches the
-- live Prisma client expectations on column NAME, TYPE, and NULLABILITY.

-- Phase O safety gate forbids bare `CREATE TABLE IF NOT EXISTS` because it
-- silently SKIPS the entire block when the table already exists, hiding
-- missed column evolution (the original Phase O-Final failure mode that
-- broke discussion_mentions.team_id). The canonical safe pattern is a
-- pg_tables guard wrapping an EXECUTE'd CREATE TABLE, followed by
-- per-column ALTER ADD COLUMN IF NOT EXISTS as a safety net (covers the
-- case where the table existed but lacked a column the schema declares).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'redaction_policy_audits'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "redaction_policy_audits" (
  "id"                UUID         NOT NULL DEFAULT gen_random_uuid(),
  "policy_id"         UUID         NOT NULL,
  "team_id"           UUID         NOT NULL,
  "actor_user_id"     UUID,
  "code"              VARCHAR(80)  NOT NULL,
  "payload"           JSONB,
  "policy_version_id" UUID,
  "occurred_at_utc"   TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "redaction_policy_audits_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- Per-column ALTER ADD COLUMN IF NOT EXISTS as a safety net — if the
-- table was created above, these are no-ops; if a prior partial-evolution
-- left the table without one of these columns, this lands them.
ALTER TABLE IF EXISTS "redaction_policy_audits"
  ADD COLUMN IF NOT EXISTS "policy_id"         UUID,
  ADD COLUMN IF NOT EXISTS "team_id"           UUID,
  ADD COLUMN IF NOT EXISTS "actor_user_id"     UUID,
  ADD COLUMN IF NOT EXISTS "code"              VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "payload"           JSONB,
  ADD COLUMN IF NOT EXISTS "policy_version_id" UUID,
  ADD COLUMN IF NOT EXISTS "occurred_at_utc"   TIMESTAMPTZ(6) DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS "created_at"        TIMESTAMPTZ(6) DEFAULT NOW();

-- FK constraints added with information_schema guards so re-running on a
-- partially-applied schema is safe (the parent tables MUST exist from the
-- Phase 3A Elite migration; guard is belt-and-braces).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'redaction_policies'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_schema = 'public'
       AND table_name = 'redaction_policy_audits'
       AND constraint_name = 'redaction_policy_audits_policy_fk'
  ) THEN
    EXECUTE 'ALTER TABLE "redaction_policy_audits"
               ADD CONSTRAINT "redaction_policy_audits_policy_fk"
               FOREIGN KEY ("policy_id")
               REFERENCES "redaction_policies" ("id") ON DELETE CASCADE';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'redaction_policy_versions'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_schema = 'public'
       AND table_name = 'redaction_policy_audits'
       AND constraint_name = 'redaction_policy_audits_version_fk'
  ) THEN
    EXECUTE 'ALTER TABLE "redaction_policy_audits"
               ADD CONSTRAINT "redaction_policy_audits_version_fk"
               FOREIGN KEY ("policy_version_id")
               REFERENCES "redaction_policy_versions" ("id") ON DELETE SET NULL';
  END IF;
END $$;

-- Indexes match the Prisma model's @@index declarations on
-- (policyId, createdAt(sort:Desc)), (policyVersionId), (teamId).
CREATE INDEX IF NOT EXISTS "redaction_policy_audits_policy_created_idx"
  ON "redaction_policy_audits" ("policy_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "redaction_policy_audits_policy_version_idx"
  ON "redaction_policy_audits" ("policy_version_id");

CREATE INDEX IF NOT EXISTS "redaction_policy_audits_team_idx"
  ON "redaction_policy_audits" ("team_id");

-- ============================================================================
-- ITEMS 2-4 — 3 unverified columns (safety net).
-- ============================================================================
--
-- Phase 2 sign-off flagged 3 columns as UNVERIFIED — operator-side probe
-- pending. This migration is a deploy-safe safety net:
--
--   * If the column already exists in production: IF NOT EXISTS makes the
--     ALTER a no-op. Zero side effect.
--   * If the column is genuinely missing: the ALTER adds it with the type
--     declared in `schema.prisma`. For `team_seats`, NOT NULL DEFAULT 0
--     backfills existing rows atomically (Prisma model declares
--     `@default(0)`). For the two verification_packages columns, both are
--     declared nullable in Prisma — no backfill needed.
--
-- This means the operator can deploy WITHOUT running the probe first; the
-- migration is idempotent either way. (The probe is still recommended for
-- audit clarity — see Phase 2.1 doc.)

-- Item 2: entitlements.team_seats (Prisma: `@default(0)` Int NOT NULL).
--   Source: services/api/prisma/schema.prisma:1685.
ALTER TABLE IF EXISTS "entitlements"
  ADD COLUMN IF NOT EXISTS "team_seats" INTEGER NOT NULL DEFAULT 0;

-- Item 3: verification_packages.package_type (Prisma: nullable VARCHAR(64)).
--   Source: services/api/prisma/schema.prisma:677.
ALTER TABLE IF EXISTS "verification_packages"
  ADD COLUMN IF NOT EXISTS "package_type" VARCHAR(64);

-- Item 4: verification_packages.trust_decision_snapshot (Prisma: nullable Json).
--   Source: services/api/prisma/schema.prisma:678.
ALTER TABLE IF EXISTS "verification_packages"
  ADD COLUMN IF NOT EXISTS "trust_decision_snapshot" JSONB;
