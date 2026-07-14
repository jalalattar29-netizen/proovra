-- Operations-Center forensic completion — organization notification policy
-- + snapshot resolution provenance.
--
-- ADDITIVE ONLY: CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS +
-- guarded FK/index creation. No destructive or data-mutating statements.
-- Idempotent — safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. organization_notification_policies — enterprise notification policy
--    (mandatory categories, minimum frequency, quiet-hours override).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "organization_notification_policies" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "category" VARCHAR(40) NOT NULL,
  "mandatory_in_app" BOOLEAN NOT NULL DEFAULT false,
  "mandatory_email" BOOLEAN NOT NULL DEFAULT false,
  "minimum_frequency" VARCHAR(16),
  "quiet_hours_critical_override" BOOLEAN NOT NULL DEFAULT true,
  "policy_version" INTEGER NOT NULL DEFAULT 1,
  "created_by_user_id" UUID NOT NULL,
  "updated_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "organization_notification_policies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "organization_notification_policies_organization_id_categor_key"
  ON "organization_notification_policies"("organization_id", "category");
CREATE INDEX IF NOT EXISTS "organization_notification_policies_organization_id_idx"
  ON "organization_notification_policies"("organization_id");

DO $$
BEGIN
  IF to_regclass('public.organizations') IS NOT NULL THEN
    BEGIN
      ALTER TABLE "organization_notification_policies"
        ADD CONSTRAINT "organization_notification_policies_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. operations_inbox_snapshots — resolution provenance columns.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.operations_inbox_snapshots') IS NOT NULL THEN
    ALTER TABLE "operations_inbox_snapshots"
      ADD COLUMN IF NOT EXISTS "resolution_source" VARCHAR(32);
    ALTER TABLE "operations_inbox_snapshots"
      ADD COLUMN IF NOT EXISTS "resolved_by_user_id" UUID;
  END IF;
END $$;
