-- =============================================================================
-- 2026-11-03 — REPORT-006: what a publication intent actually published.
--
-- EXPAND / SAFE_TO_APPLY_NOW, no backfill. Four nullable columns on
-- artifact_publication_intents, written after the worker has read the object back
-- by version and found it is the bytes it sent. A retry of the same request whose
-- bytes are identical reuses that verified object instead of writing another
-- Object-Locked copy nothing will reference. An intent recorded before this
-- migration has no digest and is never reused. No row is rewritten, and an image
-- that predates this migration neither reads nor writes these columns.
-- =============================================================================

ALTER TABLE "artifact_publication_intents"
  ADD COLUMN IF NOT EXISTS "sha256_hex" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "size_bytes" BIGINT,
  ADD COLUMN IF NOT EXISTS "version_id" VARCHAR(1024),
  ADD COLUMN IF NOT EXISTS "verified_at_utc" TIMESTAMPTZ(6);

CREATE INDEX IF NOT EXISTS "artifact_publication_intents_request_family_idx"
  ON "artifact_publication_intents" ("request_id", "family");
