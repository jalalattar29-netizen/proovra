-- =============================================================================
-- A Collaboration Team's reach into a Case (members audit ACC-01 / ACC-10).
--
-- THE RULE
-- -----------------------------------------------------------------------------
-- Roles define capability; access lists define reach. A Case with ANY
-- `case_access` row or ANY row in this table is RESTRICTED: only its owner, the
-- members on its `case_access` list and the effective members of an ACTIVE
-- Collaboration Team granted here may open it, and the Evidence linked to it
-- inherits that restriction. Workspace membership alone — OWNER and ADMIN
-- included — never reaches a restricted Case. An ARCHIVED team's grant confers
-- nothing.
--
-- PURELY ADDITIVE
-- -----------------------------------------------------------------------------
-- One new, empty table. No existing column, row, index or constraint is read,
-- altered or dropped. An older image never selects the table; a newer image
-- finding it empty answers exactly as before (no Case gains or loses reach).
--
-- FOREIGN KEYS
-- -----------------------------------------------------------------------------
-- case_id → cases ON DELETE CASCADE: a deleted case takes its grants with it,
-- exactly as `case_access` does.
-- collaboration_team_id → collaboration_teams ON DELETE RESTRICT: a team that
-- still holds case grants is not disposable; it is archived instead, and an
-- archived team's grants stop conferring reach.
--
-- A plain CREATE TABLE, deliberately: `IF NOT EXISTS` would silently skip a
-- table that already exists with a different shape (the Phase O-final rule).
-- prisma migrate applies this once; the index and constraint statements are
-- guarded so a partially applied run can complete.
-- =============================================================================

CREATE TABLE "case_collaboration_team_access" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "case_id" UUID NOT NULL,
    "collaboration_team_id" UUID NOT NULL,
    "granted_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_collaboration_team_access_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "case_collaboration_team_access_collaboration_team_id_idx"
    ON "case_collaboration_team_access"("collaboration_team_id");

CREATE UNIQUE INDEX IF NOT EXISTS "case_collaboration_team_access_case_id_collaboration_team_i_key"
    ON "case_collaboration_team_access"("case_id", "collaboration_team_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'case_collaboration_team_access_case_id_fkey'
  ) THEN
    ALTER TABLE "case_collaboration_team_access"
      ADD CONSTRAINT "case_collaboration_team_access_case_id_fkey"
      FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'case_collaboration_team_access_collaboration_team_id_fkey'
  ) THEN
    ALTER TABLE "case_collaboration_team_access"
      ADD CONSTRAINT "case_collaboration_team_access_collaboration_team_id_fkey"
      FOREIGN KEY ("collaboration_team_id") REFERENCES "collaboration_teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
