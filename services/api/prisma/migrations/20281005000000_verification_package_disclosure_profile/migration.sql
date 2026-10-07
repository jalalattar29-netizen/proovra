-- VERIFICATION-PACKAGE DISCLOSURE PROFILES (2026-10-07).
--
-- One package generator now issues two projections of the same facts per
-- report version, sealed by the same signer: the FULL_FORENSIC package (the
-- row itself, as before) and an EXTERNAL_DISCLOSURE package that withholds the
-- original files, the report and personal/infrastructure identifiers while
-- keeping every cryptographic commitment.
--
--   disclosure_profile            the row's own profile. NULL = issued before
--                                 profiles existed (legacy; never relabelled).
--   external_disclosure_artifact  the companion EXTERNAL_DISCLOSURE package
--                                 issued in the same run: its package id,
--                                 storage key + version id, digest, size and
--                                 seal facts. NULL = none (legacy).
--
-- Keeping both on ONE row preserves the one-package-per-report-version
-- invariant (verification_packages_evidence_id_version_key) and the RGA-05
-- package -> report pairing; no constraint or index is replaced.
--
-- Additive and expand-only: nullable, no default, no backfill, no rewrite.
-- Old code ignores both columns; rollback is code-first (leave them).
ALTER TABLE "verification_packages" ADD COLUMN IF NOT EXISTS "disclosure_profile" VARCHAR(32);
ALTER TABLE "verification_packages" ADD COLUMN IF NOT EXISTS "external_disclosure_artifact" JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'verification_packages_disclosure_profile_check'
  ) THEN
    ALTER TABLE "verification_packages"
      ADD CONSTRAINT "verification_packages_disclosure_profile_check"
      CHECK ("disclosure_profile" IS NULL OR "disclosure_profile" IN ('FULL_FORENSIC'));
  END IF;
END$$;
