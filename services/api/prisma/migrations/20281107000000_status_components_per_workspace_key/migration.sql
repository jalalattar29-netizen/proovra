-- =============================================================================
-- 2026-11-01 — RT-016: status components are unique per workspace, not globally.
--
-- REPAIR / SAFE_TO_APPLY_NOW, no backfill. No row is touched.
--
-- 20270101000000_phase_r3_model_catchup added status_components_key_key,
-- UNIQUE ("key"). The schema declares @@unique([teamId, key]), and the seven
-- component keys are the same for every workspace, so the first workspace to
-- load the status page held every key and all others failed with P2002.
--
-- Order matters. The per-workspace key is confirmed first, so the table is never
-- without uniqueness. On a database that holds the global constraint, (team_id,
-- key) cannot contain a duplicate, so creating the index cannot fail on data.
-- A database that never held the constraint is left unchanged. Safe to rerun.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'status_components'
       AND i.indisunique
       AND i.indisvalid
       AND i.indpred IS NULL
       AND (
         SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
       ) = ARRAY['team_id', 'key']
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX "status_components_team_key_uniq" ON "status_components" ("team_id", "key")';
  END IF;
END $$;

ALTER TABLE "status_components" DROP CONSTRAINT IF EXISTS "status_components_key_key";
