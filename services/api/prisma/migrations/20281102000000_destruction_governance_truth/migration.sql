-- =============================================================================
-- 2026-11-01 — destruction governance truth (GOV-002, GOV-003, GOV-007, GOV-009,
-- GOV-011, GOV-018, GOV-019).
--
-- EXPAND / SAFE_TO_APPLY_NOW, no backfill. Nullable columns plus delete and
-- rewrite refusals on governance history. No existing row is rewritten, and an
-- image that predates this migration neither reads nor writes these columns.
--
-- 1. destruction_reviews: who took the review up, who asked for execution, when
--    the worker may next try, and the state approval queued the record from.
--    Execution needs a person's act; approval alone no longer reaches storage.
-- 2. destruction_requests.execution_started_at_utc: the lease that lets a
--    request stranded in EXECUTING by a crash be resumed.
-- 3. destruction_certificates.certificate_body: the signed body, in the
--    database, so a failed object upload can no longer lose the only copy.
-- 4. evidence.destruction_partial_at_utc: some bytes of this record are gone, so
--    it may never be restored and the sweep must finish the job.
-- 5. evidence_legal_holds.release_requested_*: the request half of a two-person
--    hold release.
-- 6. Certificates become append-only. Governance rows keep their state changes
--    but can no longer be deleted.
--
-- ROLLBACK is code-first: revert the images and leave the schema expanded.
-- =============================================================================

ALTER TABLE "destruction_reviews"
  ADD COLUMN IF NOT EXISTS "review_started_by_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "execution_requested_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "execution_requested_by_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "execution_not_before_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "queued_from_state" VARCHAR(32);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='destruction_reviews'
       AND column_name='execution_not_before_utc'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='destruction_reviews'
       AND column_name='execution_requested_at_utc'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='destruction_reviews'
       AND column_name='status'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "destruction_reviews_execution_due_idx" ON "destruction_reviews" ("execution_not_before_utc", "execution_requested_at_utc") WHERE "status" = ''APPROVED'' AND "execution_requested_at_utc" IS NOT NULL';
  END IF;
END $$;

ALTER TABLE "destruction_requests"
  ADD COLUMN IF NOT EXISTS "execution_started_at_utc" TIMESTAMPTZ(6);

ALTER TABLE "destruction_certificates"
  ADD COLUMN IF NOT EXISTS "certificate_body" TEXT;

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "destruction_partial_at_utc" TIMESTAMPTZ(6);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence'
       AND column_name='destruction_partial_at_utc'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "evidence_destruction_partial_idx" ON "evidence" ("destruction_partial_at_utc") WHERE "destruction_partial_at_utc" IS NOT NULL';
  END IF;
END $$;

ALTER TABLE "evidence_legal_holds"
  ADD COLUMN IF NOT EXISTS "release_requested_by_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "release_requested_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "release_request_note" VARCHAR(4000);

-- The canonical refusal function (re-declared verbatim, so this migration stands
-- alone on a database restored without the custody migration's body).
CREATE OR REPLACE FUNCTION "proovra_refuse_history_rewrite"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS "destruction_certificates_append_only" ON "destruction_certificates";
CREATE TRIGGER "destruction_certificates_append_only"
  BEFORE UPDATE OR DELETE ON "destruction_certificates"
  FOR EACH ROW EXECUTE FUNCTION "proovra_refuse_history_rewrite"();

DROP TRIGGER IF EXISTS "destruction_requests_no_delete" ON "destruction_requests";
CREATE TRIGGER "destruction_requests_no_delete"
  BEFORE DELETE ON "destruction_requests"
  FOR EACH ROW EXECUTE FUNCTION "proovra_refuse_history_rewrite"();

DROP TRIGGER IF EXISTS "destruction_reviews_no_delete" ON "destruction_reviews";
CREATE TRIGGER "destruction_reviews_no_delete"
  BEFORE DELETE ON "destruction_reviews"
  FOR EACH ROW EXECUTE FUNCTION "proovra_refuse_history_rewrite"();

DROP TRIGGER IF EXISTS "destruction_executions_no_delete" ON "destruction_executions";
CREATE TRIGGER "destruction_executions_no_delete"
  BEFORE DELETE ON "destruction_executions"
  FOR EACH ROW EXECUTE FUNCTION "proovra_refuse_history_rewrite"();
