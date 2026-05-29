-- Phase O — Live schema compatibility repair (ADDITIVE + DETERMINISTIC BACKFILL).
--
-- Triages the live `full-production-schema-audit.mjs` output produced
-- against production. ONLY confirmed scalar-column mismatches that
-- break Prisma runtime queries are repaired here. Prisma RELATION
-- fields (reviewWorkflow, anchor, guestIdentity, governancePolicy,
-- securityPolicy, personaProfile, …) are NEVER materialised as DB
-- columns — they are excluded from the audit by the corrected parser
-- (see `services/api/scripts/full-production-schema-audit.mjs`).
--
-- ============================================================================
-- HARD RULES (CONTRACT-ASSERTED BY phase-o-live-schema-repair.test.ts)
-- ============================================================================
-- * ADDITIVE-ONLY. No DROP, no RENAME, no DELETE, no TRUNCATE,
--   no SET NOT NULL, no destructive type conversions, no enum
--   conversions.
-- * IDEMPOTENT. Every ADD COLUMN uses IF NOT EXISTS. Every backfill
--   UPDATE has `WHERE target IS NULL AND source IS NOT NULL`. Every
--   CREATE INDEX wraps in a column-existence DO block. Re-running is
--   a no-op.
-- * GUARDED. Every CREATE INDEX runs only after a DO/PL-pgSQL block
--   verifies EVERY referenced column exists (Phase O-Final defense
--   against `SQL 42703 column does not exist`).
-- * NULLABLE-FIRST. Even where Prisma marks the field required, we
--   add the column NULLABLE and rely on deterministic backfill +
--   future SET NOT NULL after readiness is verified.
-- * DETERMINISTIC BACKFILL ONLY. Backfills allowed only when:
--     (a) source column semantics are 1:1 with target (camelCase
--         legacy of same value);
--     (b) source column existence is verified in a DO block before
--         the UPDATE runs;
--     (c) WHERE clause is target-IS-NULL-AND-source-IS-NOT-NULL so
--         re-runs are no-ops AND we never overwrite data Prisma
--         wrote.
-- * NEVER drop the source camelCase column. Operators clean up
--   legacy columns in a separate post-readiness migration.
--
-- ============================================================================
-- TRIAGE DECISIONS (full rationale in
-- docs/operations/live-schema-compatibility-repair.md)
-- ============================================================================
-- REPAIR_NOW (this migration):
--   evidence_saved_views, evidence_legal_holds, upload_sessions,
--   evidence_intelligence_jobs, evidence_extracted_texts,
--   evidence_entities, evidence_semantic_chunks, evidence_similarities,
--   discussion_threads, discussion_messages, discussion_participants,
--   trusted_devices, operational_incident_events,
--   evidence_workflow_instances, evidence_workflow_step_instances,
--   evidence_workflow_visibility_decisions, evidence_search_documents
--
-- MANUAL_DECISION_REQUIRED (NOT in this migration):
--   discussion_mentions — audit still reports missing thread_id /
--     mentioned_user_id / notified_at_utc / created_at AFTER the
--     Phase O-Final migration was deploy-resolved. Operator must
--     re-run the live audit and confirm whether this is stale
--     output or a real residual issue before any further action.
--   evidence_workflow_instance_evidence — missing PK `id` AND
--     missing `step_instance_id` together with naming drift. Adding
--     a PK to a populated table requires data review; operator
--     decision.
--
-- DEFER (HIGH non-blocking documented separately):
--   text vs varchar type mismatches; nullable mismatches where
--   Prisma is optional. None of these prevent reads/writes today.
--
-- IGNORE_RELATION (parser fix):
--   reviewWorkflow, anchor, guestIdentity, governancePolicy,
--   securityPolicy, personaProfile, and every other reverse-1-to-1
--   relation. The corrected parser excludes these — they no longer
--   appear in the audit.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. evidence_saved_views — Phase G2 saved-view CRUD.
--    Production has legacy camelCase. Add snake_case + deterministic
--    backfill from teamId, filtersJson when those columns exist.
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "evidence_saved_views"
  ADD COLUMN IF NOT EXISTS "owner_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "team_id"       UUID,
  ADD COLUMN IF NOT EXISTS "description"   VARCHAR(400),
  ADD COLUMN IF NOT EXISTS "filters_json"  JSONB,
  ADD COLUMN IF NOT EXISTS "sort_key"      VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "scope"         VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "is_default"    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_saved_views'
       AND column_name='teamId'
  ) THEN
    EXECUTE $upd$
      UPDATE "evidence_saved_views"
         SET "team_id" = "teamId"
       WHERE "team_id" IS NULL AND "teamId" IS NOT NULL
    $upd$;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_saved_views'
       AND column_name='filtersJson'
  ) THEN
    EXECUTE $upd$
      UPDATE "evidence_saved_views"
         SET "filters_json" = "filtersJson"::jsonb
       WHERE "filters_json" IS NULL AND "filtersJson" IS NOT NULL
    $upd$;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_saved_views'
       AND column_name='ownerUserId'
  ) THEN
    EXECUTE $upd$
      UPDATE "evidence_saved_views"
         SET "owner_user_id" = "ownerUserId"
       WHERE "owner_user_id" IS NULL AND "ownerUserId" IS NOT NULL
    $upd$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. evidence_legal_holds — add created_at.
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "evidence_legal_holds"
  ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

