-- =============================================================================
-- Phase 30.8 — Native S3 multipart upload integration
-- =============================================================================
--
-- Extends the Phase 30 upload-session tables with the columns needed
-- to back a session by a true S3 Multipart Upload (CreateMultipartUpload
-- → UploadPart x N → CompleteMultipartUpload). Without these columns
-- the session is metadata-only; with them, the platform can:
--
--   * Track the S3-internal MultipartUploadId so abort / complete
--     calls can be made against the right S3 transaction.
--   * Persist each part's ETag (S3-supplied storage metadata, NOT an
--     integrity proof) so CompleteMultipartUpload can be called with
--     the canonical {PartNumber, ETag} list.
--   * Record the FINAL object's bucket + key + size after S3
--     CompleteMultipartUpload returns, so the custody-safe finalize
--     gate can later read these as the authoritative storage location.
--   * Surface a reaper sweep for sessions with `multipart_upload_id`
--     set but `completed_at_storage_utc` still NULL after expiry.
--
-- Hard custody invariants encoded in this patch:
--   * `completed_at_storage_utc` and `aborted_at_storage_utc` are
--     RECORDED-ON-S3 timestamps. They are NOT the evidence-finalize
--     uploadedAt — that one is set ONLY by completeEvidence on the
--     Evidence row after the finalize gate passes.
--   * `completed_object_etag` is storage metadata. The custody chain
--     continues to rely on `server_sha256` (per part, recomputed by
--     the server) for integrity.
--   * `part_etag` is whatever S3 returned for `UploadPartResponse`.
--     It is NOT a hash — for multipart uploads S3's ETag is
--     `md5(md5(part1)+md5(part2)+...)` which has no integrity meaning
--     against the original bytes.
--   * `multipart_upload_id` is INTERNAL ONLY. It is never projected
--     to API responses; route projections strip it explicitly.
--
-- The patch is IDEMPOTENT + PARTIAL-STATE-SAFE:
--   * ADD COLUMN IF NOT EXISTS for every column.
--   * CREATE INDEX IF NOT EXISTS for every index.
--   * Constraints added via DO blocks that check existence first.
--   * No destructive operations.
--
-- Operator command:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f \
--     services/api/sql/drift-patches/2026-05-19-evidence-upload-multipart.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- Session table — multipart upload bookkeeping
-- ---------------------------------------------------------------------------

-- S3-internal MultipartUploadId returned by CreateMultipartUpload.
-- NULL when the session has not yet been backed by a native S3
-- multipart upload (e.g. legacy single-shot flow, or session is
-- INITIATED but not yet initiated against storage).
ALTER TABLE "evidence_upload_sessions"
  ADD COLUMN IF NOT EXISTS "multipart_upload_id" VARCHAR(512);

-- Storage bucket + key for the FINAL object produced by
-- CompleteMultipartUpload. NULL until the storage-complete call
-- returns. Both are set ONLY by the storage-multipart service after
-- the S3 SDK confirms the object exists; never set at presign time.
ALTER TABLE "evidence_upload_sessions"
  ADD COLUMN IF NOT EXISTS "storage_bucket" VARCHAR(255);
ALTER TABLE "evidence_upload_sessions"
  ADD COLUMN IF NOT EXISTS "storage_key" VARCHAR(1024);

-- S3-returned ETag + size of the final object after multipart
-- completion. Storage metadata only — never used as a SHA-256
-- substitute. `completed_object_size` lets the reaper surface
-- discrepancies between expected_total_bytes and actual.
ALTER TABLE "evidence_upload_sessions"
  ADD COLUMN IF NOT EXISTS "completed_object_etag" VARCHAR(256);
ALTER TABLE "evidence_upload_sessions"
  ADD COLUMN IF NOT EXISTS "completed_object_size" BIGINT;

