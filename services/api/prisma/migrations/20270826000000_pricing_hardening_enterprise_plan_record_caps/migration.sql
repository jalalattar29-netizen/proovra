-- Phase: Pricing hardening — Enterprise plan, evidence record caps, AI caps, legacy override.
--
-- Phase O-Final safety pattern:
--   * Every CREATE INDEX statement is wrapped in a DO block guarded by an
--     `information_schema.columns` existence check for each referenced column.
--     The classifier in `services/api/scripts/full-migration-audit.mjs`
--     accepts this as `CREATE_INDEX_GUARDED` (MEDIUM) instead of
--     `INDEX_COLUMN_RISK` (CRITICAL).
--   * ADD COLUMN uses `IF NOT EXISTS` so the migration is idempotent.
--   * ALTER TYPE ADD VALUE uses `IF NOT EXISTS` and is the only allowed
--     pattern for extending Postgres enums non-destructively.
--   * The backfill is bounded to a single UPDATE with an explicit WHERE
--     clause; it does not delete, hide, or modify existing records.
--
-- No subscriptions mutated. No Stripe / PayPal price IDs touched.

-- ──────────────────────────────────────────────────────────────────────
-- 1. ENTERPRISE enum value
-- ──────────────────────────────────────────────────────────────────────
ALTER TYPE "PlanType" ADD VALUE IF NOT EXISTS 'ENTERPRISE';

-- ──────────────────────────────────────────────────────────────────────
-- 2. legacy_record_cap_override column on entitlements
-- ──────────────────────────────────────────────────────────────────────
ALTER TABLE "entitlements"
  ADD COLUMN IF NOT EXISTS "legacy_record_cap_override" INTEGER;

-- ──────────────────────────────────────────────────────────────────────
-- 3. Phase O-Final-guarded compound indexes on evidence
--
-- Each index is created only when EVERY column it references is present
-- in the evidence table. The `information_schema.columns` check makes
-- the migration safe to re-run against schemas in any partial-repair
-- state (the canonical Phase O-Final pattern).
-- ──────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'evidence'
       AND column_name = 'team_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'evidence'
       AND column_name = 'created_at'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "evidence_team_id_created_at_idx"
             ON "evidence" ("team_id", "created_at" DESC)';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'evidence'
       AND column_name = 'team_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'evidence'
       AND column_name = 'deleted_at'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'evidence'
       AND column_name = 'created_at'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "evidence_team_id_deleted_at_created_at_idx"
             ON "evidence" ("team_id", "deleted_at", "created_at" DESC)';
  END IF;
END $$;

-- ──────────────────────────────────────────────────────────────────────
-- 4. Backfill grandfather overrides for PRO accounts already above 100
-- ──────────────────────────────────────────────────────────────────────
-- Rationale: PRO's new lifetime cap is 100. Existing accounts above 100
-- get an override equal to their current non-deleted record count, so
-- they retain access to their existing records but cannot create new
-- ones above that high-water mark until they delete records or move to
-- ENTERPRISE.
--
-- TEAM uses a rolling 30-day cap; no static backfill is required — the
-- window rolls forward naturally as records age past 30 days.
WITH pro_user_counts AS (
  SELECT
    t.owner_user_id AS user_id,
    COUNT(e.id)     AS record_count
  FROM "evidence" e
  INNER JOIN "teams" t ON t.id = e.team_id
  WHERE e.deleted_at IS NULL
    AND t.is_personal = TRUE
  GROUP BY t.owner_user_id
)
UPDATE "entitlements" ent
SET    "legacy_record_cap_override" = puc.record_count
FROM   pro_user_counts puc
WHERE  ent.user_id = puc.user_id
  AND  ent.plan = 'PRO'
  AND  ent.active = TRUE
  AND  puc.record_count > 100;
