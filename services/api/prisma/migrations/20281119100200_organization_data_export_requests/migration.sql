-- =============================================================================
-- 2026-11-04 — GOV-015: a customer-facing organization data export for
-- offboarding (DPA Appendix E, return on request).
--
-- EXPAND / SAFE_TO_APPLY_NOW. A new table; nothing existing is read or changed.
-- Apply BEFORE the API image (its Prisma client maps the table). Rollback: drop
-- the table (requests are re-creatable; the evidence itself is untouched).
-- =============================================================================

CREATE TABLE "organization_data_export_requests" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "requested_by_user_id" UUID NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'REQUESTED',
  "requested_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at_utc" TIMESTAMPTZ(6),
  "completed_at_utc" TIMESTAMPTZ(6),
  "expires_at_utc" TIMESTAMPTZ(6),
  "failure_code" VARCHAR(60),
  "manifest_json" TEXT,
  "manifest_sha256" VARCHAR(64),
  "record_count" INTEGER,
  "object_count" INTEGER,
  "held_record_count" INTEGER,
  "missing_object_count" INTEGER,
  "download_count" INTEGER NOT NULL DEFAULT 0,
  "last_downloaded_at_utc" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "organization_data_export_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "organization_data_export_requests_organization_id_status_idx"
  ON "organization_data_export_requests" ("organization_id", "status");
CREATE INDEX "organization_data_export_requests_status_requested_at_utc_idx"
  ON "organization_data_export_requests" ("status", "requested_at_utc");