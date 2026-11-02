-- =============================================================================
-- 2026-11-01 — keep what the demo form requires.
--
-- EXPAND / SAFE_TO_APPLY_NOW, no backfill. Two nullable columns on demo_requests.
-- The form required both and the API dropped them, so sales lost the
-- qualification. Rows already received stay NULL: what they said was not kept.
-- =============================================================================

ALTER TABLE "demo_requests"
  ADD COLUMN IF NOT EXISTS "primary_interest" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "organization_type" VARCHAR(64);