-- Storage-side timestamps. DISTINCT from `completed_at_utc` which is
-- the session-state COMPLETED flip; these record when S3 actually
-- confirmed the multipart complete / abort SDK call.
ALTER TABLE "evidence_upload_sessions"
  ADD COLUMN IF NOT EXISTS "completed_at_storage_utc" TIMESTAMPTZ(6);
ALTER TABLE "evidence_upload_sessions"
  ADD COLUMN IF NOT EXISTS "aborted_at_storage_utc" TIMESTAMPTZ(6);

-- Constraints — added via DO blocks so re-runs don't fail with
-- "constraint already exists".
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidence_upload_sessions_completed_size_nonneg'
  ) THEN
    ALTER TABLE "evidence_upload_sessions"
      ADD CONSTRAINT "evidence_upload_sessions_completed_size_nonneg"
      CHECK ("completed_object_size" IS NULL OR "completed_object_size" >= 0);
  END IF;
END
$$;

-- The multipart_upload_id must be unique per (team, bucket, key)
-- to prevent a stray InitiateMultipartUpload retry from booking two
-- S3 transactions against the same logical session. We don't enforce
-- this at the global level because two different teams can legally
-- use the same bucket+key (though our key namespacing prevents that
-- in practice).
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_upload_sessions_multipart_uk"
  ON "evidence_upload_sessions" ("team_id", "multipart_upload_id")
  WHERE "multipart_upload_id" IS NOT NULL;

-- Stale-multipart reaper sweep: find sessions that have a live S3
-- multipart upload but haven't reached storage completion or abort
-- and whose expires_at has passed.
CREATE INDEX IF NOT EXISTS "evidence_upload_sessions_multipart_reaper_idx"
  ON "evidence_upload_sessions" ("expires_at_utc")
  WHERE "multipart_upload_id" IS NOT NULL
    AND "completed_at_storage_utc" IS NULL
    AND "aborted_at_storage_utc" IS NULL;

-- ---------------------------------------------------------------------------
-- Per-part table — multipart part metadata
-- ---------------------------------------------------------------------------

-- S3-supplied ETag for the part. CompleteMultipartUpload takes a
-- list of {PartNumber, ETag} pairs and S3 reconstructs the final
-- object from them. The ETag for an UploadPart response is the MD5
-- of the part bytes — useful for storage-side verification but NOT
-- a custody-grade integrity proof.
ALTER TABLE "evidence_upload_session_parts"
  ADD COLUMN IF NOT EXISTS "part_etag" VARCHAR(256);

-- Server-recorded part size. The session row's expected_total_bytes
-- can be compared against the sum of part_size_bytes across all
-- parts for sanity checks.
ALTER TABLE "evidence_upload_session_parts"
  ADD COLUMN IF NOT EXISTS "part_size_bytes" BIGINT;

-- Presign bookkeeping — when did the server issue a presigned
-- UploadPart URL for this part, and when does it expire? Allows
-- the reaper / operator surface to see "this part was presigned 4h
-- ago and never uploaded" without re-deriving from S3 audit logs.
ALTER TABLE "evidence_upload_session_parts"
  ADD COLUMN IF NOT EXISTS "presigned_at_utc" TIMESTAMPTZ(6);
ALTER TABLE "evidence_upload_session_parts"
  ADD COLUMN IF NOT EXISTS "presign_expires_at_utc" TIMESTAMPTZ(6);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidence_upload_session_parts_part_size_nonneg'
  ) THEN
    ALTER TABLE "evidence_upload_session_parts"
      ADD CONSTRAINT "evidence_upload_session_parts_part_size_nonneg"
      CHECK ("part_size_bytes" IS NULL OR "part_size_bytes" >= 0);
  END IF;
END
$$;

-- Fast lookup: list parts with their ETags for CompleteMultipartUpload.
-- ORDER BY part_index ASC is the canonical sequence S3 expects.
CREATE INDEX IF NOT EXISTS "evidence_upload_session_parts_etag_idx"
  ON "evidence_upload_session_parts" ("session_id", "part_index")
  WHERE "part_etag" IS NOT NULL;

COMMIT;
