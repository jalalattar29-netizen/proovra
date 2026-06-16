-- Intake Links Operations Console — archive (additive).
--
-- Adds the operator-facing "archive" lifecycle to workflow_intake_links.
-- Archiving HIDES a link from the default Active view but does NOT close
-- public access (use revoke for that). Designed as the safe declutter
-- action: legally-cautious teams keep revoke as the only destructive
-- action; this one is reversible (POST /unarchive).
--
-- Fields:
--   - archived_at_utc      — timestamp the operator hit Archive
--   - archived_by_user_id  — actor for the audit trail
-- Both default NULL; existing rows are "not archived" without backfill.
--
-- Index:
--   (team_id, archived_at_utc) — supports the default-view list query
--   `WHERE team_id = $1 AND archived_at_utc IS NULL` and the All-tab
--   alternative `WHERE team_id = $1`.

ALTER TABLE "workflow_intake_links"
  ADD COLUMN IF NOT EXISTS "archived_at_utc"     TIMESTAMPTZ(6);

ALTER TABLE "workflow_intake_links"
  ADD COLUMN IF NOT EXISTS "archived_by_user_id" UUID;

-- Phase O-Final guarded-INDEX pattern (see test/phase-o-migration-safety-gate.test.ts).
-- Wrap the CREATE INDEX in an information_schema.columns existence
-- check so partial replay can't trip on a missing column.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'workflow_intake_links'
       AND column_name  = 'archived_at_utc'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'workflow_intake_links'
       AND column_name  = 'team_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "workflow_intake_links_team_archived_idx" ON "workflow_intake_links" ("team_id", "archived_at_utc")';
  END IF;
END $$;