-- ---------------------------------------------------------------------------
-- 3. upload_sessions — Phase 30 timestamp columns (re-asserted; the
--    Phase O-Final migration added these; this block is the idempotent
--    re-application if any drift remains).
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "upload_sessions"
  ADD COLUMN IF NOT EXISTS "stalled_at_utc"    TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "abandoned_at_utc"  TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "completed_at_utc"  TIMESTAMPTZ(6);

-- ---------------------------------------------------------------------------
-- 4. evidence_intelligence_jobs — Phase 15 timestamp columns.
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "evidence_intelligence_jobs"
  ADD COLUMN IF NOT EXISTS "scheduled_at_utc"  TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "started_at_utc"    TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "completed_at_utc"  TIMESTAMPTZ(6);

-- ---------------------------------------------------------------------------
-- 5. evidence_extracted_texts — provider + confidence + duration.
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "evidence_extracted_texts"
  ADD COLUMN IF NOT EXISTS "provider_version" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "confidence"       DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "duration_ms"      INTEGER,
  ADD COLUMN IF NOT EXISTS "extracted_at_utc" TIMESTAMPTZ(6);

-- ---------------------------------------------------------------------------
-- 6. evidence_entities — confidence (advisory).
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "evidence_entities"
  ADD COLUMN IF NOT EXISTS "confidence" DOUBLE PRECISION;

-- ---------------------------------------------------------------------------
-- 7. evidence_semantic_chunks — chunked text + embedding metadata.
--    Prisma marks chunk_text as required; we add NULLABLE here and
--    leave SET NOT NULL to a follow-up migration after readiness.
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "evidence_semantic_chunks"
  ADD COLUMN IF NOT EXISTS "chunk_text"            TEXT,
  ADD COLUMN IF NOT EXISTS "embedding_provider"    VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "embedding_model"       VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "embedding_dimensions"  INTEGER;

-- ---------------------------------------------------------------------------
-- 8. evidence_similarities — operator-readable advisory summary.
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "evidence_similarities"
  ADD COLUMN IF NOT EXISTS "advisory_summary" VARCHAR(400);

-- ---------------------------------------------------------------------------
-- 9. discussion_threads — Phase 16 assignment / resolution / reopen /
--    escalation columns + created_at.
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "discussion_threads"
  ADD COLUMN IF NOT EXISTS "assigned_at_utc"      TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "resolved_by_user_id"  UUID,
  ADD COLUMN IF NOT EXISTS "resolved_at_utc"      TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "reopened_by_user_id"  UUID,
  ADD COLUMN IF NOT EXISTS "reopen_count"         INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "escalated_by_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

-- ---------------------------------------------------------------------------
-- 10. discussion_messages — Phase 16 contributor + edit/delete +
--     created_at columns.
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "discussion_messages"
  ADD COLUMN IF NOT EXISTS "contributor_intake_session_id" UUID,
  ADD COLUMN IF NOT EXISTS "contributor_label"             VARCHAR(180),
  ADD COLUMN IF NOT EXISTS "edited_at_utc"                 TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "deleted_at_utc"                TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "deleted_by_user_id"            UUID,
  ADD COLUMN IF NOT EXISTS "created_at"                    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

