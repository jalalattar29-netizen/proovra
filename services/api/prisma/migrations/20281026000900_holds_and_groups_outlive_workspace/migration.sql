-- LEGAL HOLDS AND ORGANIZATION SCIM GROUPS DO NOT CASCADE WITH A WORKSPACE
-- (members audit re-audit, defects 8 and 12, 2026-10-26).
--
-- evidence_legal_holds.team_id and scim_groups.team_id were ON DELETE CASCADE:
-- deleting a teams row — no product path does (no workspace kind has a
-- self-service hard delete), but a raw or operator delete could — would erase
-- every legal hold placed in it, and every Organization-owned SCIM group
-- configured from it. A legal hold must never disappear with its tenant, and
-- a group belongs to its Organization, not to the workspace it was configured
-- from.
--
-- Each foreign key is re-created with the same columns, ON UPDATE CASCADE and
-- ON DELETE RESTRICT. No row is touched. Idempotent: guarded on the delete
-- rule currently in force.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'evidence_legal_holds_team_id_fkey' AND confdeltype <> 'r'
  ) THEN
    ALTER TABLE "evidence_legal_holds" DROP CONSTRAINT "evidence_legal_holds_team_id_fkey";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_legal_holds_team_id_fkey') THEN
    ALTER TABLE "evidence_legal_holds"
      ADD CONSTRAINT "evidence_legal_holds_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'scim_groups_team_id_fkey' AND confdeltype <> 'r'
  ) THEN
    ALTER TABLE "scim_groups" DROP CONSTRAINT "scim_groups_team_id_fkey";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scim_groups_team_id_fkey') THEN
    ALTER TABLE "scim_groups"
      ADD CONSTRAINT "scim_groups_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
