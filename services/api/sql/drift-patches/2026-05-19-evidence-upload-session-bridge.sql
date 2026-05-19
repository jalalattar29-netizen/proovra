-- =============================================================================
-- Phase 30.12 — Upload-session → EvidencePart bridge columns
-- =============================================================================
--
-- The Phase 30.8 native multipart flow produces ONE final S3 object per
-- upload_session. Until Phase 30.12, no EvidencePart row was created
-- pointing at that object — so downstream consumers (report-v2 PDF,
-- verification package, public verify payload, search indexing) couldn't
-- "see" the multipart material because they all read EvidenceParts.
--
-- This patch adds the columns needed to bridge an upload_session to a
-- canonical EvidencePart row at completeStorageMultipart time:
--
--   * `target_part_index`         — partIndex assigned by the capture
--                                   page (matches the per-item loop counter).
--                                   The EvidencePart row uses this so that
--                                   the (evidence_id, part_index) unique
--                                   index in `evidence_parts` is satisfied.
--   * `original_file_name`        — filename captured at session-create
--                                   time. Goes onto the EvidencePart row.
--   * `expected_mime_type`        — MIME type captured at session-create
--                                   time. Goes onto the EvidencePart row.
--   * `bridged_evidence_part_id`  — the id of the EvidencePart row this
--                                   session has been bridged to. SET ONCE
--                                   by completeStorageMultipart on first
--                                   success; the bridge is idempotent.
--
-- Hard rules:
--   * The bridge happens at completeStorageMultipart time, AFTER the
--     server-side SHA-256 verification has run. The newly-created
--     EvidencePart row carries the same fields it would have had via the
--     legacy single-shot path: partIndex, storageBucket, storageKey,
--     originalFileName, sizeBytes, mimeType, sha256.
--   * `uploadedAtUtc` on the bridged EvidencePart row stays NULL at
--     bridge time. The existing completeEvidence transaction sets it
--     atomically with the legacy parts (single server-clock `now` for
--     every part on a given Evidence row). Custody invariant preserved:
--     no part has a verified upload timestamp until finalize.
--   * `bridged_evidence_part_id` provides idempotency. A repeat
--     completeStorageMultipart call observes the bridge already exists
--     and returns without creating a duplicate part.
--
-- The patch is IDEMPOTENT + PARTIAL-STATE-SAFE:
--   * ADD COLUMN IF NOT EXISTS for every column.
--   * No destructive operations.
--
-- Operator command:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f \
--     services/api/sql/drift-patches/2026-05-19-evidence-upload-session-bridge.sql

BEGIN;

ALTER TABLE "evidence_upload_sessions"
  ADD COLUMN IF NOT EXISTS "target_part_index" INTEGER;
ALTER TABLE "evidence_upload_sessions"
  ADD COLUMN IF NOT EXISTS "original_file_name" VARCHAR(255);
ALTER TABLE "evidence_upload_sessions"
  ADD COLUMN IF NOT EXISTS "expected_mime_type" VARCHAR(128);
ALTER TABLE "evidence_upload_sessions"
  ADD COLUMN IF NOT EXISTS "bridged_evidence_part_id" UUID;

-- Bounded part-index check: matches the legacy EvidencePart contract
-- (0-indexed, non-negative). Added via DO block for idempotent re-run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidence_upload_sessions_target_part_index_nonneg'
  ) THEN
    ALTER TABLE "evidence_upload_sessions"
      ADD CONSTRAINT "evidence_upload_sessions_target_part_index_nonneg"
      CHECK ("target_part_index" IS NULL OR "target_part_index" >= 0);
  END IF;
END
$$;

-- Lookup: "has this session already been bridged?" — used by the
-- idempotency check in completeStorageMultipart.
CREATE INDEX IF NOT EXISTS "evidence_upload_sessions_bridged_part_idx"
  ON "evidence_upload_sessions" ("bridged_evidence_part_id")
  WHERE "bridged_evidence_part_id" IS NOT NULL;

COMMIT;
