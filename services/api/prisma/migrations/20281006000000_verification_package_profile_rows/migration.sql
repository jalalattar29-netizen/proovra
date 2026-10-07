-- =============================================================================
-- VERIFICATION PACKAGE PROFILE ROWS (2026-10-07).
--
-- Every independently downloadable, sealed package artifact is its OWN row with
-- its own identity and lifecycle facts. One issuance (one report-generation
-- request) produces one row per disclosure profile — FULL_FORENSIC and
-- EXTERNAL_DISCLOSURE — grouped by `issuance_id`, never a second artifact
-- hidden in a JSON column of the first.
--
-- The package id is RESERVED before any byte of the package is built (state
-- RESERVED, no storage facts yet), and every retry of the same logical
-- (evidence, version, profile) reuses that row and that id until it is
-- PUBLISHED. A failed attempt records FAILED with its time and reason; a later
-- attempt re-reserves the same row. A PUBLISHED row is never rewritten.
--
--   state                      RESERVED | PUBLISHED | FAILED. Existing rows are
--                              PUBLISHED: a row was only ever inserted at
--                              publication (the DEFAULT is a constant, so this
--                              is a catalog-only change — no table rewrite).
--   issuance_id                the report-generation request that issued it.
--   report_id                  the report row it certifies.
--   supersedes_package_id      the previous published package of the SAME
--                              profile for this record.
--   seal_signing_key_id/
--   seal_signing_key_version   the exact registry identity of the seal key.
--   reserved_at_utc / completed_at_utc / failed_at_utc / terminal_reason
--
-- storage_bucket, storage_key and generated_at_utc become nullable because a
-- RESERVED or FAILED row has no stored object; a CHECK keeps them mandatory for
-- every PUBLISHED row, so no reader can see a published package without them.
--
-- UNIQUENESS: one PRIMARY package (FULL_FORENSIC, or a legacy row with no
-- profile) and at most one EXTERNAL_DISCLOSURE package per (evidence, version).
-- Two partial unique keys say exactly that — a NULL profile is a primary row,
-- which a plain three-column unique key would treat as distinct. They replace
-- the (evidence_id, version) key, which cannot hold a second profile.
--
-- SAFE BEFORE THE NEW CODE: the previous images only ever insert one primary
-- row per (evidence, version) — create, never ON CONFLICT against the retired
-- key — and the primary partial key enforces exactly that for them. Their
-- inserts omit `state` and get PUBLISHED, which is what an insert at
-- publication is. Nothing is backfilled and no package byte or row is
-- rewritten. ROLLBACK is code-first; the retired index can be recreated while
-- only one profile row exists per version.
-- =============================================================================

ALTER TABLE "verification_packages" ADD COLUMN IF NOT EXISTS "state" VARCHAR(16) NOT NULL DEFAULT 'PUBLISHED';
ALTER TABLE "verification_packages" ADD COLUMN IF NOT EXISTS "issuance_id" UUID;
ALTER TABLE "verification_packages" ADD COLUMN IF NOT EXISTS "report_id" UUID;
ALTER TABLE "verification_packages" ADD COLUMN IF NOT EXISTS "supersedes_package_id" UUID;
ALTER TABLE "verification_packages" ADD COLUMN IF NOT EXISTS "seal_signing_key_id" VARCHAR(64);
ALTER TABLE "verification_packages" ADD COLUMN IF NOT EXISTS "seal_signing_key_version" INTEGER;
ALTER TABLE "verification_packages" ADD COLUMN IF NOT EXISTS "reserved_at_utc" TIMESTAMPTZ(6);
ALTER TABLE "verification_packages" ADD COLUMN IF NOT EXISTS "completed_at_utc" TIMESTAMPTZ(6);
ALTER TABLE "verification_packages" ADD COLUMN IF NOT EXISTS "failed_at_utc" TIMESTAMPTZ(6);
ALTER TABLE "verification_packages" ADD COLUMN IF NOT EXISTS "terminal_reason" VARCHAR(64);

-- A RESERVED / FAILED row has no stored object yet.
ALTER TABLE "verification_packages" ALTER COLUMN "storage_bucket" DROP NOT NULL;
ALTER TABLE "verification_packages" ALTER COLUMN "storage_key" DROP NOT NULL;
ALTER TABLE "verification_packages" ALTER COLUMN "generated_at_utc" DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verification_packages_state_check') THEN
    ALTER TABLE "verification_packages"
      ADD CONSTRAINT "verification_packages_state_check"
      CHECK ("state" IN ('RESERVED', 'PUBLISHED', 'FAILED'));
  END IF;
  -- A published package always names its stored object and its issue time.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verification_packages_published_storage_check') THEN
    ALTER TABLE "verification_packages"
      ADD CONSTRAINT "verification_packages_published_storage_check"
      CHECK ("state" <> 'PUBLISHED' OR ("storage_bucket" IS NOT NULL AND "storage_key" IS NOT NULL AND "generated_at_utc" IS NOT NULL));
  END IF;
  -- A failed package names why.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verification_packages_failed_reason_check') THEN
    ALTER TABLE "verification_packages"
      ADD CONSTRAINT "verification_packages_failed_reason_check"
      CHECK ("state" <> 'FAILED' OR ("failed_at_utc" IS NOT NULL AND "terminal_reason" IS NOT NULL));
  END IF;
END $$;

-- The profile vocabulary now admits the external disclosure profile (the
-- 20281005000000 CHECK admitted FULL_FORENSIC only). Swapped idempotently.
ALTER TABLE "verification_packages" DROP CONSTRAINT IF EXISTS "verification_packages_disclosure_profile_check";
ALTER TABLE "verification_packages"
  ADD CONSTRAINT "verification_packages_disclosure_profile_check"
  CHECK ("disclosure_profile" IS NULL OR "disclosure_profile" IN ('FULL_FORENSIC', 'EXTERNAL_DISCLOSURE'));

-- THE PROFILE-AWARE UNIQUE KEYS, then (only once both exist) the retirement of
-- the (evidence_id, version) key in the same guarded block.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'verification_packages' AND column_name = 'evidence_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'verification_packages' AND column_name = 'version'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'verification_packages' AND column_name = 'disclosure_profile'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "verification_packages_primary_version_key" ON "verification_packages" ("evidence_id", "version") WHERE "disclosure_profile" IS NULL OR "disclosure_profile" = ''FULL_FORENSIC''';
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "verification_packages_external_version_key" ON "verification_packages" ("evidence_id", "version") WHERE "disclosure_profile" = ''EXTERNAL_DISCLOSURE''';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "verification_packages_issuance_idx" ON "verification_packages" ("issuance_id");

-- The bounded public lookup by the exact bytes a recipient holds.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'verification_packages' AND column_name = 'package_sha256'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "verification_packages_package_sha256_idx" ON "verification_packages" ("package_sha256")';
  END IF;
END $$;

-- RETIRE the (evidence_id, version) key — ONLY while both profile keys exist,
-- so the table is never left without per-version uniqueness. The guard and the
-- drop are one block, so the RAISE authorises the drop.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'verification_packages_primary_version_key'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'verification_packages_external_version_key'
  ) THEN
    RAISE EXCEPTION
      'verification package profile rows refused: the profile-aware unique keys are missing, so retiring (evidence_id, version) would leave no per-version uniqueness';
  END IF;
  EXECUTE 'DROP INDEX IF EXISTS "verification_packages_evidence_id_version_key"';
END $$;