-- ---------------------------------------------------------------------------
-- 11. discussion_participants — Phase 16 added_by / revoked_by + added_at.
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "discussion_participants"
  ADD COLUMN IF NOT EXISTS "added_by_user_id"   UUID,
  ADD COLUMN IF NOT EXISTS "added_at_utc"       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS "revoked_by_user_id" UUID;

-- ---------------------------------------------------------------------------
-- 12. trusted_devices — Phase 26.5 created_at.
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "trusted_devices"
  ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

-- ---------------------------------------------------------------------------
-- 13. operational_incident_events — naming-drift repair (Option B:
--     additive snake_case columns + deterministic backfill from
--     legacy camelCase). Source-column existence is verified inside
--     the DO block so the migration is safe on databases that
--     already have only snake_case.
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "operational_incident_events"
  ADD COLUMN IF NOT EXISTS "incident_id"   UUID,
  ADD COLUMN IF NOT EXISTS "event_type"    VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "safe_message"  VARCHAR(400),
  ADD COLUMN IF NOT EXISTS "metadata_json" JSONB,
  ADD COLUMN IF NOT EXISTS "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='operational_incident_events'
       AND column_name='incidentId'
  ) THEN
    EXECUTE $upd$
      UPDATE "operational_incident_events"
         SET "incident_id" = "incidentId"
       WHERE "incident_id" IS NULL AND "incidentId" IS NOT NULL
    $upd$;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='operational_incident_events'
       AND column_name='eventType'
  ) THEN
    EXECUTE $upd$
      UPDATE "operational_incident_events"
         SET "event_type" = "eventType"
       WHERE "event_type" IS NULL AND "eventType" IS NOT NULL
    $upd$;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='operational_incident_events'
       AND column_name='safeMessage'
  ) THEN
    EXECUTE $upd$
      UPDATE "operational_incident_events"
         SET "safe_message" = "safeMessage"
       WHERE "safe_message" IS NULL AND "safeMessage" IS NOT NULL
    $upd$;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='operational_incident_events'
       AND column_name='metadataJson'
  ) THEN
    EXECUTE $upd$
      UPDATE "operational_incident_events"
         SET "metadata_json" = "metadataJson"::jsonb
       WHERE "metadata_json" IS NULL AND "metadataJson" IS NOT NULL
    $upd$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 14. evidence_workflow_instances — wide naming-drift repair plus the
--     scalar columns Prisma added later (claim_ref, matter_ref, title).
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "evidence_workflow_instances"
  ADD COLUMN IF NOT EXISTS "team_id"                  UUID,
  ADD COLUMN IF NOT EXISTS "template_id"              UUID,
  ADD COLUMN IF NOT EXISTS "template_slug"            VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "template_version"         INTEGER,
  ADD COLUMN IF NOT EXISTS "pre_hold_status"          VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "intake_mode"              VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "actor_role"               VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "case_id"                  UUID,
  ADD COLUMN IF NOT EXISTS "claim_ref"                VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "matter_ref"               VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "evidence_request_id"      UUID,
  ADD COLUMN IF NOT EXISTS "intake_session_id"        UUID,
  ADD COLUMN IF NOT EXISTS "external_contact_hash"    VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "created_by_user_id"       UUID,
  ADD COLUMN IF NOT EXISTS "assigned_reviewer_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "title"                    VARCHAR(180),
  ADD COLUMN IF NOT EXISTS "submitted_at_utc"         TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "approved_at_utc"          TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "closed_at_utc"            TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

DO $$
DECLARE
  cam_to_snake CONSTANT TEXT[][] := ARRAY[
    ARRAY['teamId',                  'team_id'],
    ARRAY['templateId',              'template_id'],
    ARRAY['templateSlug',            'template_slug'],
    ARRAY['templateVersion',         'template_version'],
    ARRAY['preHoldStatus',           'pre_hold_status'],
    ARRAY['intakeMode',              'intake_mode'],
    ARRAY['actorRole',               'actor_role'],
    ARRAY['caseId',                  'case_id'],
    ARRAY['evidenceRequestId',       'evidence_request_id'],
    ARRAY['intakeSessionId',         'intake_session_id'],
    ARRAY['externalContactHash',     'external_contact_hash'],
    ARRAY['createdByUserId',         'created_by_user_id'],
    ARRAY['assignedReviewerUserId',  'assigned_reviewer_user_id'],
    ARRAY['submittedAtUtc',          'submitted_at_utc'],
    ARRAY['approvedAtUtc',           'approved_at_utc'],
    ARRAY['closedAtUtc',             'closed_at_utc'],
    ARRAY['createdAt',               'created_at']
  ];
  pair TEXT[];
