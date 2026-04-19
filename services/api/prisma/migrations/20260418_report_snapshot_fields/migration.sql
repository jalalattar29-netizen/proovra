DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'reports'
      AND column_name = 'legal_limitations_snapshot'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'reports'
      AND column_name = 'limitations_snapshot'
  ) THEN
    EXECUTE 'ALTER TABLE "reports" RENAME COLUMN "legal_limitations_snapshot" TO "limitations_snapshot"';
  END IF;
END $$;

ALTER TABLE "reports"
  ADD COLUMN IF NOT EXISTS "display_title_snapshot" VARCHAR(200),
  ADD COLUMN IF NOT EXISTS "display_description_snapshot" VARCHAR(500),
  ADD COLUMN IF NOT EXISTS "content_structure_snapshot" VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "item_count_snapshot" INTEGER,
  ADD COLUMN IF NOT EXISTS "previewable_item_count_snapshot" INTEGER,
  ADD COLUMN IF NOT EXISTS "downloadable_item_count_snapshot" INTEGER,
  ADD COLUMN IF NOT EXISTS "primary_content_kind_snapshot" VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "primary_content_label_snapshot" VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "content_composition_summary_snapshot" VARCHAR(300),
  ADD COLUMN IF NOT EXISTS "content_access_policy_mode_snapshot" VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "default_preview_item_id_snapshot" UUID,
  ADD COLUMN IF NOT EXISTS "workspace_name_snapshot" VARCHAR(180),
  ADD COLUMN IF NOT EXISTS "organization_name_snapshot" VARCHAR(180),
  ADD COLUMN IF NOT EXISTS "organization_verified_snapshot" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "recorded_integrity_verified_at_utc_snapshot" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "last_verified_at_utc_snapshot" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "last_verified_source_snapshot" "VerificationSource",
  ADD COLUMN IF NOT EXISTS "storage_immutable_snapshot" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "display_snapshot" JSONB,
  ADD COLUMN IF NOT EXISTS "content_summary_snapshot" JSONB,
  ADD COLUMN IF NOT EXISTS "content_items_snapshot" JSONB,
  ADD COLUMN IF NOT EXISTS "primary_content_item_snapshot" JSONB,
  ADD COLUMN IF NOT EXISTS "preview_policy_snapshot" JSONB,
  ADD COLUMN IF NOT EXISTS "review_guidance_snapshot" JSONB,
  ADD COLUMN IF NOT EXISTS "limitations_snapshot" JSONB,
  ADD COLUMN IF NOT EXISTS "anchor_snapshot" JSONB,
  ADD COLUMN IF NOT EXISTS "content_access_policy_snapshot" JSONB,
  ADD COLUMN IF NOT EXISTS "embedded_previews_snapshot" JSONB;

CREATE INDEX IF NOT EXISTS "reports_display_title_snapshot_idx"
  ON "reports" ("display_title_snapshot");

CREATE INDEX IF NOT EXISTS "reports_content_structure_snapshot_idx"
  ON "reports" ("content_structure_snapshot");

CREATE INDEX IF NOT EXISTS "reports_primary_content_kind_snapshot_idx"
  ON "reports" ("primary_content_kind_snapshot");

CREATE INDEX IF NOT EXISTS "reports_item_count_snapshot_idx"
  ON "reports" ("item_count_snapshot");

CREATE INDEX IF NOT EXISTS "reports_recorded_integrity_verified_at_utc_snapshot_idx"
  ON "reports" ("recorded_integrity_verified_at_utc_snapshot");

CREATE INDEX IF NOT EXISTS "reports_last_verified_at_utc_snapshot_idx"
  ON "reports" ("last_verified_at_utc_snapshot");

CREATE INDEX IF NOT EXISTS "reports_reviewer_summary_version_idx"
  ON "reports" ("reviewer_summary_version");

CREATE INDEX IF NOT EXISTS "reports_verification_package_version_idx"
  ON "reports" ("verification_package_version");
