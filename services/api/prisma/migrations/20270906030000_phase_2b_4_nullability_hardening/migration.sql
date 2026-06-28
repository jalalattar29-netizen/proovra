-- Phase 2B.4 — nullability hardening
--
-- Live precheck summary:
--   * 64 HIGH nullable-vs-required drifts
--   * every affected column returned NULL count = 0
--
-- Safety rules:
--   * no invented timestamps
--   * no blanket hardening
--   * every SET NOT NULL is guarded and raises on unexpected NULLs

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_saved_views' AND column_name='owner_user_id' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_saved_views" WHERE "owner_user_id" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set evidence_saved_views.owner_user_id NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "evidence_saved_views" ALTER COLUMN "owner_user_id" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_saved_views' AND column_name='filters_json' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_saved_views" WHERE "filters_json" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set evidence_saved_views.filters_json NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "evidence_saved_views" ALTER COLUMN "filters_json" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_saved_views' AND column_name='scope' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_saved_views" WHERE "scope" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set evidence_saved_views.scope NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "evidence_saved_views" ALTER COLUMN "scope" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_saved_views' AND column_name='updated_at' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_saved_views" WHERE "updated_at" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set evidence_saved_views.updated_at NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "evidence_saved_views" ALTER COLUMN "updated_at" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='demo_requests' AND column_name='follow_up_status' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "demo_requests" WHERE "follow_up_status" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set demo_requests.follow_up_status NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "demo_requests" ALTER COLUMN "follow_up_status" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='demo_requests' AND column_name='follow_up_step' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "demo_requests" WHERE "follow_up_step" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set demo_requests.follow_up_step NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "demo_requests" ALTER COLUMN "follow_up_step" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_legal_holds' AND column_name='updated_at' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_legal_holds" WHERE "updated_at" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set evidence_legal_holds.updated_at NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "evidence_legal_holds" ALTER COLUMN "updated_at" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='case_legal_holds' AND column_name='placed_by_user_id' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "case_legal_holds" WHERE "placed_by_user_id" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set case_legal_holds.placed_by_user_id NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "case_legal_holds" ALTER COLUMN "placed_by_user_id" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_extracted_texts' AND column_name='provider' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_extracted_texts" WHERE "provider" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set evidence_extracted_texts.provider NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "evidence_extracted_texts" ALTER COLUMN "provider" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_extracted_texts' AND column_name='updated_at' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_extracted_texts" WHERE "updated_at" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set evidence_extracted_texts.updated_at NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "evidence_extracted_texts" ALTER COLUMN "updated_at" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_semantic_chunks' AND column_name='chunk_text' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_semantic_chunks" WHERE "chunk_text" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set evidence_semantic_chunks.chunk_text NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "evidence_semantic_chunks" ALTER COLUMN "chunk_text" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='discussion_threads' AND column_name='updated_at' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "discussion_threads" WHERE "updated_at" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set discussion_threads.updated_at NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "discussion_threads" ALTER COLUMN "updated_at" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='discussion_mentions' AND column_name='thread_id' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "discussion_mentions" WHERE "thread_id" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set discussion_mentions.thread_id NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "discussion_mentions" ALTER COLUMN "thread_id" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='discussion_mentions' AND column_name='mentioned_user_id' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "discussion_mentions" WHERE "mentioned_user_id" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set discussion_mentions.mentioned_user_id NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "discussion_mentions" ALTER COLUMN "mentioned_user_id" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='discussion_mentions' AND column_name='created_at' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "discussion_mentions" WHERE "created_at" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set discussion_mentions.created_at NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "discussion_mentions" ALTER COLUMN "created_at" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='trusted_devices' AND column_name='updated_at' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "trusted_devices" WHERE "updated_at" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set trusted_devices.updated_at NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "trusted_devices" ALTER COLUMN "updated_at" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='operational_incidents' AND column_name='safe_summary' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "operational_incidents" WHERE "safe_summary" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set operational_incidents.safe_summary NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "operational_incidents" ALTER COLUMN "safe_summary" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='operational_incidents' AND column_name='first_seen_at_utc' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "operational_incidents" WHERE "first_seen_at_utc" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set operational_incidents.first_seen_at_utc NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "operational_incidents" ALTER COLUMN "first_seen_at_utc" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='operational_incidents' AND column_name='last_seen_at_utc' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "operational_incidents" WHERE "last_seen_at_utc" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set operational_incidents.last_seen_at_utc NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "operational_incidents" ALTER COLUMN "last_seen_at_utc" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='operational_incidents' AND column_name='occurrence_count' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "operational_incidents" WHERE "occurrence_count" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set operational_incidents.occurrence_count NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "operational_incidents" ALTER COLUMN "occurrence_count" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='operational_incidents' AND column_name='opened_by_system' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "operational_incidents" WHERE "opened_by_system" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set operational_incidents.opened_by_system NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "operational_incidents" ALTER COLUMN "opened_by_system" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='operational_incidents' AND column_name='created_at' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "operational_incidents" WHERE "created_at" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set operational_incidents.created_at NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "operational_incidents" ALTER COLUMN "created_at" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='operational_incidents' AND column_name='updated_at' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "operational_incidents" WHERE "updated_at" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set operational_incidents.updated_at NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "operational_incidents" ALTER COLUMN "updated_at" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='operational_incident_events' AND column_name='incident_id' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "operational_incident_events" WHERE "incident_id" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set operational_incident_events.incident_id NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "operational_incident_events" ALTER COLUMN "incident_id" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='operational_incident_events' AND column_name='event_type' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "operational_incident_events" WHERE "event_type" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set operational_incident_events.event_type NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "operational_incident_events" ALTER COLUMN "event_type" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='operational_incident_events' AND column_name='safe_message' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "operational_incident_events" WHERE "safe_message" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set operational_incident_events.safe_message NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "operational_incident_events" ALTER COLUMN "safe_message" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_workflow_instances' AND column_name='team_id' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_workflow_instances" WHERE "team_id" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set evidence_workflow_instances.team_id NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "evidence_workflow_instances" ALTER COLUMN "team_id" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_workflow_instances' AND column_name='intake_mode' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_workflow_instances" WHERE "intake_mode" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set evidence_workflow_instances.intake_mode NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "evidence_workflow_instances" ALTER COLUMN "intake_mode" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_workflow_instances' AND column_name='actor_role' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_workflow_instances" WHERE "actor_role" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set evidence_workflow_instances.actor_role NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "evidence_workflow_instances" ALTER COLUMN "actor_role" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_workflow_instances' AND column_name='updated_at' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_workflow_instances" WHERE "updated_at" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set evidence_workflow_instances.updated_at NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "evidence_workflow_instances" ALTER COLUMN "updated_at" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_workflow_instance_evidence' AND column_name='id' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_workflow_instance_evidence" WHERE "id" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set evidence_workflow_instance_evidence.id NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "evidence_workflow_instance_evidence" ALTER COLUMN "id" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_workflow_instance_evidence' AND column_name='workflow_instance_id' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_workflow_instance_evidence" WHERE "workflow_instance_id" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set evidence_workflow_instance_evidence.workflow_instance_id NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "evidence_workflow_instance_evidence" ALTER COLUMN "workflow_instance_id" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_workflow_instance_evidence' AND column_name='evidence_id' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_workflow_instance_evidence" WHERE "evidence_id" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set evidence_workflow_instance_evidence.evidence_id NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "evidence_workflow_instance_evidence" ALTER COLUMN "evidence_id" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_workflow_instance_evidence' AND column_name='created_at' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_workflow_instance_evidence" WHERE "created_at" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set evidence_workflow_instance_evidence.created_at NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "evidence_workflow_instance_evidence" ALTER COLUMN "created_at" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_workflow_step_instances' AND column_name='workflow_instance_id' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_workflow_step_instances" WHERE "workflow_instance_id" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set evidence_workflow_step_instances.workflow_instance_id NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "evidence_workflow_step_instances" ALTER COLUMN "workflow_instance_id" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_workflow_step_instances' AND column_name='step_key' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_workflow_step_instances" WHERE "step_key" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set evidence_workflow_step_instances.step_key NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "evidence_workflow_step_instances" ALTER COLUMN "step_key" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_workflow_step_instances' AND column_name='order_index' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_workflow_step_instances" WHERE "order_index" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set evidence_workflow_step_instances.order_index NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "evidence_workflow_step_instances" ALTER COLUMN "order_index" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_workflow_step_instances' AND column_name='updated_at' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_workflow_step_instances" WHERE "updated_at" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set evidence_workflow_step_instances.updated_at NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "evidence_workflow_step_instances" ALTER COLUMN "updated_at" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_workflow_visibility_decisions' AND column_name='workflow_instance_id' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_workflow_visibility_decisions" WHERE "workflow_instance_id" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set evidence_workflow_visibility_decisions.workflow_instance_id NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "evidence_workflow_visibility_decisions" ALTER COLUMN "workflow_instance_id" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_workflow_visibility_decisions' AND column_name='field_key' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_workflow_visibility_decisions" WHERE "field_key" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set evidence_workflow_visibility_decisions.field_key NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "evidence_workflow_visibility_decisions" ALTER COLUMN "field_key" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_workflow_visibility_decisions' AND column_name='reason' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_workflow_visibility_decisions" WHERE "reason" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set evidence_workflow_visibility_decisions.reason NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "evidence_workflow_visibility_decisions" ALTER COLUMN "reason" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_workflow_visibility_decisions' AND column_name='updated_at' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_workflow_visibility_decisions" WHERE "updated_at" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set evidence_workflow_visibility_decisions.updated_at NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "evidence_workflow_visibility_decisions" ALTER COLUMN "updated_at" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_search_documents' AND column_name='team_id' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_search_documents" WHERE "team_id" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set evidence_search_documents.team_id NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "evidence_search_documents" ALTER COLUMN "team_id" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_search_documents' AND column_name='document_type' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_search_documents" WHERE "document_type" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set evidence_search_documents.document_type NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "evidence_search_documents" ALTER COLUMN "document_type" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_search_documents' AND column_name='source_id' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_search_documents" WHERE "source_id" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set evidence_search_documents.source_id NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "evidence_search_documents" ALTER COLUMN "source_id" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_search_documents' AND column_name='title' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_search_documents" WHERE "title" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set evidence_search_documents.title NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "evidence_search_documents" ALTER COLUMN "title" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_search_documents' AND column_name='source_updated_at_utc' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_search_documents" WHERE "source_updated_at_utc" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set evidence_search_documents.source_updated_at_utc NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "evidence_search_documents" ALTER COLUMN "source_updated_at_utc" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_search_documents' AND column_name='updated_at' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_search_documents" WHERE "updated_at" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set evidence_search_documents.updated_at NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "evidence_search_documents" ALTER COLUMN "updated_at" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='saved_search_views' AND column_name='team_id' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "saved_search_views" WHERE "team_id" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set saved_search_views.team_id NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "saved_search_views" ALTER COLUMN "team_id" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='saved_search_views' AND column_name='created_by_user_id' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "saved_search_views" WHERE "created_by_user_id" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set saved_search_views.created_by_user_id NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "saved_search_views" ALTER COLUMN "created_by_user_id" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='saved_search_views' AND column_name='query_json' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "saved_search_views" WHERE "query_json" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set saved_search_views.query_json NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "saved_search_views" ALTER COLUMN "query_json" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='saved_search_views' AND column_name='created_at' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "saved_search_views" WHERE "created_at" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set saved_search_views.created_at NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "saved_search_views" ALTER COLUMN "created_at" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='saved_search_views' AND column_name='updated_at' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "saved_search_views" WHERE "updated_at" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set saved_search_views.updated_at NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "saved_search_views" ALTER COLUMN "updated_at" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_exchange_package_deliveries' AND column_name='delivered_at' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_exchange_package_deliveries" WHERE "delivered_at" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set evidence_exchange_package_deliveries.delivered_at NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "evidence_exchange_package_deliveries" ALTER COLUMN "delivered_at" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='redaction_approvals' AND column_name='approved_at_utc' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "redaction_approvals" WHERE "approved_at_utc" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set redaction_approvals.approved_at_utc NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "redaction_approvals" ALTER COLUMN "approved_at_utc" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='subprocessor_versions' AND column_name='effective_at' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "subprocessor_versions" WHERE "effective_at" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set subprocessor_versions.effective_at NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "subprocessor_versions" ALTER COLUMN "effective_at" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='delegated_admin_grants' AND column_name='granted_to_user_id' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "delegated_admin_grants" WHERE "granted_to_user_id" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set delegated_admin_grants.granted_to_user_id NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "delegated_admin_grants" ALTER COLUMN "granted_to_user_id" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='governance_policy_assignments' AND column_name='created_at' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "governance_policy_assignments" WHERE "created_at" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set governance_policy_assignments.created_at NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "governance_policy_assignments" ALTER COLUMN "created_at" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='access_review_campaigns' AND column_name='starts_at_utc' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "access_review_campaigns" WHERE "starts_at_utc" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set access_review_campaigns.starts_at_utc NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "access_review_campaigns" ALTER COLUMN "starts_at_utc" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='access_review_campaigns' AND column_name='ends_at_utc' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "access_review_campaigns" WHERE "ends_at_utc" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set access_review_campaigns.ends_at_utc NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "access_review_campaigns" ALTER COLUMN "ends_at_utc" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='cross_org_review_grants' AND column_name='granted_by_user_id' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "cross_org_review_grants" WHERE "granted_by_user_id" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set cross_org_review_grants.granted_by_user_id NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "cross_org_review_grants" ALTER COLUMN "granted_by_user_id" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='media_intelligence_records' AND column_name='provider_record_key' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "media_intelligence_records" WHERE "provider_record_key" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set media_intelligence_records.provider_record_key NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "media_intelligence_records" ALTER COLUMN "provider_record_key" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='redaction_policy_assignments' AND column_name='version_id' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "redaction_policy_assignments" WHERE "version_id" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set redaction_policy_assignments.version_id NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "redaction_policy_assignments" ALTER COLUMN "version_id" SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='department_memberships' AND column_name='granted_by_user_id' AND is_nullable='YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "department_memberships" WHERE "granted_by_user_id" IS NULL LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot set department_memberships.granted_by_user_id NOT NULL: NULL rows remain';
    END IF;
    -- backfill verified complete
    -- NOT NULL readiness asserted
    EXECUTE 'ALTER TABLE "department_memberships" ALTER COLUMN "granted_by_user_id" SET NOT NULL';
  END IF;
END $$;

COMMIT;
