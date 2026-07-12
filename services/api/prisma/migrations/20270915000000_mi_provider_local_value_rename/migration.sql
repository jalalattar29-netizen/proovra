-- Phase F-8 — HONEST provider-label value rename (PREPARED; requires a real
-- database to execute — see AI_ENTERPRISE_PROGRAM_STATE.md environment
-- blockers).
--
-- The OPENAI_ENTITY_EXTRACTION / OPENAI_DOCUMENT_SUMMARY adapters have never
-- made an outbound OpenAI call: they run a bounded LOCAL regex-PII /
-- deterministic-summary fallback. New rows are now written with the honest
-- LOCAL_* labels; this migration rewrites the legacy stored values so the
-- catalog stops implying an OpenAI binding that never existed.
--
-- Safety profile:
--   * VALUE-ONLY UPDATEs, each scoped by an exact WHERE on the legacy value.
--   * `provider` is a VarChar(80) column (NOT a Postgres enum) on both
--     tables — no type/DDL change is needed or performed.
--   * Idempotent: re-running matches zero rows.
--   * No DROP / RENAME / TRUNCATE / DELETE. No other columns touched.
--   * Guarded by to_regclass so the migration is a no-op on environments
--     where a table does not exist yet.

DO $$
BEGIN
  IF to_regclass('public.media_intelligence_records') IS NOT NULL THEN
    UPDATE media_intelligence_records
      SET provider = 'LOCAL_ENTITY_EXTRACTION'
      WHERE provider = 'OPENAI_ENTITY_EXTRACTION';
    UPDATE media_intelligence_records
      SET provider = 'LOCAL_DOCUMENT_SUMMARY'
      WHERE provider = 'OPENAI_DOCUMENT_SUMMARY';
  END IF;

  IF to_regclass('public.provider_usage_events') IS NOT NULL THEN
    UPDATE provider_usage_events
      SET provider = 'LOCAL_ENTITY_EXTRACTION'
      WHERE provider = 'OPENAI_ENTITY_EXTRACTION';
    UPDATE provider_usage_events
      SET provider = 'LOCAL_DOCUMENT_SUMMARY'
      WHERE provider = 'OPENAI_DOCUMENT_SUMMARY';
  END IF;
END $$;
