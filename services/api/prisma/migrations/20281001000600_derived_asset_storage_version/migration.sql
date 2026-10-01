-- UC-DER-006 — a derivative's output object VERSION is recorded next to its key and digest.
--
-- Producers already record storage_bucket / storage_key / derived_sha256; on a versioned
-- (Object Lock) bucket the key alone does not identify the bytes, so a later write at the
-- same key could be read as this generation. The S3 VersionId returned by the PUT is now
-- stored, mirroring evidence_parts.storage_version_id. NULL on unversioned storage and on
-- rows written before this migration.
--
-- EXPAND. Additive nullable column. Idempotent. Apply BEFORE the worker image that writes it.
ALTER TABLE "evidence_part_derived_assets"
  ADD COLUMN IF NOT EXISTS "storage_version_id" VARCHAR(1024);
