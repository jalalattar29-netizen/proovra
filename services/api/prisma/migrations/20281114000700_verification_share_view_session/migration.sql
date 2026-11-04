-- =============================================================================
-- 2026-11-04 — REPORT-013: a use of a use-limited reviewer link is one viewing
-- session, not one page load.
--
-- EXPAND / SAFE_TO_APPLY_NOW, no backfill. One nullable column on
-- verification_share_tokens: the SHA-256 (hex) of the opaque per-tab view
-- session that spent the link's most recent use. A reload or "Check latest
-- anchoring status" from that same session within the idle window does not
-- spend another use. The session id itself is never stored. Links used before
-- this migration have no session recorded, so their next load counts as before.
-- No row is rewritten.
-- =============================================================================

ALTER TABLE "verification_share_tokens"
  ADD COLUMN IF NOT EXISTS "last_use_session_hash" VARCHAR(64);
