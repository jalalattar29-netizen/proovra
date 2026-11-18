-- =============================================================================
-- 2026-11-18 — WS-SCHED / PRO-BL2-02: the monthly export-package allowance is
-- RESERVED at admission instead of only read there and written at READY.
--
-- `quota_reserved_period_start_utc` names the entitlement_usage period row that
-- holds this package's reserved unit. NULL means "no reservation held": every
-- package created by an older API image, every DRAFT whose failed build gave
-- its unit back, and every package revoked before READY.
--
-- EXPAND / SAFE_TO_APPLY_NOW. One nullable column, no default rewrite, no
-- backfill. An older API image never writes it (its packages stay NULL and the
-- new worker meters them at READY exactly as before); an older worker never
-- reads it. Rollout order: migration, then worker, then API (an older worker
-- would meter a reserved package a second time at READY — over-count, never
-- under-count). Rollback: leave the column; NULL is the old behaviour.
-- =============================================================================

ALTER TABLE "evidence_exchange_packages"
  ADD COLUMN "quota_reserved_period_start_utc" TIMESTAMPTZ(6);
