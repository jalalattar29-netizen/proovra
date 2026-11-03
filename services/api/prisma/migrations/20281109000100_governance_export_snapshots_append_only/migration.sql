-- =============================================================================
-- 2026-11-03 — GOV-009: an export snapshot is the record it claims to be.
--
-- EXPAND / SAFE_TO_APPLY_NOW, no backfill. A governance export snapshot freezes
-- what left a workspace and why it was allowed; the code only ever inserts one.
-- A database actor could still edit or delete it. It now refuses both, through
-- the refusal 20281102000000 defined for destruction certificates. No row is
-- read or rewritten, and an image that predates this migration never updates or
-- deletes a snapshot either.
-- =============================================================================

DROP TRIGGER IF EXISTS "governance_export_snapshots_append_only" ON "governance_export_snapshots";
CREATE TRIGGER "governance_export_snapshots_append_only"
  BEFORE UPDATE OR DELETE ON "governance_export_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "proovra_refuse_history_rewrite"();
