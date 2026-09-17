-- =============================================================================
-- UC-0 — Acquisition / provenance / derivative foundation.
--
-- THE DEFECTS THIS CLOSES
-- -----------------------------------------------------------------------------
-- PROOVRA had no truthful, persisted answer to "how did this Evidence enter
-- PROOVRA?":
--
--   * `evidence.capture_method` was written as an acquisition marker
--     (EXTERNAL_INTAKE_UPLOAD) and then OVERWRITTEN by completion with a
--     STRUCTURE value (UPLOADED_FILE / MULTIPART_PACKAGE), so every reader of
--     it saw structure, not acquisition.
--   * `capture_environment.uploadSource` was hard-coded per route and
--     inverted: the native app recorded WEB_APP, the browser citizen route
--     recorded MOBILE_APP.
--   * direct-capture trust events were never bound to an Evidence row, and
--     capture sessions had no server-issued nonce.
--   * derived assets carried no transformation descriptor and could not hold
--     more than one variant per kind.
--
-- WHAT THIS MIGRATION DOES (ALL ADDITIVE)
-- -----------------------------------------------------------------------------
--   1. evidence.acquisition_mode / acquisition_mode_source (nullable, bounded
--      by CHECK), a (team_id, acquisition_mode) index, and a SET-ONCE trigger:
--      once a value is present no UPDATE may change or clear it.
--   2. D9 BACKFILL — ONLY where the unique
--      workflow_intake_sessions.evidence_id join proves the record came
--      through secure intake. Marked BACKFILL_INTAKE_SESSION_LINK so it can
--      never pass for a value recorded at creation. Every other historical row
--      stays NULL (= "not recorded"). Nothing is inferred from capture_method,
--      uploadSource, MIME type, file name, EXIF or client signals.
--   3. evidence_parts.artifact_class NOT NULL DEFAULT 'ORIGINAL'. TRUE for
--      every existing row: a part has only ever been an original upload (no
--      capture manifest was ever stored; derivatives are never parts). This is
--      a structural fact, not a provenance claim.
--   4. reports.acquisition_mode_snapshot (nullable).
--   5. capture_sessions: direct-capture session fields + a unique nonce hash,
--      and enum values ACTIVE / BOUND / INTERRUPTED.
--   6. capture_device_attestations.verifier_version (nullable). NULL marks a
--      verdict written by the pre-UC-0, metadata-trusting verifier; readers
--      re-project its positive verdicts as UNVERIFIED. No row is rewritten.
--   7. evidence_part_derived_assets: transformation, parameters_sha256,
--      source_offset_ms, variant_key (DEFAULT 'default') and the canonical
--      unique key (team, part, kind, variant). The narrower (team, part, kind)
--      key is RETAINED so an older image's ON CONFLICT target still exists; it
--      is dropped by a later contract migration once no image uses it.
--
-- SAFE BEFORE CODE: every column is nullable or defaulted, the new unique key
-- is implied by the old one while every row carries variant 'default', and the
-- set-once trigger only refuses CHANGING a non-null acquisition value — which
-- no existing code writes. Deterministic and idempotent: re-running is a
-- no-op (IF NOT EXISTS guards; the backfill only touches NULL rows).
-- ROLLBACK is code-first: revert the images and leave the schema expanded.
-- =============================================================================

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'evidence', 'evidence_parts', 'reports', 'capture_sessions',
    'capture_device_attestations', 'evidence_part_derived_assets',
    'workflow_intake_sessions'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) THEN
      RAISE EXCEPTION 'UC-0 foundation: table % does not exist', t;
    END IF;
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- 1. Evidence acquisition authority
-- -----------------------------------------------------------------------------
ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "acquisition_mode" VARCHAR(64);
ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "acquisition_mode_source" VARCHAR(40);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'evidence_acquisition_mode_check'
  ) THEN
    ALTER TABLE "evidence" ADD CONSTRAINT "evidence_acquisition_mode_check"
      CHECK ("acquisition_mode" IS NULL OR "acquisition_mode" IN (
        'PROOVRA_WEB_UPLOAD',
        'SECURE_INTAKE_LINK',
        'PROOVRA_MOBILE_APP'
      ));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'evidence_acquisition_mode_source_check'
  ) THEN
    ALTER TABLE "evidence" ADD CONSTRAINT "evidence_acquisition_mode_source_check"
      CHECK ("acquisition_mode_source" IS NULL OR "acquisition_mode_source" IN (
        'RECORDED_AT_CREATION',
        'BACKFILL_INTAKE_SESSION_LINK'
      ));
  END IF;
  -- A mode and its source exist together or not at all.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'evidence_acquisition_pair_check'
  ) THEN
    ALTER TABLE "evidence" ADD CONSTRAINT "evidence_acquisition_pair_check"
      CHECK (("acquisition_mode" IS NULL) = ("acquisition_mode_source" IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "evidence_team_id_acquisition_mode_idx"
  ON "evidence" ("team_id", "acquisition_mode");

-- -----------------------------------------------------------------------------
-- 2. D9 backfill — proven intake only
-- -----------------------------------------------------------------------------
UPDATE "evidence" AS e
   SET "acquisition_mode" = 'SECURE_INTAKE_LINK',
       "acquisition_mode_source" = 'BACKFILL_INTAKE_SESSION_LINK'
  FROM "workflow_intake_sessions" AS s
 WHERE s."evidence_id" = e."id"
   AND e."acquisition_mode" IS NULL;

-- Set-once guard. Created AFTER the backfill so the backfill is the only
-- statement that ever moves a row from NULL without going through
-- `createEvidence`; the trigger itself permits NULL -> value either way.
CREATE OR REPLACE FUNCTION "evidence_acquisition_set_once"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Written without IS DISTINCT FROM: OLD is known non-null on each branch.
  IF OLD."acquisition_mode" IS NOT NULL
     AND (NEW."acquisition_mode" IS NULL
          OR NEW."acquisition_mode" <> OLD."acquisition_mode") THEN
    RAISE EXCEPTION 'evidence.acquisition_mode is immutable once recorded'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."acquisition_mode_source" IS NOT NULL
     AND (NEW."acquisition_mode_source" IS NULL
          OR NEW."acquisition_mode_source" <> OLD."acquisition_mode_source") THEN
    RAISE EXCEPTION 'evidence.acquisition_mode_source is immutable once recorded'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "evidence_acquisition_set_once_trg" ON "evidence";
CREATE TRIGGER "evidence_acquisition_set_once_trg"
  BEFORE UPDATE ON "evidence"
  FOR EACH ROW EXECUTE FUNCTION "evidence_acquisition_set_once"();

-- -----------------------------------------------------------------------------
-- 3. Artifact class on parts
-- -----------------------------------------------------------------------------
ALTER TABLE "evidence_parts"
  ADD COLUMN IF NOT EXISTS "artifact_class" VARCHAR(32) NOT NULL DEFAULT 'ORIGINAL';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'evidence_parts_artifact_class_check'
  ) THEN
    ALTER TABLE "evidence_parts" ADD CONSTRAINT "evidence_parts_artifact_class_check"
      CHECK ("artifact_class" IN ('ORIGINAL', 'CAPTURE_MANIFEST'));
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 4. Report snapshot
-- -----------------------------------------------------------------------------
ALTER TABLE "reports"
  ADD COLUMN IF NOT EXISTS "acquisition_mode_snapshot" VARCHAR(64);

-- -----------------------------------------------------------------------------
-- 5. Direct-capture sessions
-- -----------------------------------------------------------------------------
ALTER TYPE "CaptureSessionStatus" ADD VALUE IF NOT EXISTS 'ACTIVE';
ALTER TYPE "CaptureSessionStatus" ADD VALUE IF NOT EXISTS 'BOUND';
ALTER TYPE "CaptureSessionStatus" ADD VALUE IF NOT EXISTS 'INTERRUPTED';

ALTER TABLE "capture_sessions" ADD COLUMN IF NOT EXISTS "acquisition_mode" VARCHAR(64);
ALTER TABLE "capture_sessions" ADD COLUMN IF NOT EXISTS "nonce_sha256" VARCHAR(64);
ALTER TABLE "capture_sessions" ADD COLUMN IF NOT EXISTS "device_id" UUID;
ALTER TABLE "capture_sessions" ADD COLUMN IF NOT EXISTS "started_at_utc" TIMESTAMPTZ(6);
ALTER TABLE "capture_sessions" ADD COLUMN IF NOT EXISTS "ended_at_utc" TIMESTAMPTZ(6);
ALTER TABLE "capture_sessions" ADD COLUMN IF NOT EXISTS "end_reason" VARCHAR(40);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'capture_sessions_acquisition_mode_check'
  ) THEN
    ALTER TABLE "capture_sessions" ADD CONSTRAINT "capture_sessions_acquisition_mode_check"
      CHECK ("acquisition_mode" IS NULL OR "acquisition_mode" IN (
        'PROOVRA_WEB_UPLOAD',
        'SECURE_INTAKE_LINK',
        'PROOVRA_MOBILE_APP'
      ));
  END IF;
