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
-- (team_id, slug) has held since 20261220000000 and stays, so the table is never
-- without uniqueness. A database that never held the constraint is left unchanged.
-- Safe to rerun.
-- =============================================================================

ALTER TABLE "subprocessors" DROP CONSTRAINT IF EXISTS "subprocessors_name_key";