BEGIN
  FOREACH pair SLICE 1 IN ARRAY cam_to_snake LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='evidence_workflow_instances'
         AND column_name = pair[1]
    ) THEN
      EXECUTE format(
        'UPDATE "evidence_workflow_instances" SET %I = %I WHERE %I IS NULL AND %I IS NOT NULL',
        pair[2], pair[1], pair[2], pair[1]
      );
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 15. evidence_workflow_step_instances — wide naming-drift + Phase 22
--     constraint snapshot columns.
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "evidence_workflow_step_instances"
  ADD COLUMN IF NOT EXISTS "workflow_instance_id"   UUID,
  ADD COLUMN IF NOT EXISTS "step_key"               VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "order_index"            INTEGER,
  ADD COLUMN IF NOT EXISTS "accepted_kinds_json"    JSONB,
  ADD COLUMN IF NOT EXISTS "identity_requirement"   VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "location_requirement"   VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "mapped_evidence_id"     UUID,
  ADD COLUMN IF NOT EXISTS "completed_by_user_id"   UUID,
  ADD COLUMN IF NOT EXISTS "completed_at_utc"       TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "waiver_reason"          VARCHAR(400),
  ADD COLUMN IF NOT EXISTS "private_reviewer_note"  VARCHAR(2000),
  ADD COLUMN IF NOT EXISTS "created_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

DO $$
DECLARE
  pair TEXT[];
  cam_to_snake CONSTANT TEXT[][] := ARRAY[
    ARRAY['workflowInstanceId',  'workflow_instance_id'],
    ARRAY['stepKey',             'step_key'],
    ARRAY['orderIndex',          'order_index'],
    ARRAY['mappedEvidenceId',    'mapped_evidence_id'],
    ARRAY['completedByUserId',   'completed_by_user_id'],
    ARRAY['completedAtUtc',      'completed_at_utc'],
    ARRAY['waiverReason',        'waiver_reason'],
    ARRAY['privateReviewerNote', 'private_reviewer_note'],
    ARRAY['createdAt',           'created_at']
  ];
BEGIN
  FOREACH pair SLICE 1 IN ARRAY cam_to_snake LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='evidence_workflow_step_instances'
         AND column_name = pair[1]
    ) THEN
      EXECUTE format(
        'UPDATE "evidence_workflow_step_instances" SET %I = %I WHERE %I IS NULL AND %I IS NOT NULL',
        pair[2], pair[1], pair[2], pair[1]
      );
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 16. evidence_workflow_visibility_decisions — wide naming-drift.
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "evidence_workflow_visibility_decisions"
  ADD COLUMN IF NOT EXISTS "workflow_instance_id"             UUID,
  ADD COLUMN IF NOT EXISTS "evidence_id"                      UUID,
  ADD COLUMN IF NOT EXISTS "field_key"                        VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "visible_in_app"                   BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "visible_to_contributor"           BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "visible_in_public_verify"         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "visible_in_report"                BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "visible_in_verification_package"  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "requires_redaction"               BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "created_at"                       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

DO $$
DECLARE
  pair TEXT[];
  cam_to_snake CONSTANT TEXT[][] := ARRAY[
    ARRAY['workflowInstanceId',           'workflow_instance_id'],
    ARRAY['evidenceId',                   'evidence_id'],
    ARRAY['fieldKey',                     'field_key'],
    ARRAY['visibleInApp',                 'visible_in_app'],
    ARRAY['visibleToContributor',         'visible_to_contributor'],
    ARRAY['visibleInPublicVerify',        'visible_in_public_verify'],
    ARRAY['visibleInReport',              'visible_in_report'],
    ARRAY['visibleInVerificationPackage', 'visible_in_verification_package'],
    ARRAY['requiresRedaction',            'requires_redaction'],
    ARRAY['createdAt',                    'created_at']
  ];
