-- =============================================================================
-- ARTIFACT RECOVERY PROGRESS — report/package pairing and per-request progress.
--
-- EXPAND / SAFE_TO_APPLY_NOW. Purely additive: nullable columns and one
-- guarded unique index. Nothing existing is dropped, narrowed, renamed or
-- backfilled. A deployment still running the prior build never reads or
-- writes these columns and is unaffected.
--
-- WHY.
--   * reports.pdf_sha256 — the SHA-256 of the exact report PDF bytes that were
--     stored. Package-only recovery must embed the STORED report, and may do
--     so only after verifying those bytes against a recorded hash. NULL on
--     rows written before this migration; recovery then verifies against the
--     checksum object storage recorded at upload, or refuses.
--   * verification_packages.report_version / report_sha256 — the explicit
--     reference from a package to the report it certifies, and the hash of the
--     report bytes it embeds. Pairing was implicit (equal version numbers).
--   * report_generation_requests.report_version / stage — durable progress.
--     `report_version` is the report version this request COMMITTED (full
--     generation) or TARGETS (package-only recovery); `stage` is the last
--     durable boundary reached (REPORT_COMMITTED, PACKAGE_PUBLISHED). A retry
--     resumes from them instead of minting another report version.
--   * report_generation_requests.intent — the operation a person asked for
--     (GENERATE, RECOVER, RETRY, NEW_VERSION, OPERATOR_SUPERSEDE).
--   * report_generation_requests.client_request_key — the caller's
--     idempotency key for an explicit new version, so a repeat after a lost
--     response returns the original request instead of a second version.
-- =============================================================================

ALTER TABLE "reports" ADD COLUMN IF NOT EXISTS "pdf_sha256" VARCHAR(64);

ALTER TABLE "verification_packages" ADD COLUMN IF NOT EXISTS "report_version" INTEGER;
ALTER TABLE "verification_packages" ADD COLUMN IF NOT EXISTS "report_sha256" VARCHAR(64);

ALTER TABLE "report_generation_requests" ADD COLUMN IF NOT EXISTS "report_version" INTEGER;
ALTER TABLE "report_generation_requests" ADD COLUMN IF NOT EXISTS "stage" VARCHAR(32);
ALTER TABLE "report_generation_requests" ADD COLUMN IF NOT EXISTS "intent" VARCHAR(24);
ALTER TABLE "report_generation_requests" ADD COLUMN IF NOT EXISTS "client_request_key" VARCHAR(80);

-- One request per (record, caller idempotency key). NULL keys are distinct in
-- PostgreSQL, so every request without a caller key is unaffected.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'report_generation_requests' AND column_name = 'evidence_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'report_generation_requests' AND column_name = 'client_request_key'
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "report_generation_requests_evidence_client_key"
      ON "report_generation_requests" ("evidence_id", "client_request_key");
  END IF;
END$$;