END $$;

-- The table is small (drafts expire); a plain unique index is appropriate.
CREATE UNIQUE INDEX IF NOT EXISTS "capture_sessions_nonce_sha256_key"
  ON "capture_sessions" ("nonce_sha256");

-- -----------------------------------------------------------------------------
-- 6. Attestation verifier provenance
-- -----------------------------------------------------------------------------
ALTER TABLE "capture_device_attestations"
  ADD COLUMN IF NOT EXISTS "verifier_version" VARCHAR(80);

-- -----------------------------------------------------------------------------
-- 7. Derivative lineage descriptor
-- -----------------------------------------------------------------------------
ALTER TABLE "evidence_part_derived_assets"
  ADD COLUMN IF NOT EXISTS "transformation" VARCHAR(64);
ALTER TABLE "evidence_part_derived_assets"
  ADD COLUMN IF NOT EXISTS "parameters_sha256" VARCHAR(64);
ALTER TABLE "evidence_part_derived_assets"
  ADD COLUMN IF NOT EXISTS "source_offset_ms" INTEGER;
ALTER TABLE "evidence_part_derived_assets"
  ADD COLUMN IF NOT EXISTS "variant_key" VARCHAR(64) NOT NULL DEFAULT 'default';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidence_part_derived_assets_source_offset_bounded'
  ) THEN
    ALTER TABLE "evidence_part_derived_assets"
      ADD CONSTRAINT "evidence_part_derived_assets_source_offset_bounded"
      CHECK ("source_offset_ms" IS NULL OR "source_offset_ms" >= 0);
  END IF;
END $$;

-- Implied by the retained (team, part, kind) key while every row carries
-- variant 'default', so the build cannot fail on existing data.
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_part_derived_assets_team_part_kind_variant_uk"
  ON "evidence_part_derived_assets" ("team_id", "evidence_part_id", "asset_kind", "variant_key");
