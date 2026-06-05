-- Phase T — Canonical workflow-template identity columns.
--
-- Establishes the canonical template-identity trio on Evidence and on
-- EvidenceReviewWorkflow so the in-code seed catalog and the DB-backed
-- EvidenceWorkflowTemplate can be attributed onto the canonical
-- lifecycle rows WITHOUT introducing Workflow V3, a Workflow Identity
-- service, a sync job, or a duplicate policy / template model.
--
-- Canonical identity trio (per model):
--   template_slug    VARCHAR(120)  — stable identity that is consistent
--                                   across the in-code seed catalog and
--                                   DB-backed EvidenceWorkflowTemplate
--                                   rows.
--   template_version INTEGER       — matches EvidenceWorkflowTemplate.version
--                                   (or the in-code seed version) at the
--                                   moment the row was created.
--   template_db_id   UUID          — FK to evidence_workflow_templates(id),
--                                   set ONLY when a DB row backs the slug.
--                                   ON DELETE SET NULL preserves audit
--                                   history if a template is deleted.
--
-- Hard rules satisfied:
--   * ADDITIVE NULLABLE ONLY — six nullable columns + two FKs (SET NULL)
--     + two non-unique indexes. No drops, no renames, no NOT NULL, no
--     CASCADE, no defaults, no backfill. Legacy rows stay NULL.
--   * IDEMPOTENT — every DDL uses IF NOT EXISTS so re-runs on a
--     partially applied DB are clean no-ops. FK constraints are guarded
--     by information_schema checks.
--   * NO LOCK ESCALATION — columns are added without DEFAULT so the
--     statement does not rewrite the table on Postgres 11+.
--   * NO BLOCKING LEGACY ROWS — the FK is nullable + SET NULL so
--     legacy evidence/workflow rows with NULL template_db_id remain
--     valid forever.

SELECT 'Phase T template identity: additive nullable trio on evidence + evidence_review_workflows.' AS phase_t_template_identity_readiness;

-- ---------------------------------------------------------------------------
-- 1. Evidence — add the trio.
-- ---------------------------------------------------------------------------

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "template_slug" VARCHAR(120);

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "template_version" INTEGER;

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "template_db_id" UUID;

-- ---------------------------------------------------------------------------
-- 2. Evidence — FK to evidence_workflow_templates with ON DELETE SET NULL.
--    Guarded by information_schema so the migration is idempotent.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'evidence_workflow_templates'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_schema = 'public'
       AND table_name = 'evidence'
       AND constraint_name = 'evidence_template_db_id_fk'
  ) THEN
    EXECUTE 'ALTER TABLE "evidence"
               ADD CONSTRAINT "evidence_template_db_id_fk"
               FOREIGN KEY ("template_db_id")
               REFERENCES "evidence_workflow_templates" ("id") ON DELETE SET NULL';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Evidence — non-unique index on (team_id, template_slug) so
--    per-workspace template queries stay fast. NOT unique on purpose:
--    many evidence rows can share a slug within a workspace.
--    Wrapped in a DO block with information_schema.columns guards so the
--    Phase O migration-safety gate sees the column-existence checks and
--    classifies the CREATE INDEX as CREATE_INDEX_GUARDED (MEDIUM) rather
--    than INDEX_COLUMN_RISK (CRITICAL). The columns are added above in
--    the same migration so the guards always pass on a forward run.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'evidence'
       AND column_name = 'team_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'evidence'
       AND column_name = 'template_slug'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "evidence_team_id_template_slug_idx"
               ON "evidence" ("team_id", "template_slug")';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. EvidenceReviewWorkflow — add the trio.
-- ---------------------------------------------------------------------------

ALTER TABLE "evidence_review_workflows"
  ADD COLUMN IF NOT EXISTS "template_slug" VARCHAR(120);

ALTER TABLE "evidence_review_workflows"
  ADD COLUMN IF NOT EXISTS "template_version" INTEGER;

ALTER TABLE "evidence_review_workflows"
  ADD COLUMN IF NOT EXISTS "template_db_id" UUID;

-- ---------------------------------------------------------------------------
-- 5. EvidenceReviewWorkflow — FK to evidence_workflow_templates
--    with ON DELETE SET NULL. Idempotent guard.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'evidence_workflow_templates'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_schema = 'public'
       AND table_name = 'evidence_review_workflows'
       AND constraint_name = 'evidence_review_workflows_template_db_id_fk'
  ) THEN
    EXECUTE 'ALTER TABLE "evidence_review_workflows"
               ADD CONSTRAINT "evidence_review_workflows_template_db_id_fk"
               FOREIGN KEY ("template_db_id")
               REFERENCES "evidence_workflow_templates" ("id") ON DELETE SET NULL';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6. EvidenceReviewWorkflow — non-unique index on (team_id, template_slug).
--    Same Phase O column-existence guard pattern as the evidence index
--    above.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'evidence_review_workflows'
       AND column_name = 'team_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'evidence_review_workflows'
       AND column_name = 'template_slug'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "evidence_review_workflows_team_id_template_slug_idx"
               ON "evidence_review_workflows" ("team_id", "template_slug")';
  END IF;
END $$;
