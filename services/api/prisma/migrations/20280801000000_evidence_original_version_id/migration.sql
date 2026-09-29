-- EVIDENCE ORIGINAL VERSION ID (2026-09-29, audit D14). Additive only: two
-- nullable columns.
--
-- The S3 VersionId of each ORIGINAL object (the record's own object and each
-- part) exactly as it was hashed and signed at finalization. On a versioned
-- (Object Lock) bucket a later PUT to the same key — for instance through an
-- upload URL that was still valid — makes a NEW version "latest at key"
-- without touching the signed one. Readers that re-hash or serve the original
-- read THIS version, so the bytes they see are the bytes that were signed.
--
-- Historical rows keep NULL ("not recorded"); readers fall back to the key.
-- Nothing is inferred or backfilled.

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "storage_version_id" VARCHAR(1024);

ALTER TABLE "evidence_parts"
  ADD COLUMN IF NOT EXISTS "storage_version_id" VARCHAR(1024);
