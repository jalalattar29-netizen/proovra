-- EVIDENCE OUTPUT LIFECYCLE (2026-09-29). Additive only: new nullable columns.
-- No existing row is rewritten or backfilled, and no type, constraint or
-- column is changed.
--
-- 1. reports: the exact S3 object version a row describes (s3_version_id);
--    how the report was issued (issue_kind FIRST_ISSUE | UPDATED_REPORT |
--    LEGACY, issue_reason, previous_report_version) so an updated report can
--    never masquerade as a recovery; and the last custody sequence the PDF
--    describes (custody_through_sequence).
-- 2. verification_packages: the SHA-256 of the exact ZIP bytes
--    (package_sha256), their S3 version (s3_version_id), the package format
--    (package_format_version, 5 = sealed), when the certified report was
--    issued (report_issued_at_utc), and the custody cut-off
--    (custody_through_sequence).
--
-- Historical rows keep NULL in every new column. Readers treat NULL as
-- "not recorded" and say so; nothing is inferred or fabricated for them.

ALTER TABLE "reports"
  ADD COLUMN IF NOT EXISTS "s3_version_id" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "issue_kind" VARCHAR(24),
  ADD COLUMN IF NOT EXISTS "issue_reason" VARCHAR(200),
  ADD COLUMN IF NOT EXISTS "previous_report_version" INTEGER,
  ADD COLUMN IF NOT EXISTS "custody_through_sequence" INTEGER;

ALTER TABLE "verification_packages"
  ADD COLUMN IF NOT EXISTS "package_sha256" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "s3_version_id" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "package_format_version" INTEGER,
  ADD COLUMN IF NOT EXISTS "report_issued_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "custody_through_sequence" INTEGER;
