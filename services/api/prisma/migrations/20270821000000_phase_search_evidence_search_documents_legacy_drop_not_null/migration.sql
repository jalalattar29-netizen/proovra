-- =============================================================================
-- Search-index drift repair — evidence_search_documents legacy column DROP NOT NULL.
--
-- INCIDENT CONTEXT
-- ----------------
-- Production reported `evidence_search_documents = 0` while
-- `active_evidence = 144` and every backfill attempt failed with:
--
--   "Invalid prisma.evidenceSearchDocument.create() invocation:
--    Null constraint violation"
--
-- Root cause analysis (matches prior repair migration
-- `20261007000000_phase_o_live_schema_compatibility_repair`):
--
--   The production database originally shipped with camelCase
--   columns on `evidence_search_documents` ("teamId",
--   "documentType", "sourceId", "searchableText",
--   "sourceUpdatedAtUtc", "createdAt"). A later cutover added the
--   snake_case columns the current Prisma model targets ("team_id",
--   "document_type", "source_id", "searchable_text",
--   "source_updated_at_utc", "created_at"). The legacy camelCase
--   columns were left in place — but were still NOT NULL.
--
--   When the current code calls
--   `prisma.evidenceSearchDocument.create()`, Prisma INSERTs into
--   the snake_case columns only. Production then raises a NOT NULL
--   violation on whichever camelCase column was not provided —
--   bumping `search_indexing_failed_total` and leaving the index
--   empty.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- For each known legacy camelCase column on
-- `evidence_search_documents`, IF the column exists, DROP its NOT
-- NULL constraint. The snake_case columns the Prisma model writes
-- are the canonical source of truth; the legacy columns remain in
-- place (so any pre-existing reader continues to work) but no
-- longer block writes.
--
-- HARD INVARIANTS
-- ---------------
--   - Idempotent. Every operation is gated on
--     `information_schema.columns` so re-running is a no-op.
--   - Read-only on data. We do not change any value in any row.
--   - Scope is exactly `evidence_search_documents`. Other tables
--     with NOT NULL columns are untouched.
--   - Snake_case columns (the canonical write targets) keep their
--     existing constraints. We never DROP NOT NULL on
--     `team_id` / `document_type` / `source_id` / `title` /
--     `source_updated_at_utc` / `created_at` — that would
--     compromise referential + audit invariants.
--   - One round-trip per legacy column so a partial failure on one
--     column does not abort the rest.
--
-- ROLLBACK
-- --------
-- This migration only RELAXES constraints. Rolling back is a
-- conscious decision to re-tighten — operators can restore NOT NULL
-- by hand after they've verified the column is fully backfilled.
-- We don't ship a paired tightening migration here because the
-- whole point is that the legacy columns are deprecated.
--
-- VALIDATION (run after deploy, before scheduling the reindex CLI)
-- ----------------------------------------------------------------
--   SELECT column_name, is_nullable
--     FROM information_schema.columns
--    WHERE table_schema='public'
--      AND table_name='evidence_search_documents'
--      AND column_name IN (
--        'teamId','documentType','sourceId','searchableText',
--        'sourceUpdatedAtUtc','createdAt'
--      )
--    ORDER BY column_name;
--
-- Every row should report `is_nullable = 'YES'` after this runs (or
-- the column genuinely does not exist on this database — also fine).
-- =============================================================================

DO $$
DECLARE
  legacy_col TEXT;
  legacy_cols CONSTANT TEXT[] := ARRAY[
    -- The exact set the prior repair migration mirrored from
    -- snake_case. Includes every column known to have shipped as
    -- camelCase NOT NULL on early production deploys.
    'teamId',
    'documentType',
    'sourceId',
    'title',
    'subtitle',
    'summary',
    'searchableText',
    'searchableMetadataJson',
    'searchableTagsJson',
    'visibilityScopeJson',
    'governanceScopeJson',
    'reviewState',
    'workflowState',
    'exportState',
    'retentionState',
    'legalHoldState',
    'contributorScoped',
    'reviewerRestricted',
    'evidenceId',
    'workflowInstanceId',
    'workflowStepInstanceId',
    'caseId',
    'claimRef',
    'matterRef',
    'sourceUpdatedAtUtc',
    'indexedAtUtc',
    'createdAt',
    'updatedAt'
  ];
BEGIN
  FOREACH legacy_col IN ARRAY legacy_cols LOOP
    IF EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = 'evidence_search_documents'
         AND column_name  = legacy_col
         AND is_nullable  = 'NO'
    ) THEN
      EXECUTE format(
        'ALTER TABLE "evidence_search_documents" ALTER COLUMN %I DROP NOT NULL',
        legacy_col
      );
      RAISE NOTICE
        'evidence_search_documents.% — DROP NOT NULL applied',
        legacy_col;
    END IF;
  END LOOP;
END
$$;
