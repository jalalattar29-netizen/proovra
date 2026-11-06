-- =============================================================================
-- 2026-11-04 — REPORT-004: output preferences hold OUTPUTS, never sealing.
--
-- EXPAND / SAFE_TO_APPLY_NOW, no backfill. Three nullable columns on evidence:
-- when a record is finalized while the workspace output policy refuses its
-- report or package (allowReportDownload / allowPackageDownload off, a
-- requireReviewBefore* gate not yet met, an unreadable policy), the record is
-- sealed as always and its first outputs are HELD: no report or package request
-- is created until the policy, re-read live on the same authority, allows them.
-- `outputs_held_actor_user_id` is the person on whose authority the record was
-- finalized, so the release is decided for the same role.
--
-- ADD COLUMN with no default rewrites no row. No existing record is held.
-- =============================================================================

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "outputs_held_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "outputs_held_reason" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "outputs_held_actor_user_id" UUID;
