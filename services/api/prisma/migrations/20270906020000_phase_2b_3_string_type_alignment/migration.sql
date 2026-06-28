-- Phase 2B.3 — string type alignment
--
-- Live precheck summary:
--   * every text -> varchar candidate had 0 over-limit rows
--   * package_id is excluded here because it is canonically UUID and
--     is repaired in Phase 2B.6 instead
--
-- Safety rules:
--   * verify max length before every narrowing
--   * no truncation
--   * no unrelated text changes

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_saved_views' AND column_name='name' AND data_type='text'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_saved_views" WHERE "name" IS NOT NULL AND length("name") > 120 LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot convert evidence_saved_views.name to VARCHAR(120): over-limit values exist';
    END IF;
    EXECUTE 'ALTER TABLE "evidence_saved_views" ALTER COLUMN "name" TYPE VARCHAR(120)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='notification_deliveries' AND column_name='event_type' AND data_type='text'
  ) THEN
    IF EXISTS (SELECT 1 FROM "notification_deliveries" WHERE "event_type" IS NOT NULL AND length("event_type") > 64 LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot convert notification_deliveries.event_type to VARCHAR(64): over-limit values exist';
    END IF;
    EXECUTE 'ALTER TABLE "notification_deliveries" ALTER COLUMN "event_type" TYPE VARCHAR(64)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='notification_deliveries' AND column_name='recipient' AND data_type='text'
  ) THEN
    IF EXISTS (SELECT 1 FROM "notification_deliveries" WHERE "recipient" IS NOT NULL AND length("recipient") > 512 LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot convert notification_deliveries.recipient to VARCHAR(512): over-limit values exist';
    END IF;
    EXECUTE 'ALTER TABLE "notification_deliveries" ALTER COLUMN "recipient" TYPE VARCHAR(512)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='notification_deliveries' AND column_name='recipient_name' AND data_type='text'
  ) THEN
    IF EXISTS (SELECT 1 FROM "notification_deliveries" WHERE "recipient_name" IS NOT NULL AND length("recipient_name") > 180 LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot convert notification_deliveries.recipient_name to VARCHAR(180): over-limit values exist';
    END IF;
    EXECUTE 'ALTER TABLE "notification_deliveries" ALTER COLUMN "recipient_name" TYPE VARCHAR(180)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='notification_deliveries' AND column_name='subject' AND data_type='text'
  ) THEN
    IF EXISTS (SELECT 1 FROM "notification_deliveries" WHERE "subject" IS NOT NULL AND length("subject") > 400 LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot convert notification_deliveries.subject to VARCHAR(400): over-limit values exist';
    END IF;
    EXECUTE 'ALTER TABLE "notification_deliveries" ALTER COLUMN "subject" TYPE VARCHAR(400)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='notification_deliveries' AND column_name='template_key' AND data_type='text'
  ) THEN
    IF EXISTS (SELECT 1 FROM "notification_deliveries" WHERE "template_key" IS NOT NULL AND length("template_key") > 80 LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot convert notification_deliveries.template_key to VARCHAR(80): over-limit values exist';
    END IF;
    EXECUTE 'ALTER TABLE "notification_deliveries" ALTER COLUMN "template_key" TYPE VARCHAR(80)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='notification_deliveries' AND column_name='rendered_preview' AND data_type='text'
  ) THEN
    IF EXISTS (SELECT 1 FROM "notification_deliveries" WHERE "rendered_preview" IS NOT NULL AND length("rendered_preview") > 2000 LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot convert notification_deliveries.rendered_preview to VARCHAR(2000): over-limit values exist';
    END IF;
    EXECUTE 'ALTER TABLE "notification_deliveries" ALTER COLUMN "rendered_preview" TYPE VARCHAR(2000)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='notification_deliveries' AND column_name='provider_message_id' AND data_type='text'
  ) THEN
    IF EXISTS (SELECT 1 FROM "notification_deliveries" WHERE "provider_message_id" IS NOT NULL AND length("provider_message_id") > 255 LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot convert notification_deliveries.provider_message_id to VARCHAR(255): over-limit values exist';
    END IF;
    EXECUTE 'ALTER TABLE "notification_deliveries" ALTER COLUMN "provider_message_id" TYPE VARCHAR(255)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='notification_deliveries' AND column_name='error_code' AND data_type='text'
  ) THEN
    IF EXISTS (SELECT 1 FROM "notification_deliveries" WHERE "error_code" IS NOT NULL AND length("error_code") > 80 LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot convert notification_deliveries.error_code to VARCHAR(80): over-limit values exist';
    END IF;
    EXECUTE 'ALTER TABLE "notification_deliveries" ALTER COLUMN "error_code" TYPE VARCHAR(80)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='notification_deliveries' AND column_name='error_message' AND data_type='text'
  ) THEN
    IF EXISTS (SELECT 1 FROM "notification_deliveries" WHERE "error_message" IS NOT NULL AND length("error_message") > 2000 LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot convert notification_deliveries.error_message to VARCHAR(2000): over-limit values exist';
    END IF;
    EXECUTE 'ALTER TABLE "notification_deliveries" ALTER COLUMN "error_message" TYPE VARCHAR(2000)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_legal_holds' AND column_name='title' AND data_type='text'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_legal_holds" WHERE "title" IS NOT NULL AND length("title") > 180 LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot convert evidence_legal_holds.title to VARCHAR(180): over-limit values exist';
    END IF;
    EXECUTE 'ALTER TABLE "evidence_legal_holds" ALTER COLUMN "title" TYPE VARCHAR(180)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_legal_holds' AND column_name='reason' AND data_type='text'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_legal_holds" WHERE "reason" IS NOT NULL AND length("reason") > 4000 LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot convert evidence_legal_holds.reason to VARCHAR(4000): over-limit values exist';
    END IF;
    EXECUTE 'ALTER TABLE "evidence_legal_holds" ALTER COLUMN "reason" TYPE VARCHAR(4000)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_legal_holds' AND column_name='release_note' AND data_type='text'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_legal_holds" WHERE "release_note" IS NOT NULL AND length("release_note") > 4000 LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot convert evidence_legal_holds.release_note to VARCHAR(4000): over-limit values exist';
    END IF;
    EXECUTE 'ALTER TABLE "evidence_legal_holds" ALTER COLUMN "release_note" TYPE VARCHAR(4000)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='security_events' AND column_name='userAgent' AND data_type='text'
  ) THEN
    IF EXISTS (SELECT 1 FROM "security_events" WHERE "userAgent" IS NOT NULL AND length("userAgent") > 512 LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot convert security_events.userAgent to VARCHAR(512): over-limit values exist';
    END IF;
    EXECUTE 'ALTER TABLE "security_events" ALTER COLUMN "userAgent" TYPE VARCHAR(512)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='upload_sessions' AND column_name='multipart_upload_id' AND data_type='text'
  ) THEN
    IF EXISTS (SELECT 1 FROM "upload_sessions" WHERE "multipart_upload_id" IS NOT NULL AND length("multipart_upload_id") > 256 LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot convert upload_sessions.multipart_upload_id to VARCHAR(256): over-limit values exist';
    END IF;
    EXECUTE 'ALTER TABLE "upload_sessions" ALTER COLUMN "multipart_upload_id" TYPE VARCHAR(256)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='upload_sessions' AND column_name='failure_reason' AND data_type='text'
  ) THEN
    IF EXISTS (SELECT 1 FROM "upload_sessions" WHERE "failure_reason" IS NOT NULL AND length("failure_reason") > 400 LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot convert upload_sessions.failure_reason to VARCHAR(400): over-limit values exist';
    END IF;
    EXECUTE 'ALTER TABLE "upload_sessions" ALTER COLUMN "failure_reason" TYPE VARCHAR(400)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_entities' AND column_name='value' AND data_type='text'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_entities" WHERE "value" IS NOT NULL AND length("value") > 512 LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot convert evidence_entities.value to VARCHAR(512): over-limit values exist';
    END IF;
    EXECUTE 'ALTER TABLE "evidence_entities" ALTER COLUMN "value" TYPE VARCHAR(512)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_entities' AND column_name='normalized_value' AND data_type='text'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_entities" WHERE "normalized_value" IS NOT NULL AND length("normalized_value") > 512 LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot convert evidence_entities.normalized_value to VARCHAR(512): over-limit values exist';
    END IF;
    EXECUTE 'ALTER TABLE "evidence_entities" ALTER COLUMN "normalized_value" TYPE VARCHAR(512)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='discussion_threads' AND column_name='resolution_note' AND data_type='text'
  ) THEN
    IF EXISTS (SELECT 1 FROM "discussion_threads" WHERE "resolution_note" IS NOT NULL AND length("resolution_note") > 1000 LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot convert discussion_threads.resolution_note to VARCHAR(1000): over-limit values exist';
    END IF;
    EXECUTE 'ALTER TABLE "discussion_threads" ALTER COLUMN "resolution_note" TYPE VARCHAR(1000)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='discussion_threads' AND column_name='escalation_reason' AND data_type='text'
  ) THEN
    IF EXISTS (SELECT 1 FROM "discussion_threads" WHERE "escalation_reason" IS NOT NULL AND length("escalation_reason") > 400 LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot convert discussion_threads.escalation_reason to VARCHAR(400): over-limit values exist';
    END IF;
    EXECUTE 'ALTER TABLE "discussion_threads" ALTER COLUMN "escalation_reason" TYPE VARCHAR(400)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='discussion_messages' AND column_name='body' AND data_type='text'
  ) THEN
    IF EXISTS (SELECT 1 FROM "discussion_messages" WHERE "body" IS NOT NULL AND length("body") > 8192 LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot convert discussion_messages.body to VARCHAR(8192): over-limit values exist';
    END IF;
    EXECUTE 'ALTER TABLE "discussion_messages" ALTER COLUMN "body" TYPE VARCHAR(8192)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='operational_incidents' AND column_name='resolution_note' AND data_type='text'
  ) THEN
    IF EXISTS (SELECT 1 FROM "operational_incidents" WHERE "resolution_note" IS NOT NULL AND length("resolution_note") > 400 LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot convert operational_incidents.resolution_note to VARCHAR(400): over-limit values exist';
    END IF;
    EXECUTE 'ALTER TABLE "operational_incidents" ALTER COLUMN "resolution_note" TYPE VARCHAR(400)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_search_documents' AND column_name='title' AND data_type='text'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_search_documents" WHERE "title" IS NOT NULL AND length("title") > 200 LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot convert evidence_search_documents.title to VARCHAR(200): over-limit values exist';
    END IF;
    EXECUTE 'ALTER TABLE "evidence_search_documents" ALTER COLUMN "title" TYPE VARCHAR(200)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_search_documents' AND column_name='subtitle' AND data_type='text'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_search_documents" WHERE "subtitle" IS NOT NULL AND length("subtitle") > 200 LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot convert evidence_search_documents.subtitle to VARCHAR(200): over-limit values exist';
    END IF;
    EXECUTE 'ALTER TABLE "evidence_search_documents" ALTER COLUMN "subtitle" TYPE VARCHAR(200)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_search_documents' AND column_name='summary' AND data_type='text'
  ) THEN
    IF EXISTS (SELECT 1 FROM "evidence_search_documents" WHERE "summary" IS NOT NULL AND length("summary") > 400 LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot convert evidence_search_documents.summary to VARCHAR(400): over-limit values exist';
    END IF;
    EXECUTE 'ALTER TABLE "evidence_search_documents" ALTER COLUMN "summary" TYPE VARCHAR(400)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='reviewer_ops_reminders' AND column_name='dedup_key' AND data_type='text'
  ) THEN
    IF EXISTS (SELECT 1 FROM "reviewer_ops_reminders" WHERE "dedup_key" IS NOT NULL AND length("dedup_key") > 80 LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot convert reviewer_ops_reminders.dedup_key to VARCHAR(80): over-limit values exist';
    END IF;
    EXECUTE 'ALTER TABLE "reviewer_ops_reminders" ALTER COLUMN "dedup_key" TYPE VARCHAR(80)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='reviewer_ops_reminders' AND column_name='safe_summary' AND data_type='text'
  ) THEN
    IF EXISTS (SELECT 1 FROM "reviewer_ops_reminders" WHERE "safe_summary" IS NOT NULL AND length("safe_summary") > 400 LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot convert reviewer_ops_reminders.safe_summary to VARCHAR(400): over-limit values exist';
    END IF;
    EXECUTE 'ALTER TABLE "reviewer_ops_reminders" ALTER COLUMN "safe_summary" TYPE VARCHAR(400)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='reviewer_ops_reminders' AND column_name='status' AND data_type='text'
  ) THEN
    IF EXISTS (SELECT 1 FROM "reviewer_ops_reminders" WHERE "status" IS NOT NULL AND length("status") > 16 LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot convert reviewer_ops_reminders.status to VARCHAR(16): over-limit values exist';
    END IF;
    EXECUTE 'ALTER TABLE "reviewer_ops_reminders" ALTER COLUMN "status" TYPE VARCHAR(16)';
  END IF;
END $$;

COMMIT;
