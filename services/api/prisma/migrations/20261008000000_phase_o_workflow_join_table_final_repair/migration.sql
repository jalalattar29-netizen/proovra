-- Phase O — Final additive repair for the last CRITICAL table.
--
-- ============================================================================
-- ROOT CAUSE
-- ============================================================================
-- Live audit after applying 20261006000000 (Phase O-Final) and
-- 20261007000000 (Phase O live-schema-compatibility-repair) shows
-- ONLY 5 remaining CRITICAL findings, all on the
-- `evidence_workflow_instance_evidence` join table:
--
--   1. MISSING_COLUMN  id uuid
--   2. NAMING_DRIFT   `workflowInstanceId` → expected `workflow_instance_id`
--   3. NAMING_DRIFT   `evidenceId`         → expected `evidence_id`
--   4. MISSING_COLUMN  step_instance_id uuid (nullable in Prisma)
--   5. NAMING_DRIFT   `createdAt`          → expected `created_at`
--
-- This migration closes those 5 CRITICAL findings AND ONLY those.
-- After apply, `full-production-schema-audit.mjs` must report
-- CRITICAL: 0.
--
-- ============================================================================
-- HARD RULES (contract-asserted by
-- `services/api/test/phase-o-workflow-join-final-repair.test.ts`)
-- ============================================================================
-- * ADDITIVE-ONLY. No DROP / RENAME / DELETE / TRUNCATE / SET NOT NULL.
-- * NO PRIMARY KEY added in this phase. Adding a PK to a populated
--   table requires verifying there are no duplicates / NULLs first.
--   The operator can author a follow-up promotion migration AFTER:
--     (a) confirming `id` is non-NULL on every row;
--     (b) confirming `(workflow_instance_id, evidence_id)` is unique;
--     (c) authoring `ALTER TABLE ... ADD PRIMARY KEY ("id")` as a
--         separate, reviewed change.
-- * NO UNIQUE INDEX added. The Prisma model declares
--   `@@unique([workflowInstanceId, evidenceId])` but production may
--   carry duplicate rows from the legacy camelCase shape. Adding the
--   unique index now risks an error mid-migration. Operator verifies
--   uniqueness BEFORE the unique index is created in a follow-up.
-- * IDEMPOTENT. Every ADD COLUMN uses IF NOT EXISTS. Every UPDATE
--   has `WHERE target IS NULL ...` so re-runs are no-ops. Every
--   CREATE INDEX uses IF NOT EXISTS inside a column-existence DO
--   block.
-- * GUARDED. Every backfill UPDATE runs inside a DO block that
--   first verifies the SOURCE column exists in
--   `information_schema.columns`. Backfills are safe on databases
--   where the legacy camelCase column has been removed OR never
--   existed.
-- * BACKFILL-DETERMINISTIC:
--     id                   ← gen_random_uuid()    (only when NULL)
--     workflow_instance_id ← workflowInstanceId   (1:1 semantic)
--     evidence_id          ← evidenceId            (1:1 semantic)
--     created_at           ← createdAt             (1:1 semantic)
--   `step_instance_id` has no source column in the legacy schema
--   (it was introduced in Phase 22 after the camelCase shape was
--   already in production); it is added NULLABLE and Prisma marks
--   the field optional, so no backfill is required.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Add every Prisma-required column as NULLABLE.
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "evidence_workflow_instance_evidence"
  ADD COLUMN IF NOT EXISTS "id"                   UUID,
  ADD COLUMN IF NOT EXISTS "workflow_instance_id" UUID,
  ADD COLUMN IF NOT EXISTS "evidence_id"          UUID,
  ADD COLUMN IF NOT EXISTS "step_instance_id"     UUID,
  ADD COLUMN IF NOT EXISTS "created_at"           TIMESTAMPTZ(6);

-- ---------------------------------------------------------------------------
-- 2. Defaults so future Prisma INSERTs produce non-NULL rows even
--    when the client does not pass the field explicitly. Prisma's
--    `@default(dbgenerated("gen_random_uuid()"))` and `@default(now())`
--    are honoured at INSERT time via these DEFAULTs.
--
--    SET DEFAULT is additive — affects future inserts only; existing
--    rows are untouched. (Existing rows are populated by the
--    backfill below.)
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "evidence_workflow_instance_evidence"
  ALTER COLUMN "id"         SET DEFAULT gen_random_uuid(),
  ALTER COLUMN "created_at" SET DEFAULT NOW();

-- ---------------------------------------------------------------------------
-- 3. Backfill `id` for existing rows. Idempotent: only fills rows
--    where `id` is still NULL. Uses `gen_random_uuid()` per Prisma's
--    `@default(dbgenerated("gen_random_uuid()"))` declaration.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public'
       AND table_name='evidence_workflow_instance_evidence'
       AND column_name='id'
  ) THEN
    EXECUTE $upd$
      UPDATE "evidence_workflow_instance_evidence"
         SET "id" = gen_random_uuid()
       WHERE "id" IS NULL
    $upd$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Deterministic backfill: workflow_instance_id ← workflowInstanceId.
--    Source column existence is verified before the UPDATE runs.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public'
       AND table_name='evidence_workflow_instance_evidence'
       AND column_name='workflowInstanceId'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public'
       AND table_name='evidence_workflow_instance_evidence'
       AND column_name='workflow_instance_id'
  ) THEN
    EXECUTE $upd$
      UPDATE "evidence_workflow_instance_evidence"
         SET "workflow_instance_id" = "workflowInstanceId"
       WHERE "workflow_instance_id" IS NULL
         AND "workflowInstanceId"    IS NOT NULL
    $upd$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Deterministic backfill: evidence_id ← evidenceId.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public'
       AND table_name='evidence_workflow_instance_evidence'
       AND column_name='evidenceId'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public'
       AND table_name='evidence_workflow_instance_evidence'
       AND column_name='evidence_id'
  ) THEN
    EXECUTE $upd$
      UPDATE "evidence_workflow_instance_evidence"
         SET "evidence_id" = "evidenceId"
       WHERE "evidence_id" IS NULL
         AND "evidenceId"   IS NOT NULL
    $upd$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6. Deterministic backfill: created_at ← createdAt.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public'
       AND table_name='evidence_workflow_instance_evidence'
       AND column_name='createdAt'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public'
       AND table_name='evidence_workflow_instance_evidence'
       AND column_name='created_at'
  ) THEN
    EXECUTE $upd$
      UPDATE "evidence_workflow_instance_evidence"
         SET "created_at" = "createdAt"
       WHERE "created_at" IS NULL
         AND "createdAt"   IS NOT NULL
    $upd$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 7. Non-unique secondary indexes — Phase O-Final guarded-CREATE pattern.
--    The unique index on (workflow_instance_id, evidence_id) is
--    DEFERRED to a follow-up migration after the operator verifies
--    no duplicates exist (production may have legacy duplicates from
--    the camelCase shape).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public'
       AND table_name='evidence_workflow_instance_evidence'
       AND column_name='evidence_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "evidence_workflow_instance_evidence_evidence_id_idx"
               ON "evidence_workflow_instance_evidence" ("evidence_id")';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public'
       AND table_name='evidence_workflow_instance_evidence'
       AND column_name='step_instance_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "evidence_workflow_instance_evidence_step_instance_id_idx"
               ON "evidence_workflow_instance_evidence" ("step_instance_id")';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- End of migration. PK promotion + unique index are DEFERRED.
-- See `docs/operations/live-schema-compatibility-repair.md` for the
-- follow-up checklist the operator must run before authoring the
-- promotion migration.
-- ---------------------------------------------------------------------------
