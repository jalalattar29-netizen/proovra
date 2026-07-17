-- Lifecycle Phase 4 (2026-07-17) — personal account data export requests.
--
-- ADDITIVE ONLY: CREATE TABLE IF NOT EXISTS + guarded index/FK creation.
-- No destructive statements, no backfill needed (requests start empty).
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS "account_data_export_requests" (
  "id"                     UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id"                UUID NOT NULL,
  "status"                 VARCHAR(20) NOT NULL DEFAULT 'REQUESTED',
  "requested_at_utc"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at_utc"         TIMESTAMPTZ(6),
  "completed_at_utc"       TIMESTAMPTZ(6),
  "expires_at_utc"         TIMESTAMPTZ(6),
  "failure_code"           VARCHAR(60),
  "package_json"           TEXT,
  "package_sha256"         VARCHAR(64),
  "schema_version"         INTEGER NOT NULL DEFAULT 1,
  "download_count"         INTEGER NOT NULL DEFAULT 0,
  "last_downloaded_at_utc" TIMESTAMPTZ(6),
  "created_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "account_data_export_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "account_data_export_requests_user_id_status_idx"
  ON "account_data_export_requests" ("user_id", "status");

CREATE INDEX IF NOT EXISTS "account_data_export_requests_status_requested_at_utc_idx"
  ON "account_data_export_requests" ("status", "requested_at_utc");

DO $$
BEGIN
  ALTER TABLE "account_data_export_requests"
    ADD CONSTRAINT "account_data_export_requests_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
