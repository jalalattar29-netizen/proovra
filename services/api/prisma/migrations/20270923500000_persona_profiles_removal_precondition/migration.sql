-- =============================================================================
-- PHASE 12 POINT 6 — CONTRACT PRECONDITION for
-- `20270924000000_drop_workspace_persona_profiles`.
--
-- RELEASE D ONLY, together with the migration it guards.
--
-- WHY THIS FILE EXISTS AS A SEPARATE MIGRATION
--   `20270924000000_drop_workspace_persona_profiles` issues an unguarded
--   `DROP TABLE IF EXISTS "workspace_persona_profiles" CASCADE`. CASCADE is
--   the hazard: if any object acquired a dependency on that table after the
--   persona feature was retired — a foreign key from another table, a view —
--   CASCADE would silently destroy it too, and the migration would report
--   success. A destructive statement must refuse on the unexpected, not
--   absorb it.
--
--   That migration is TRACKED IN GIT and its bytes are therefore a candidate
--   for having been applied somewhere already; rewriting it would change its
--   Prisma checksum and break `migrate deploy` on any database that carries
--   it. So the guard is added as a preceding migration instead. Migrations
--   apply in lexical order and `prisma migrate deploy` stops at the first
--   failure, so a RAISE here aborts the deployment BEFORE the drop runs and
--   `workspace_persona_profiles` is left completely intact.
--
-- WHAT IT PROVES
--   1. No other table holds a foreign key REFERENCING
--      `workspace_persona_profiles` (nothing would be cascaded away).
--   2. No view depends on it.
--   3. The row count being discarded is reported as a bounded diagnostic, so
--      the deployment log records exactly what was removed.
--
--   The rows themselves are NOT a blocking category: the persona /
--   workflow-personalization / operational-density family was a UX-only
--   feature that never granted a capability, and its physical deletion was
--   product-approved (docs/operations/audit-closure-ledger.md). Refusing on a
--   non-empty table would make the approved removal impossible rather than
--   safe.
--
-- Non-destructive: this file measures and RAISEs. It changes nothing.
-- =============================================================================

DO $$
DECLARE
  dependent_fks int;
  dependent_views int;
  doomed_rows bigint;
  fk_list text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'workspace_persona_profiles'
  ) THEN
    RAISE NOTICE 'persona-profiles removal precondition: table already absent — nothing to guard.';
    RETURN;
  END IF;

  SELECT count(*), coalesce(string_agg(format('%s.%s', src.relname, c.conname), ', '), '')
    INTO dependent_fks, fk_list
  FROM pg_constraint c
  JOIN pg_class src ON src.oid = c.conrelid
  WHERE c.contype = 'f'
    AND c.confrelid = 'public.workspace_persona_profiles'::regclass
    AND c.conrelid <> 'public.workspace_persona_profiles'::regclass;

  IF dependent_fks > 0 THEN
    RAISE EXCEPTION
      'REFUSING to allow the workspace_persona_profiles drop: % foreign key(s) still reference it (%). The pending DROP ... CASCADE would destroy those rows silently. Resolve the dependency first.',
      dependent_fks, fk_list;
  END IF;

  SELECT count(*) INTO dependent_views
  FROM pg_depend d
  JOIN pg_rewrite r ON r.oid = d.objid
  JOIN pg_class v ON v.oid = r.ev_class AND v.relkind IN ('v', 'm')
  WHERE d.refobjid = 'public.workspace_persona_profiles'::regclass
    AND v.oid <> 'public.workspace_persona_profiles'::regclass;

  IF dependent_views > 0 THEN
    RAISE EXCEPTION
      'REFUSING to allow the workspace_persona_profiles drop: % view(s)/materialized view(s) depend on it and would be cascaded away.',
      dependent_views;
  END IF;

  EXECUTE 'SELECT count(*) FROM public.workspace_persona_profiles' INTO doomed_rows;
  RAISE NOTICE 'persona-profiles removal precondition: 0 dependent foreign keys, 0 dependent views. % retired UX row(s) will be discarded by 20270924000000_drop_workspace_persona_profiles.', doomed_rows;
END
$$;
