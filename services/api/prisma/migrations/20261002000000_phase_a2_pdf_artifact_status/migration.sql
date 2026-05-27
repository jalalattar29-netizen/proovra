-- Phase A2 — PDF artifact signature status + custody events.
--
-- Pure additive migration. Adds the four columns the API contract
-- needs to expose the PDF artifact signature status explicitly, plus
-- two custody event values so the timeline distinguishes PDF signing
-- from report generation.
--
-- Operational characteristics:
--   * IDEMPOTENT — every statement uses IF NOT EXISTS / ADD VALUE IF
--     NOT EXISTS.
--   * NO TABLE REWRITES — adding a nullable column is metadata-only
--     in Postgres.
--   * NO LONG LOCKS — the four ALTER TABLE statements take brief
--     AccessExclusiveLocks (milliseconds).
--   * NO DESTRUCTIVE OPS.
--
-- Backward compatibility:
--   * Existing Report rows have NULL for the four new columns. The
--     API contract treats NULL as "legacy report, signature status
--     unknown" and surfaces it as UNSIGNED_OPT_OUT only when the
--     operator has the opt-out env var set; otherwise it stays
--     LEGACY-shaped on the wire. The frontend never asserts a
--     signed badge on NULL.
--   * No existing query depends on these columns yet, so the
--     migration is reversible by dropping the columns + removing the
--     two enum values (the enum drop requires a column rewrite; the
--     additive direction is the supported path).

ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS pdf_signature_status VARCHAR(32);

ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS pdf_signed_at_utc TIMESTAMPTZ(6);

ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS pdf_signer_key_id VARCHAR(120);

ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS pdf_signing_warning VARCHAR(400);

-- Custody event vocabulary expansion. ADD VALUE IF NOT EXISTS is
-- idempotent and ships in Postgres 12+.
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'REPORT_PDF_SIGNED';
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'REPORT_PDF_UNSIGNED_OPT_OUT';
