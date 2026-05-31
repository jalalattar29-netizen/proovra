-- Phase R7 — RedactionPolicy workspace-scoped name uniqueness — HARDENED.
-- Additive (CREATE UNIQUE INDEX IF NOT EXISTS); no DROP, no UPDATE, no SET NOT NULL.
--
-- Hardening rules applied:
--   * Guard CREATE UNIQUE INDEX by pg_tables + every indexed column existence.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='redaction_policies')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='redaction_policies' AND column_name='team_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='redaction_policies' AND column_name='name'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "redaction_policies_team_id_name_key" ON "redaction_policies" ("team_id", "name")';
  END IF;
END $$;

COMMIT;
