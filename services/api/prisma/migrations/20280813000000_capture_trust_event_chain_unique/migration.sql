-- =============================================================================
-- CAPTURE TRUST-EVENT CHAIN UNIQUENESS (2026-09-30, ET-DC-10). EXPAND.
--
-- The capture trust-event sub-chain was extended by an unlocked read of its
-- head followed by an insert, so concurrent declarations could write two links
-- with the same sequence and fork the chain. Appends now take an advisory lock
-- per chain; these partial unique indexes are the backstop.
--
-- Partial on created_at so rows written before this migration (which may
-- already hold duplicate sequences) are never rewritten or refused: nothing
-- existing is touched, and every link written from now on is unique within its
-- chain (a session's chain; a record's chain when no session is named).
-- Idempotent (IF NOT EXISTS). Guarded in the Phase O-Final form: each index is
-- created only when every column it names exists.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'capture_trust_event_records'
       AND column_name = 'capture_session_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'capture_trust_event_records'
       AND column_name = 'sequence'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'capture_trust_event_records'
       AND column_name = 'created_at'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "capture_trust_event_records_session_sequence_key" ON "capture_trust_event_records" ("capture_session_id", "sequence") WHERE "capture_session_id" IS NOT NULL AND "created_at" >= TIMESTAMPTZ ''2026-09-30 00:00:00+00''';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'capture_trust_event_records'
       AND column_name = 'evidence_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'capture_trust_event_records'
       AND column_name = 'sequence'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'capture_trust_event_records'
       AND column_name = 'capture_session_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'capture_trust_event_records'
       AND column_name = 'created_at'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "capture_trust_event_records_evidence_sequence_key" ON "capture_trust_event_records" ("evidence_id", "sequence") WHERE "evidence_id" IS NOT NULL AND "capture_session_id" IS NULL AND "created_at" >= TIMESTAMPTZ ''2026-09-30 00:00:00+00''';
  END IF;
END $$;
