-- Phase A1 — Evidence organization tenancy finalization.
--
-- Closes the open seam where `evidence.organization_id` could be NULL,
-- wrong, or unconstrained. The Phase 2.7X Stage 6 migration already
-- tightened `teams.organization_id` to NOT NULL, which means every
-- Team deterministically resolves to one Organization. Until this
-- migration, Evidence rows had:
--
--   1. `organization_id` declared `Uuid?` with NO foreign key to
--      `organizations(id)`. Referential drift was not detected at
--      write time.
--
--   2. A real write-path bug in `services/api/src/services/evidence.service.ts`
--      that wrote `organizationId: scope.teamId` on create — i.e. the
--      Team's id was stored in the Organization column, producing
--      semantic garbage (a uuid that does not match any real
--      organization). This was silently accepted because no FK
--      existed.
--
--   3. No invariant linking `team_id` and `organization_id`. Even
--      after the write-path is fixed, historic rows can show
--      `team_id IS NOT NULL AND organization_id IS NULL` (legacy
--      pre-bug rows) or `organization_id` pointing at the wrong
--      organization (post-bug rows).
--
-- This migration is intentionally surgical. It does NOT:
--   * touch any row whose `team_id IS NULL` (legacy personal-mode
--     evidence remains owner-scoped; A1 does not migrate those —
--     they survive A1 unchanged).
--   * delete or rewrite any evidence content.
--   * change any other table's tenancy.
--
-- It DOES:
--   1. Re-resolve `evidence.organization_id` from `teams.organization_id`
--      for every row where `team_id IS NOT NULL`. This corrects the
--      Team-id-stored-as-org bug AND fills any NULL for rows that
--      pre-date the column.
--   2. Add a foreign key on `evidence.organization_id` to
--      `organizations(id)` with `ON DELETE RESTRICT` and `NOT VALID`,
--      then validate it. NOT VALID + VALIDATE is enterprise-safe on
--      large tables: the validation pass takes a SHARE UPDATE
--      EXCLUSIVE lock (read+write OK).
--   3. Add a CHECK constraint that prevents
--      `team_id IS NOT NULL AND organization_id IS NULL`. Personal-
--      mode rows (`team_id IS NULL AND organization_id IS NULL`)
--      remain legal — the solo-user workflow is unaffected.
--   4. Add an index on `(team_id, organization_id)` used by the
--      Phase B0 governance inheritance lookups.
--
-- Operational characteristics:
--   * IDEMPOTENT — every statement uses `IF [NOT] EXISTS` or is
--     re-runnable through the natural UPDATE.
--   * BATCH-FRIENDLY — the UPDATE uses a deterministic join; the
--     `safe-migrate` wrapper still requires the explicit remote
--     override + backup ack to run against non-local databases.
--   * NO TABLE REWRITES — `SET NOT NULL` is intentionally NOT
--     applied here. A future Stage 7 migration may do it after a
--     full operator-led population sweep of legacy `team_id IS NULL`
--     evidence is decided.
--   * PARTIAL-FAILURE TOLERANT — the FK addition uses NOT VALID so
--     the table is not locked while existing rows are checked. The
--     validation step is broken out into its own statement so an
--     operator can run it in a separate maintenance window if a
--     genuinely huge dataset needs it.

-- Step 1 — re-resolve organization_id from team.organization_id.
-- Targets:
--   (a) rows where evidence.organization_id IS NULL but team_id is set
--   (b) rows where evidence.organization_id was previously written
--       with the team's id (the Phase A1 write-path bug). After this
--       UPDATE, organization_id matches teams.organization_id
--       deterministically.
UPDATE evidence
SET organization_id = teams.organization_id
FROM teams
WHERE evidence.team_id = teams.id
  AND (
    evidence.organization_id IS DISTINCT FROM teams.organization_id
  );

-- Step 2 — declare the foreign key constraint as NOT VALID so the
-- attach itself takes only a brief AccessExclusiveLock and does not
-- scan the table. Idempotent via the conditional DO block.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidence_organization_id_fkey'
  ) THEN
    ALTER TABLE evidence
      ADD CONSTRAINT evidence_organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES organizations(id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;
END $$;

-- Step 3 — validate the FK. Takes a SHARE UPDATE EXCLUSIVE lock
-- which allows concurrent reads + writes. On Neon / RDS-scale this
-- is the right shape. If your table is so large you cannot afford
-- even this lock, comment out this step and run it manually in a
-- maintenance window.
ALTER TABLE evidence
  VALIDATE CONSTRAINT evidence_organization_id_fkey;

-- Step 4 — invariant: a row with a team MUST have a matching
-- organization. Personal-mode rows (team_id IS NULL AND
-- organization_id IS NULL) remain valid.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidence_team_implies_org_chk'
  ) THEN
    ALTER TABLE evidence
      ADD CONSTRAINT evidence_team_implies_org_chk
      CHECK (
        team_id IS NULL OR organization_id IS NOT NULL
      ) NOT VALID;
  END IF;
END $$;

ALTER TABLE evidence
  VALIDATE CONSTRAINT evidence_team_implies_org_chk;

-- Step 5 — supporting index for the Phase B0 inheritance lookups
-- (workspace + org joins for governance policy resolution).
CREATE INDEX IF NOT EXISTS evidence_team_id_organization_id_idx
  ON evidence (team_id, organization_id);
