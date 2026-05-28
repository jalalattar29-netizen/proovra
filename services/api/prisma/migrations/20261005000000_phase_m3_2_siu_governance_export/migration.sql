-- Phase M3.2 — SIU governance + export persistence closure.
--
-- One additive table (`case_siu_saved_views`) for durable per-team
-- custom SIU views. Neon-safe: no existing column or constraint
-- changes; only `CREATE TABLE` + `CREATE INDEX`.
--
-- Notes:
--   * `case_siu_exports` already carries `artifact_storage_bucket` /
--     `artifact_storage_key` columns (added under M3.1). The M3.2
--     code path now populates them after the bundle ZIP is uploaded
--     to S3 — no schema change is required.
--   * `SIU_PII_REVEAL` is a bounded shared enum value, not a DB
--     enum, so it requires no migration either.

CREATE TABLE "case_siu_saved_views" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "team_id" uuid NOT NULL,
  "organization_id" uuid,
  "name" varchar(120) NOT NULL,
  "description" varchar(400),
  "filter_json" jsonb NOT NULL,
  "sort_json" jsonb NOT NULL,
  "visibility" varchar(16) NOT NULL DEFAULT 'private',
  "created_by_user_id" uuid NOT NULL,
  "updated_by_user_id" uuid,
  "last_used_at_utc" timestamptz(6),
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(6) NOT NULL,
  CONSTRAINT "case_siu_saved_views_pkey" PRIMARY KEY ("id")
);

-- One named view per (team, creator).
CREATE UNIQUE INDEX "case_siu_saved_view_team_owner_name_uniq"
  ON "case_siu_saved_views" ("team_id", "created_by_user_id", "name");

CREATE INDEX "case_siu_saved_views_team_id_idx"
  ON "case_siu_saved_views" ("team_id");
CREATE INDEX "case_siu_saved_views_team_id_visibility_idx"
  ON "case_siu_saved_views" ("team_id", "visibility");
CREATE INDEX "case_siu_saved_views_created_by_user_id_idx"
  ON "case_siu_saved_views" ("created_by_user_id");
CREATE INDEX "case_siu_saved_views_organization_id_idx"
  ON "case_siu_saved_views" ("organization_id");
