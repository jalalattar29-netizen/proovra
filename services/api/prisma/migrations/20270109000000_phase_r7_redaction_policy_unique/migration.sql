-- Phase R7 — RedactionPolicy workspace-scoped name uniqueness.
-- Promotes the soft "catch the conflict" behavior of createPolicy to a hard
-- DB constraint: a workspace cannot carry two redaction policies with the
-- same name. Additive (CREATE UNIQUE INDEX IF NOT EXISTS); no DROP, no
-- UPDATE, no SET NOT NULL.
--
-- The Phase O-Final column-existence guard wraps the CREATE INDEX so the
-- migration is safe on any environment where the underlying columns might
-- not exist (legacy / stripped clusters).

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='redaction_policies'
       AND column_name='team_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='redaction_policies'
       AND column_name='name'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "redaction_policies_team_id_name_key" ON "redaction_policies" ("team_id", "name")';
  END IF;
END $$;

COMMIT;