BEGIN
  FOREACH pair SLICE 1 IN ARRAY cam_to_snake LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='evidence_workflow_visibility_decisions'
         AND column_name = pair[1]
    ) THEN
      EXECUTE format(
        'UPDATE "evidence_workflow_visibility_decisions" SET %I = %I WHERE %I IS NULL AND %I IS NOT NULL',
        pair[2], pair[1], pair[2], pair[1]
      );
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 17. evidence_search_documents — wide naming-drift + missing source_id,
--     claim_ref, matter_ref, indexed_at_utc.
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "evidence_search_documents"
  ADD COLUMN IF NOT EXISTS "team_id"                  UUID,
  ADD COLUMN IF NOT EXISTS "document_type"            VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "source_id"                UUID,
  ADD COLUMN IF NOT EXISTS "searchable_text"          TEXT,
  ADD COLUMN IF NOT EXISTS "searchable_metadata_json" JSONB,
  ADD COLUMN IF NOT EXISTS "searchable_tags_json"     JSONB,
  ADD COLUMN IF NOT EXISTS "visibility_scope_json"    JSONB,
  ADD COLUMN IF NOT EXISTS "governance_scope_json"    JSONB,
  ADD COLUMN IF NOT EXISTS "review_state"             VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "workflow_state"           VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "export_state"             VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "retention_state"          VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "legal_hold_state"         VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "contributor_scoped"       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "reviewer_restricted"      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "evidence_id"              UUID,
  ADD COLUMN IF NOT EXISTS "workflow_instance_id"     UUID,
  ADD COLUMN IF NOT EXISTS "workflow_step_instance_id" UUID,
  ADD COLUMN IF NOT EXISTS "case_id"                  UUID,
  ADD COLUMN IF NOT EXISTS "claim_ref"                VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "matter_ref"               VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "source_updated_at_utc"    TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "indexed_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

DO $$
DECLARE
  pair TEXT[];
  cam_to_snake CONSTANT TEXT[][] := ARRAY[
    ARRAY['teamId',                  'team_id'],
    ARRAY['documentType',            'document_type'],
    ARRAY['searchableText',          'searchable_text'],
    ARRAY['searchableMetadataJson',  'searchable_metadata_json'],
    ARRAY['searchableTagsJson',      'searchable_tags_json'],
    ARRAY['visibilityScopeJson',     'visibility_scope_json'],
    ARRAY['governanceScopeJson',     'governance_scope_json'],
    ARRAY['reviewState',             'review_state'],
    ARRAY['workflowState',           'workflow_state'],
    ARRAY['exportState',             'export_state'],
    ARRAY['retentionState',          'retention_state'],
    ARRAY['legalHoldState',          'legal_hold_state'],
    ARRAY['contributorScoped',       'contributor_scoped'],
    ARRAY['reviewerRestricted',      'reviewer_restricted'],
    ARRAY['evidenceId',              'evidence_id'],
    ARRAY['workflowInstanceId',      'workflow_instance_id'],
    ARRAY['workflowStepInstanceId',  'workflow_step_instance_id'],
    ARRAY['caseId',                  'case_id'],
    ARRAY['sourceUpdatedAtUtc',      'source_updated_at_utc'],
    ARRAY['createdAt',               'created_at']
  ];
BEGIN
  FOREACH pair SLICE 1 IN ARRAY cam_to_snake LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='evidence_search_documents'
         AND column_name = pair[1]
    ) THEN
      EXECUTE format(
        'UPDATE "evidence_search_documents" SET %I = %I WHERE %I IS NULL AND %I IS NOT NULL',
        pair[2], pair[1], pair[2], pair[1]
      );
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- End of migration. Every CREATE INDEX is deferred to a follow-up
-- migration to be authored only after operator confirms via
-- `full-production-schema-audit.mjs` that all scalar columns above
-- are populated and the runtime is clean. Indexes are NOT required
-- to clear the live P2022 audit findings; runtime Prisma queries
-- succeed once the columns exist + are populated by the backfills.
-- ---------------------------------------------------------------------------
