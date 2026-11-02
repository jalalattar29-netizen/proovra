-- =============================================================================
-- 2026-11-01 — OPS-004: what the backup schedule actually did.
--
-- EXPAND / SAFE_TO_APPLY_NOW, no backfill. A new append-only table. The readiness
-- posture used to report "managed platform" whenever DATABASE_URL was set; it now
-- reads these rows, so only a backup, an off-host copy or a restore drill that
-- happened can be reported. An empty table reports that nothing is recorded.
--
-- Written by scripts/ops/pg-backup-cycle.sh. Holds counts and a checksum, never
-- data. Apply BEFORE the API image and before starting the backup services.
-- =============================================================================

CREATE TABLE IF NOT EXISTS "platform_backup_records" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "kind" VARCHAR(32) NOT NULL,
  "outcome" VARCHAR(16) NOT NULL,
  "backup_stamp" VARCHAR(32),
  "table_count" INTEGER,
  "row_count" BIGINT,
  "byte_count" BIGINT,
  "sha256" VARCHAR(64),
  "recorded_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_backup_records_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_backup_records_kind_check"
    CHECK ("kind" IN ('DATABASE_BACKUP', 'OFFHOST_COPY', 'RESTORE_DRILL')),
  CONSTRAINT "platform_backup_records_outcome_check"
    CHECK ("outcome" IN ('SUCCEEDED', 'FAILED'))
);

CREATE INDEX IF NOT EXISTS "platform_backup_records_kind_outcome_recorded_idx"
  ON "platform_backup_records" ("kind", "outcome", "recorded_at_utc" DESC);
