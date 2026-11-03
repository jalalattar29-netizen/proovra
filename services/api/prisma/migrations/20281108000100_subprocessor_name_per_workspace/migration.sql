-- =============================================================================
-- 2026-11-03 — subprocessors are unique per workspace, not globally by name.
--
-- REPAIR / SAFE_TO_APPLY_NOW, no backfill. No row is touched.
--
-- 20270101000000_phase_r3_model_catchup added subprocessors_name_key, UNIQUE
-- ("name"), which the schema never declared, on a table whose rows each belong to
-- one workspace. The schema's rule is @@unique([teamId, slug]). The vendors seeded
-- for a workspace have the same names everywhere, so every workspace after the
-- first answered 500 on POST /v1/trust/subprocessors/seed, and a name registered
-- by one tenant was refused to all others. RT-016 repaired the same constraint
-- class on status_components; articles were repaired by 20270103000000.
--
-- Order matters, as in RT-016. The per-workspace key is confirmed first, so the
-- table is never without uniqueness. On a database that holds the global
-- constraint, (team_id, slug) cannot contain a duplicate, so creating the index
-- cannot fail on data. A database that never held the constraint is left
-- unchanged. Safe to rerun.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'subprocessors'
       AND i.indisunique
       AND i.indisvalid
       AND i.indpred IS NULL
       AND (
         SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
       ) = ARRAY['team_id', 'slug']
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX "subprocessors_team_slug_uniq" ON "subprocessors" ("team_id", "slug")';
  END IF;
END $$;

ALTER TABLE "subprocessors" DROP CONSTRAINT IF EXISTS "subprocessors_name_key";
