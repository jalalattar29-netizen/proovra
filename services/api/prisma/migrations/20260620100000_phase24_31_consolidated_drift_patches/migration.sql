-- =============================================================================
-- Phase 32.5 — Consolidated drift-patch migration for Phase 24-J/25/30/31/32.
-- =============================================================================
--
-- This single migration absorbs the 16 operator-applied drift patches that
-- previously lived only in `services/api/sql/drift-patches/`. With this
-- migration in place, `prisma migrate deploy` against a fresh database
-- produces a fully working schema WITHOUT requiring any out-of-band
-- psql invocations.
--
-- Patches absorbed (in apply order — kept identical to the drift-patches
-- directory listing so operators can cross-reference):
--   2026-05-19-evidence-upload-sessions.sql
--   2026-05-19-evidence-upload-multipart.sql
--   2026-05-19-evidence-upload-session-bridge.sql
--   2026-05-19-saved-search-views-scope.sql
--   2026-05-19-search-audit-log.sql
--   2026-05-19-search-fts-pgvector.sql
--   2026-05-19-evidence-ocr-text.sql
--   2026-05-19-evidence-transcripts.sql
--   2026-05-19-external-review-grants.sql
--   2026-05-20-media-intelligence-runs.sql
--   2026-05-20-media-intelligence-signals.sql
--   2026-05-20-evidence-part-exif-summaries.sql
--   2026-05-20-evidence-part-derived-assets.sql
--   2026-05-20-investigation-graph.sql
--   2026-05-20-ocr-transcript-indexed-signals.sql
--   2026-05-20-reviewer-ops-phase25-consolidation.sql
--
-- Idempotency: every statement uses IF NOT EXISTS / IF EXISTS guards.
-- Safe to re-run on partially-applied environments (e.g. some drift
-- patches were applied manually before this migration was added).
--
-- Prisma already wraps each migration in its own transaction, so the
-- BEGIN/COMMIT pairs from the individual drift patches have been
-- stripped during consolidation. The original .sql files in
-- services/api/sql/drift-patches/ are retained for operator reference
-- but are NO LONGER required for fresh deploys.
--
-- Rollback notes:
--   See the rollback blocks in the individual drift patches under
--   services/api/sql/drift-patches/*.sql. Run those in REVERSE order
--   if a rollback is required. Most patches are additive (no DROP) so
--   a partial rollback (just dropping the newly-created tables) is
--   sufficient for emergency recovery.
-- =============================================================================


-- =========================================================================
-- BLOCK: 2026-05-19-evidence-upload-sessions.sql
-- =========================================================================
-- =============================================================================
-- Phase 30 — Resumable multipart upload session persistence
-- =============================================================================
--
-- The existing per-part presigned upload flow is single-shot: each
-- EvidencePart row gets a presigned PUT URL, but there's no server-side
-- tracking of which parts the client has actually persisted vs. which
-- it must retry on network failure or process restart. This patch adds
-- a `evidence_upload_sessions` table + a `evidence_upload_session_parts`
-- companion table so the upload flow can:
--
--   * Track every part the client has been authorised to upload
--   * Mark a part `UPLOADED_UNVERIFIED` after the client reports success
--   * Mark a part `VERIFIED` after the server-side HEAD + SHA256 check
--   * Mark a session `COMPLETED` only when every required part is verified
--   * Identify stale / abandoned sessions for the upload-reaper worker
--
-- Critical custody invariants encoded in the schema:
--   * `uploaded_at_utc` on the SESSION is set ONLY on completion (server
--     clock; never client clock).
--   * Per-part `verified_at_utc` is server-confirmed via HEAD; the
--     `uploaded_at_utc_client` field stores the client-observed time
--     SEPARATELY so the audit trail distinguishes "client claims X" vs
--     "server confirmed at Y".
--   * The `state` catalog is bounded so the search/governance gates can
--     query "uploaded but not yet verified" sessions and refuse to
--     surface them in any operator surface.
--
-- The patch is PARTIAL-STATE-SAFE + IDEMPOTENT:
--   * CREATE TABLE IF NOT EXISTS — re-runs are no-ops.
--   * CREATE INDEX IF NOT EXISTS for every index.
--   * No destructive operations.
--
-- Operator command:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f \
--     services/api/sql/drift-patches/2026-05-19-evidence-upload-sessions.sql


-- ---------------------------------------------------------------------------
-- Session table — one row per upload attempt
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "evidence_upload_sessions" (
  "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id"                  UUID NOT NULL,
  "evidence_id"              UUID NOT NULL,
  "actor_user_id"            UUID NOT NULL,
  "state"                    VARCHAR(24) NOT NULL DEFAULT 'INITIATED',
  -- Bounded count of parts the client has been told to upload. Set at
  -- session creation; never mutated. The completion gate compares the
  -- count of VERIFIED parts against this value.
  "expected_part_count"      INTEGER NOT NULL,
  -- Total declared file size in bytes. Bounded by storage policy.
  "expected_total_bytes"     BIGINT,
  -- Optional client-supplied SHA-256 (whole-file hash). Server
  -- compares against the composite manifest hash at completion.
  "expected_sha256"          VARCHAR(64),
  -- Operator-supplied bounded note (e.g. "field upload — building 3").
  "safe_note"                VARCHAR(400),
  -- Idempotency key — clients sending POST /sessions with the same key
  -- collapse to the existing session.
  "idempotency_key"          VARCHAR(120),
  -- Session lifetime bounds. The session is no longer resumable after
  -- expires_at_utc; the upload-reaper marks it EXPIRED on the next pass.
  "expires_at_utc"           TIMESTAMPTZ(6) NOT NULL,
  -- Server-confirmed completion timestamp. NULL until every part is
  -- verified. NEVER set at session creation.
  "completed_at_utc"         TIMESTAMPTZ(6),
  -- Server-recorded abort/expiry timestamps for the audit trail.
  "aborted_at_utc"           TIMESTAMPTZ(6),
  "aborted_by_user_id"       UUID,
  "abort_reason"             VARCHAR(120),
  "created_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "evidence_upload_sessions_state_bounded"
    CHECK ("state" IN (
      'INITIATED', 'UPLOADING', 'VERIFYING', 'COMPLETED',
      'FAILED', 'EXPIRED', 'ABORTED'
    )),
  CONSTRAINT "evidence_upload_sessions_part_count_positive"
    CHECK ("expected_part_count" >= 1 AND "expected_part_count" <= 10000),
  CONSTRAINT "evidence_upload_sessions_total_bytes_nonneg"
    CHECK ("expected_total_bytes" IS NULL OR "expected_total_bytes" >= 0),
  CONSTRAINT "evidence_upload_sessions_sha256_format"
    CHECK ("expected_sha256" IS NULL OR "expected_sha256" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "evidence_upload_sessions_expires_after_created"
    CHECK ("expires_at_utc" > "created_at_utc")
);

-- Workspace-anchored queue: per-team active sessions + last activity.
-- Used by the reaper + operator activity feed.
CREATE INDEX IF NOT EXISTS "evidence_upload_sessions_team_state_idx"
  ON "evidence_upload_sessions" ("team_id", "state", "updated_at_utc" DESC);

-- Per-evidence drilldown — operator opens an evidence record and
-- sees every upload attempt.
CREATE INDEX IF NOT EXISTS "evidence_upload_sessions_team_evidence_idx"
  ON "evidence_upload_sessions" ("team_id", "evidence_id");

-- Idempotency key lookup. Per-team — two different teams may legally
-- pick the same key.
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_upload_sessions_team_idemp_uk"
  ON "evidence_upload_sessions" ("team_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

-- Reaper sweep: find sessions whose expires_at_utc has passed but
-- state is still INITIATED / UPLOADING / VERIFYING.
CREATE INDEX IF NOT EXISTS "evidence_upload_sessions_reaper_idx"
  ON "evidence_upload_sessions" ("expires_at_utc")
  WHERE "state" IN ('INITIATED', 'UPLOADING', 'VERIFYING');

-- ---------------------------------------------------------------------------
-- Per-part state — one row per (session, part_index)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "evidence_upload_session_parts" (
  "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id"               UUID NOT NULL REFERENCES "evidence_upload_sessions"("id") ON DELETE CASCADE,
  "team_id"                  UUID NOT NULL,
  "part_index"               INTEGER NOT NULL,
  "state"                    VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  "expected_bytes"           BIGINT,
  -- Client-claimed SHA-256 (computed in the browser/native client).
  -- Audit-only — the server's HEAD + SHA256 recompute is authoritative.
  "client_sha256"            VARCHAR(64),
  -- Server-confirmed SHA-256 computed after the HEAD verification.
  "server_sha256"            VARCHAR(64),
  -- Client-observed upload completion time. Treated as advisory.
  "uploaded_at_utc_client"   TIMESTAMPTZ(6),
  -- Server-confirmed verification timestamp. AUTHORITATIVE.
  "verified_at_utc"          TIMESTAMPTZ(6),
  -- Per-part retry counter — clients can retry an individual part
  -- without invalidating the rest of the session.
  "retry_count"              INTEGER NOT NULL DEFAULT 0,
  -- Bounded denial reason on terminal failure.
  "failure_reason"           VARCHAR(120),
  "created_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "evidence_upload_session_parts_state_bounded"
    CHECK ("state" IN (
      'PENDING', 'UPLOADED_UNVERIFIED', 'VERIFIED', 'FAILED'
    )),
  CONSTRAINT "evidence_upload_session_parts_part_index_nonneg"
    CHECK ("part_index" >= 0),
  CONSTRAINT "evidence_upload_session_parts_bytes_nonneg"
    CHECK ("expected_bytes" IS NULL OR "expected_bytes" >= 0),
  CONSTRAINT "evidence_upload_session_parts_retry_count_nonneg"
    CHECK ("retry_count" >= 0),
  CONSTRAINT "evidence_upload_session_parts_client_sha_format"
    CHECK ("client_sha256" IS NULL OR "client_sha256" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "evidence_upload_session_parts_server_sha_format"
    CHECK ("server_sha256" IS NULL OR "server_sha256" ~ '^[a-f0-9]{64}$')
);

-- Unique (session, part_index) so a client cannot accidentally create
-- two rows for the same part.
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_upload_session_parts_uk"
  ON "evidence_upload_session_parts" ("session_id", "part_index");

-- Per-team lookups for the activity / reaper.
CREATE INDEX IF NOT EXISTS "evidence_upload_session_parts_team_state_idx"
  ON "evidence_upload_session_parts" ("team_id", "state");

-- Fast "how many parts are still PENDING/UPLOADED_UNVERIFIED" lookup
-- used by the completion gate.
CREATE INDEX IF NOT EXISTS "evidence_upload_session_parts_session_state_idx"
  ON "evidence_upload_session_parts" ("session_id", "state");


-- =========================================================================
-- BLOCK: 2026-05-19-evidence-upload-multipart.sql
-- =========================================================================
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


-- =========================================================================
-- BLOCK: 2026-05-19-evidence-upload-session-bridge.sql
-- =========================================================================
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


-- =========================================================================
-- BLOCK: 2026-05-19-saved-search-views-scope.sql
-- =========================================================================
-- =============================================================================
-- Drift patch — saved_search_views.scope (Phase 25.5 reviewer-ops hardening)
-- =============================================================================
--
-- Symptom this patch fixes:
--   GET /v1/reviewer-ops/saved-views → P2022 (Prisma cannot find the column
--   `scope` in saved_search_views). The reviewer-ops saved-views endpoint
--   raises before reaching any business logic. UI shows the reviewer-ops
--   landing page crashing on saved-view load.
--
-- Root cause:
--   The Phase 25.5 migration `20260602100000_phase25_5_reviewer_ops_hardening`
--   adds the `scope` column to `saved_search_views`, but the Neon production
--   database did not apply it (migration state diverged from code). The
--   Prisma client compiled against the schema then issues queries that
--   project `scope`, and the database rejects them.
--
-- Hard rules for this patch:
--   - PARTIAL-STATE SAFE — every statement must be idempotent. The patch
--     may be applied on a healthy database, on a half-patched database, or
--     on a database where the column has been manually re-added. None of
--     those paths must error.
--   - NO BACKFILL — the column has a non-null default and existing rows
--     should receive the default at write time. We do not touch existing
--     rows.
--   - NO INDEX REBUILDS unless missing.
--   - Wrap in a single transaction so partial application is reverted.
--
-- Operator commands:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f \
--     services/api/sql/drift-patches/2026-05-19-saved-search-views-scope.sql
--
-- After running, hit:
--   GET /admin/runtime/schema-status
-- It should now report `saved_search_views.scope = present`.


-- 1) The Phase 24 base table itself must exist. If it doesn't, this patch
--    is the wrong tool — the operator should run migrations from scratch.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'saved_search_views'
  ) THEN
    RAISE EXCEPTION 'saved_search_views table is missing — run Phase 24 migrations first, not this drift patch';
  END IF;
END$$;

-- 2) Add the `scope` column with the same default that the Phase 25.5
--    migration would have set. IF NOT EXISTS makes this idempotent.
ALTER TABLE "saved_search_views"
  ADD COLUMN IF NOT EXISTS "scope" VARCHAR(24) NOT NULL DEFAULT 'SEARCH';

-- 3) Restore the supporting indexes if they were never created. CREATE
--    INDEX IF NOT EXISTS is idempotent.
CREATE INDEX IF NOT EXISTS saved_search_views_team_scope_idx
  ON "saved_search_views" ("team_id", "scope");

CREATE INDEX IF NOT EXISTS saved_search_views_team_scope_visibility_idx
  ON "saved_search_views" ("team_id", "scope", "visibility");


-- =============================================================================
-- Done. Next steps:
--   1. Re-run the API process so the in-memory Prisma client picks up the
--      new column from the still-cached schema (Prisma is schema-aware at
--      build time, so the client is already expecting the column — the
--      restart is only needed if the API was failing readiness in a loop).
--   2. Confirm via /admin/runtime/schema-status that drift status is HEALTHY.
--   3. Hit GET /v1/reviewer-ops/saved-views and confirm 200.
-- =============================================================================

-- =========================================================================
-- BLOCK: 2026-05-19-search-audit-log.sql
-- =========================================================================
-- =============================================================================
-- Phase 24-J — Search Discovery Audit Log
-- =============================================================================
--
-- Creates `search_audit_logs`: a dedicated, operator-facing audit table
-- for every Discovery / Enterprise Search query the platform runs. The
-- existing Phase 24 search service emits per-row SecurityEvents
-- (eventType=search_executed), which is correct for the SOC stream but
-- not enough for compliance review — operators need a queryable,
-- pageable, retention-bounded log they can open from /ops or from a
-- governance audit surface.
--
-- This patch is PARTIAL-STATE-SAFE + IDEMPOTENT:
--   * `CREATE TABLE IF NOT EXISTS` so re-runs don't error
--   * `CREATE INDEX IF NOT EXISTS` for every index
--   * NO column changes on existing rows. The patch never touches
--     `evidence_search_documents` here — that surface has a separate
--     companion patch.
--
-- Hard rules encoded by the schema:
--   * `query_hash` (varchar(64)) stores a SHA-256 prefix of the raw
--     query text. The raw text is NEVER persisted — the search
--     auditability surface must not become a leak vector for what
--     operators typed.
--   * `surface` (varchar(24)) is an operator-readable label
--     (e.g. "api:/v1/search", "ui:/search").
--   * `filtered_governance_count` + `filtered_visibility_count` are
--     bounded counters: number of rows the governance / visibility
--     gates suppressed in the response. Lets compliance review prove
--     fail-closed behaviour is firing.
--   * `result_count` is the count of rows actually returned.
--
-- Operator command:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f \
--     services/api/sql/drift-patches/2026-05-19-search-audit-log.sql
--
-- After running, hit:
--   GET /admin/runtime/schema-status
-- It should now report `search_audit_logs = present`.


CREATE TABLE IF NOT EXISTS "search_audit_logs" (
  "id"                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id"                       UUID NOT NULL,
  "actor_user_id"                 UUID NOT NULL,
  "surface"                       VARCHAR(24) NOT NULL,
  "query_hash"                    VARCHAR(64),
  "query_length"                  INTEGER NOT NULL DEFAULT 0,
  "document_types"                JSONB,
  "filters_json"                  JSONB,
  "result_count"                  INTEGER NOT NULL DEFAULT 0,
  "filtered_governance_count"     INTEGER NOT NULL DEFAULT 0,
  "filtered_visibility_count"     INTEGER NOT NULL DEFAULT 0,
  "fail_closed"                   BOOLEAN NOT NULL DEFAULT FALSE,
  "request_id"                    VARCHAR(64),
  "ip_hash"                       VARCHAR(64),
  "occurred_at_utc"               TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "search_audit_logs_query_length_nonneg" CHECK ("query_length" >= 0),
  CONSTRAINT "search_audit_logs_result_count_nonneg" CHECK ("result_count" >= 0),
  CONSTRAINT "search_audit_logs_filtered_gov_nonneg" CHECK ("filtered_governance_count" >= 0),
  CONSTRAINT "search_audit_logs_filtered_vis_nonneg" CHECK ("filtered_visibility_count" >= 0)
);

-- Workspace-scoped time-ordered list. Drives /v1/search/audit?teamId=.
CREATE INDEX IF NOT EXISTS "search_audit_logs_team_occurred_idx"
  ON "search_audit_logs" ("team_id", "occurred_at_utc" DESC);

-- Per-actor drill-down for compliance review (who searched, when).
CREATE INDEX IF NOT EXISTS "search_audit_logs_team_actor_idx"
  ON "search_audit_logs" ("team_id", "actor_user_id", "occurred_at_utc" DESC);

-- Operator-side "show me searches that exercised the fail-closed gate"
-- (returned UNKNOWN, blocked governance, blocked visibility).
CREATE INDEX IF NOT EXISTS "search_audit_logs_team_fail_closed_idx"
  ON "search_audit_logs" ("team_id", "fail_closed", "occurred_at_utc" DESC)
  WHERE "fail_closed" = TRUE;


-- =========================================================================
-- BLOCK: 2026-05-19-search-fts-pgvector.sql
-- =========================================================================
-- =============================================================================
-- Phase 24-J — Search FTS + pgvector semantic foundations
-- =============================================================================
--
-- Phase 24 shipped `evidence_search_documents` with `searchable_text`
-- (plain TEXT) + ILIKE-based query. That works for tens of thousands of
-- rows; an enterprise discovery surface needs PostgreSQL FTS (GIN over
-- a tsvector column) so query latency stays bounded as the corpus
-- grows. This patch adds:
--
--   1. A generated `tsv` column derived from
--      `title || subtitle || summary || searchable_text` (English
--      analyzer, weighted by field) — STORED, no row updates needed.
--   2. A GIN index over `tsv` for sub-100ms FTS queries.
--   3. A NULLABLE `embedding` vector column (384 dims) for semantic
--      retrieval foundations. Created only if the pgvector extension
--      is enabled — the patch never errors when pgvector is absent,
--      it just skips the column.
--   4. An IVFFLAT index over `embedding` for approximate nearest
--      neighbour retrieval (also gated on pgvector availability).
--
-- HARD INVARIANTS:
--   * The patch is IDEMPOTENT — every statement uses IF NOT EXISTS or
--     a DO $$ ... $$ guard.
--   * No data is written. Existing rows have their tsv populated by
--     the GENERATED column expression at first read.
--   * No Prisma model change is required for `tsv` — the search service
--     queries it via `$queryRaw`. The Prisma client is unaware of the
--     column, which is fine.
--   * pgvector is OPTIONAL. If the extension is missing, the
--     `embedding` column and IVFFLAT index are skipped silently and
--     the semantic retrieval helper falls back to ILIKE / FTS ranking.
--
-- Operator command:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f \
--     services/api/sql/drift-patches/2026-05-19-search-fts-pgvector.sql


-- ---------------------------------------------------------------------------
-- 1) tsvector generated column + GIN index. The expression weights
--    `title` highest (A), then `subtitle`/`summary` (B), then the body
--    (C). Stored generated column so no trigger or row-update is
--    needed.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'evidence_search_documents'
      AND column_name = 'tsv'
  ) THEN
    ALTER TABLE "evidence_search_documents"
      ADD COLUMN "tsv" tsvector
      GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', COALESCE("title", '')), 'A') ||
        setweight(to_tsvector('simple', COALESCE("subtitle", '')), 'B') ||
        setweight(to_tsvector('simple', COALESCE("summary", '')), 'B') ||
        setweight(to_tsvector('simple', COALESCE("searchable_text", '')), 'C')
      ) STORED;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "evidence_search_documents_tsv_gin"
  ON "evidence_search_documents" USING GIN ("tsv");

-- ---------------------------------------------------------------------------
-- 2) pgvector foundations — OPTIONAL. Gated on extension availability
--    so the patch is a no-op on databases that don't have it.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  has_pgvector BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'vector'
  ) INTO has_pgvector;

  IF has_pgvector THEN
    -- 2a) Add `embedding vector(384)` column if missing.
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'evidence_search_documents'
        AND column_name = 'embedding'
    ) THEN
      EXECUTE 'ALTER TABLE "evidence_search_documents"
               ADD COLUMN "embedding" vector(384)';
    END IF;

    -- 2b) IVFFLAT ANN index over embedding. Skipped silently if it
    -- already exists.
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'evidence_search_documents'
        AND indexname = 'evidence_search_documents_embedding_ivfflat'
    ) THEN
      -- 100 lists is a conservative default for the corpus sizes we
      -- expect; operators can tune it later via REINDEX.
      EXECUTE 'CREATE INDEX "evidence_search_documents_embedding_ivfflat"
               ON "evidence_search_documents"
               USING ivfflat ("embedding" vector_cosine_ops)
               WITH (lists = 100)';
    END IF;
  ELSE
    RAISE NOTICE
      'pgvector extension not present — semantic embedding column and ANN index skipped';
  END IF;
END$$;


-- =============================================================================
-- After running:
--   1. Confirm via SELECT column_name FROM information_schema.columns
--      WHERE table_name = 'evidence_search_documents' AND column_name = 'tsv';
--   2. Confirm GIN index: SELECT indexname FROM pg_indexes
--      WHERE tablename = 'evidence_search_documents';
--   3. The Phase 24 search service automatically picks up the new
--      `tsv` column via $queryRaw FTS path when present (graceful
--      fallback otherwise).
-- =============================================================================

-- =========================================================================
-- BLOCK: 2026-05-19-evidence-ocr-text.sql
-- =========================================================================
-- =============================================================================
-- Phase 24-J — Evidence OCR Text foundations
-- =============================================================================
--
-- Creates `evidence_ocr_text`: a dedicated store for extracted OCR text
-- per evidence item / multipart part. The PROOVRA brief carries a hard
-- "OCR foundations" mandate — the platform must be able to ingest +
-- store OCR output safely so it can later be indexed and searched.
--
-- This patch SHIPS THE SCHEMA ONLY. No OCR engine is wired up. The
-- discovery search service treats the table as a safe text source via
-- $queryRaw — Prisma models will be added in a follow-up regeneration.
--
-- Hard schema rules:
--   * One row per (evidence_id, part_id). `part_id` is nullable when
--     the evidence is single-part.
--   * Text is bounded by chunk and a separate `chunk_index` field so
--     a long document's OCR can be paginated without a single
--     gargantuan row.
--   * The engine identifier is bounded (varchar 40) — we never store
--     model versions / API keys / privileged metadata.
--   * `confidence` is a normalised [0, 1] float so consumers can
--     decide to ignore low-confidence segments.
--   * GOVERNANCE INVARIANT: the visibility scope is denormalised onto
--     this row so the search-document indexer can refuse to surface
--     OCR text from a record under legal hold / contributor-private
--     scope.
--
-- Operator command:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f \
--     services/api/sql/drift-patches/2026-05-19-evidence-ocr-text.sql


CREATE TABLE IF NOT EXISTS "evidence_ocr_text" (
  "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id"                  UUID NOT NULL,
  "evidence_id"              UUID NOT NULL,
  "part_id"                  UUID,
  "chunk_index"              INTEGER NOT NULL DEFAULT 0,
  "engine"                   VARCHAR(40) NOT NULL,
  "language_hint"            VARCHAR(16),
  "text"                     TEXT NOT NULL,
  "confidence"               REAL,
  "visibility_scope"         VARCHAR(24) NOT NULL DEFAULT 'TEAM',
  "redacted"                 BOOLEAN NOT NULL DEFAULT FALSE,
  "indexed_at_utc"           TIMESTAMPTZ(6),
  "extracted_at_utc"         TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "evidence_ocr_text_chunk_index_nonneg"
    CHECK ("chunk_index" >= 0),
  CONSTRAINT "evidence_ocr_text_confidence_range"
    CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1)),
  CONSTRAINT "evidence_ocr_text_visibility_scope_bounded"
    CHECK ("visibility_scope" IN (
      'TEAM', 'REVIEWER_RESTRICTED', 'CONTRIBUTOR_PRIVATE', 'BLOCKED'
    ))
);

-- One OCR row per (evidence_id, part_id, chunk_index) so re-runs of the
-- engine upsert deterministically.
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_ocr_text_uk"
  ON "evidence_ocr_text" ("evidence_id", COALESCE("part_id", '00000000-0000-0000-0000-000000000000'), "chunk_index");

-- Workspace-scoped lookups (the search indexer joins by evidence id +
-- team id; this index supports both).
CREATE INDEX IF NOT EXISTS "evidence_ocr_text_team_evidence_idx"
  ON "evidence_ocr_text" ("team_id", "evidence_id");

-- "Show me OCR rows that the engine wrote but the indexer has not yet
-- consumed". Used by the indexing-lag readiness check.
CREATE INDEX IF NOT EXISTS "evidence_ocr_text_unindexed_idx"
  ON "evidence_ocr_text" ("team_id", "extracted_at_utc" DESC)
  WHERE "indexed_at_utc" IS NULL;


-- =========================================================================
-- BLOCK: 2026-05-19-evidence-transcripts.sql
-- =========================================================================
-- =============================================================================
-- Phase 24-J — Evidence Transcript foundations
-- =============================================================================
--
-- Creates `evidence_transcript_segments`: a dedicated store for
-- per-segment transcripts of audio / video evidence. Each row is a
-- single transcript segment with millisecond start/end offsets so the
-- timeline-discovery surface can deep-link to the exact moment.
--
-- This patch SHIPS THE SCHEMA ONLY. No transcription engine is wired
-- up. The Discovery search service treats this as a safe text source
-- once a row's `redacted = false` AND `visibility_scope <> 'BLOCKED'`.
--
-- Operator command:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f \
--     services/api/sql/drift-patches/2026-05-19-evidence-transcripts.sql


CREATE TABLE IF NOT EXISTS "evidence_transcript_segments" (
  "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id"                  UUID NOT NULL,
  "evidence_id"              UUID NOT NULL,
  "part_id"                  UUID,
  "segment_index"            INTEGER NOT NULL,
  "start_ms"                 INTEGER NOT NULL,
  "end_ms"                   INTEGER NOT NULL,
  "speaker_id"               VARCHAR(64),
  "engine"                   VARCHAR(40) NOT NULL,
  "language_hint"            VARCHAR(16),
  "text"                     TEXT NOT NULL,
  "confidence"               REAL,
  "visibility_scope"         VARCHAR(24) NOT NULL DEFAULT 'TEAM',
  "redacted"                 BOOLEAN NOT NULL DEFAULT FALSE,
  "indexed_at_utc"           TIMESTAMPTZ(6),
  "extracted_at_utc"         TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "evidence_transcript_segments_segment_index_nonneg"
    CHECK ("segment_index" >= 0),
  CONSTRAINT "evidence_transcript_segments_offsets_nonneg"
    CHECK ("start_ms" >= 0 AND "end_ms" >= "start_ms"),
  CONSTRAINT "evidence_transcript_segments_confidence_range"
    CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1)),
  CONSTRAINT "evidence_transcript_segments_visibility_scope_bounded"
    CHECK ("visibility_scope" IN (
      'TEAM', 'REVIEWER_RESTRICTED', 'CONTRIBUTOR_PRIVATE', 'BLOCKED'
    ))
);

-- One segment per (evidence_id, part_id, segment_index).
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_transcript_segments_uk"
  ON "evidence_transcript_segments" (
    "evidence_id",
    COALESCE("part_id", '00000000-0000-0000-0000-000000000000'),
    "segment_index"
  );

-- Workspace-scoped lookups.
CREATE INDEX IF NOT EXISTS "evidence_transcript_segments_team_evidence_idx"
  ON "evidence_transcript_segments" ("team_id", "evidence_id");

-- Indexing-lag readiness check support: segments waiting for the
-- indexer to consume them.
CREATE INDEX IF NOT EXISTS "evidence_transcript_segments_unindexed_idx"
  ON "evidence_transcript_segments" ("team_id", "extracted_at_utc" DESC)
  WHERE "indexed_at_utc" IS NULL;


-- =========================================================================
-- BLOCK: 2026-05-19-external-review-grants.sql
-- =========================================================================
-- =============================================================================
-- Phase 27/28 — External Review Grant persistence
-- =============================================================================
--
-- The Phase 28-E `external-review.ts` shared module shipped the pure
-- state machine + decision logic + privacy projection. This patch adds
-- the storage layer that lets operators actually issue, expire, and
-- revoke external reviewer access grants — the missing link the
-- governance audit named.
--
-- Schema rules encoded here:
--   * Workspace-anchored — every read / write must filter on team_id.
--     Cross-workspace lookups are impossible.
--   * Scope catalog bounded by CHECK: 'EVIDENCE' | 'CASE' | 'PACKAGE'.
--     One of (evidence_id, case_id, package_id) must be set per the
--     scope kind. The CHECK only verifies presence — the service
--     enforces the per-scope cardinality.
--   * State catalog bounded by CHECK: INVITED → ACTIVE → EXPIRED |
--     REVOKED | BLOCKED_BY_POLICY (the shared external-review state
--     machine is the single source of truth for transitions).
--   * Token hash is SHA-256 (varchar 128) — the raw token is never
--     persisted. Token revocation is via state flip + soft-delete
--     timestamp, never via row deletion.
--   * `expires_at_utc` is mandatory and must be in the future at
--     creation; the service enforces.
--   * `access_count` + `last_accessed_at_utc` track usage for the
--     governance audit timeline without exposing the raw review URL.
--   * Audit invariant: every state transition writes an AdminAuditLog
--     row via the service layer (the schema does not enforce; the
--     service does).
--
-- This patch is PARTIAL-STATE-SAFE + IDEMPOTENT:
--   * CREATE TABLE IF NOT EXISTS — re-runs are no-ops.
--   * CREATE INDEX IF NOT EXISTS for every index.
--   * No destructive operations.
--
-- Operator command:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f \
--     services/api/sql/drift-patches/2026-05-19-external-review-grants.sql
--
-- After running, hit:
--   GET /admin/runtime/schema-status
-- Phase 27/28 should now report search_discovery (existing) + the new
-- external_review_grants table present.


CREATE TABLE IF NOT EXISTS "external_review_grants" (
  "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id"                  UUID NOT NULL,
  "scope_kind"               VARCHAR(24) NOT NULL,
  "evidence_id"              UUID,
  "case_id"                  UUID,
  "package_id"               UUID,
  "token_hash"               VARCHAR(128) NOT NULL,
  "reviewer_email"           VARCHAR(320) NOT NULL,
  "reviewer_display_name"    VARCHAR(200),
  "state"                    VARCHAR(24) NOT NULL DEFAULT 'INVITED',
  "invited_by_user_id"       UUID NOT NULL,
  "approved_by_user_id"      UUID,
  "revoked_by_user_id"       UUID,
  "expires_at_utc"           TIMESTAMPTZ(6) NOT NULL,
  "accepted_at_utc"          TIMESTAMPTZ(6),
  "revoked_at_utc"           TIMESTAMPTZ(6),
  "last_accessed_at_utc"     TIMESTAMPTZ(6),
  "access_count"             INTEGER NOT NULL DEFAULT 0,
  "allow_original_download"  BOOLEAN NOT NULL DEFAULT FALSE,
  "allow_package_download"   BOOLEAN NOT NULL DEFAULT TRUE,
  "redaction_policy_version" VARCHAR(32),
  "safe_note"                VARCHAR(500),
  "created_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "external_review_grants_scope_kind_bounded"
    CHECK ("scope_kind" IN ('EVIDENCE', 'CASE', 'PACKAGE')),
  CONSTRAINT "external_review_grants_state_bounded"
    CHECK ("state" IN (
      'INVITED', 'ACTIVE', 'EXPIRED', 'REVOKED', 'BLOCKED_BY_POLICY'
    )),
  CONSTRAINT "external_review_grants_scope_target_present"
    CHECK (
      ("scope_kind" = 'EVIDENCE' AND "evidence_id" IS NOT NULL) OR
      ("scope_kind" = 'CASE' AND "case_id" IS NOT NULL) OR
      ("scope_kind" = 'PACKAGE' AND "package_id" IS NOT NULL)
    ),
  CONSTRAINT "external_review_grants_expires_after_created"
    CHECK ("expires_at_utc" > "created_at_utc"),
  CONSTRAINT "external_review_grants_access_count_nonneg"
    CHECK ("access_count" >= 0)
);

-- Operator queue: per-team, active grants ordered by expiry. Used by
-- the governance dashboard's external review surface.
CREATE INDEX IF NOT EXISTS "external_review_grants_team_state_expires_idx"
  ON "external_review_grants" ("team_id", "state", "expires_at_utc" DESC);

-- Per-evidence drilldown — operator opens an evidence record and sees
-- every external grant attached.
CREATE INDEX IF NOT EXISTS "external_review_grants_team_evidence_idx"
  ON "external_review_grants" ("team_id", "evidence_id")
  WHERE "evidence_id" IS NOT NULL;

-- Per-case drilldown.
CREATE INDEX IF NOT EXISTS "external_review_grants_team_case_idx"
  ON "external_review_grants" ("team_id", "case_id")
  WHERE "case_id" IS NOT NULL;

-- Token lookup — unique because two grants with the same token would
-- be a security incident.
CREATE UNIQUE INDEX IF NOT EXISTS "external_review_grants_token_hash_uk"
  ON "external_review_grants" ("token_hash");

-- Operator drilldown by invited reviewer email.
CREATE INDEX IF NOT EXISTS "external_review_grants_team_reviewer_idx"
  ON "external_review_grants" ("team_id", "reviewer_email");

-- Expiry sweeper — find grants whose expires_at_utc has passed but
-- whose state is still INVITED/ACTIVE. Used by the reconciliation
-- worker.
CREATE INDEX IF NOT EXISTS "external_review_grants_expiry_sweep_idx"
  ON "external_review_grants" ("expires_at_utc")
  WHERE "state" IN ('INVITED', 'ACTIVE');


-- =========================================================================
-- BLOCK: 2026-05-20-media-intelligence-runs.sql
-- =========================================================================
-- =============================================================================
-- Phase 31.5 — Media intelligence run tracker
-- =============================================================================
--
-- Tracks each invocation of the media-intelligence analyzer for an
-- evidence row. The Phase 31 analyzer was synchronous + stateless —
-- this table adds enterprise lifecycle bookkeeping:
--
--   * Idempotency: re-running the analyzer for the same evidence
--     observes the existing PENDING / PROCESSING row and either
--     returns it or coalesces.
--   * Bounded retry: `attempt_count` capped at 5 (CHECK constraint).
--     After that the row sits in FAILED until a reviewer manually
--     re-runs (which creates a NEW run with a NEW idempotency key).
--   * Observability: every state transition is timestamped + a
--     bounded `last_error` captures the most recent failure reason.
--   * Non-blocking: this table never gates evidence finalize. The
--     analyzer is advisory; failed runs sit in FAILED indefinitely
--     and the evidence lifecycle continues.
--
-- Hard custody rules:
--   * `status` bounded to PENDING / PROCESSING / COMPLETED / FAILED /
--     DISMISSED. Mirrors the existing intelligence-job vocabulary.
--   * `kind` bounded to the analyzer job catalog.
--   * `last_error` bounded to 400 chars — no free-text leak of stack
--     traces or storage paths.
--   * No raw GPS, no private notes, no storage_key in any column.
--
-- IDEMPOTENT: CREATE TABLE / INDEX IF NOT EXISTS.


CREATE TABLE IF NOT EXISTS "media_intelligence_runs" (
  "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id"                  UUID NOT NULL,
  "evidence_id"              UUID NOT NULL,
  -- The job kind. Maps to one of the brief's 7 analyzer jobs.
  -- Catalogued in service layer; CHECK constraint here bounds it.
  "kind"                     VARCHAR(48) NOT NULL,
  "status"                   VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  "attempt_count"            INTEGER NOT NULL DEFAULT 0,
  -- Idempotency key. When the analyzer is invoked via reconcile or
  -- on-finalize, the caller passes a deterministic key like
  -- `analyze:{evidenceId}`. Duplicate POSTs return the existing row.
  "idempotency_key"          VARCHAR(120),
  -- Operator-readable error summary. NEVER stores stack traces or
  -- storage paths. Bounded.
  "last_error"               VARCHAR(400),
  "engine_version"           VARCHAR(48) NOT NULL DEFAULT 'phase31-v1',
  "scheduled_at_utc"         TIMESTAMPTZ(6),
  "started_at_utc"           TIMESTAMPTZ(6),
  "completed_at_utc"         TIMESTAMPTZ(6),
  "created_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "media_intelligence_runs_kind_bounded"
    CHECK ("kind" IN (
      'analyze_metadata',
      'extract_assets',
      'compute_duplicates',
      'compute_lineage',
      'wire_ocr_transcript',
      'reindex',
      'reconcile'
    )),
  CONSTRAINT "media_intelligence_runs_status_bounded"
    CHECK ("status" IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'DISMISSED')),
  CONSTRAINT "media_intelligence_runs_attempt_bounded"
    CHECK ("attempt_count" >= 0 AND "attempt_count" <= 5)
);

-- Idempotency: per-team unique idempotency key when present.
CREATE UNIQUE INDEX IF NOT EXISTS "media_intelligence_runs_team_idemp_uk"
  ON "media_intelligence_runs" ("team_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

-- Operator activity feed.
CREATE INDEX IF NOT EXISTS "media_intelligence_runs_team_status_idx"
  ON "media_intelligence_runs" ("team_id", "status", "updated_at_utc" DESC);

-- Per-evidence drilldown.
CREATE INDEX IF NOT EXISTS "media_intelligence_runs_evidence_idx"
  ON "media_intelligence_runs" ("evidence_id", "kind", "status");

-- Backlog / reconciliation: which PENDING runs need picking up?
CREATE INDEX IF NOT EXISTS "media_intelligence_runs_pending_idx"
  ON "media_intelligence_runs" ("scheduled_at_utc")
  WHERE "status" = 'PENDING';


-- =========================================================================
-- BLOCK: 2026-05-20-media-intelligence-signals.sql
-- =========================================================================
-- =============================================================================
-- Phase 31 — Media intelligence signals (read-only advisory layer)
-- =============================================================================
--
-- Single table that stores DETERMINISTIC advisory signals computed
-- by the Phase 31 analyzer service. The signals are NEVER:
--   * truth/authenticity/admissibility claims
--   * identity / face-recognition outputs
--   * manipulation conclusions
--   * legal determinations
--
-- They are bounded, explainable advisory notes — operator-visible
-- hints for reviewers, surfaced via the read API + future UI
-- panels. Custody / finalize / report flows NEVER block on these.
--
-- Hard custody rules encoded in the schema:
--   * `signal_type` is bounded by CHECK constraint matching the
--     service-layer SIGNAL_TYPES catalog exactly. Adding a type
--     requires both this constraint and a code change.
--   * `severity` ∈ {INFO, REVIEW_RECOMMENDED, ATTENTION}. The
--     vocabulary deliberately avoids "WARNING" / "CRITICAL" /
--     "ALERT" to keep tone advisory.
--   * `confidence` ∈ {LOW, MEDIUM, HIGH}. Bounded; analyzer
--     callers set this based on the strength of the underlying
--     deterministic check.
--   * `safe_summary` is bounded to 240 chars. The wording is
--     enforced by the service layer's safe-wording library — the
--     DB just bounds length.
--   * `status` tracks the operator-acknowledgement lifecycle
--     (PENDING → ACKNOWLEDGED, or PENDING → DISMISSED).
--   * `technical_details_json` is a bounded JSONB blob for
--     internal-only diagnostic state. Never exposed to public
--     verify / external reviewer surfaces. The route layer that
--     reads this table is responsible for projection.
--
-- Idempotency: re-running the analyzer for the same evidence
-- emits the same signals. The unique index on
--   (evidence_id, material_id, signal_type)
-- ensures retries don't create duplicate rows. The analyzer uses
-- ON CONFLICT to update `safe_summary` + `technical_details_json`
-- without resetting acknowledged status.
--
-- The patch is IDEMPOTENT + PARTIAL-STATE-SAFE:
--   * CREATE TABLE IF NOT EXISTS.
--   * CREATE INDEX IF NOT EXISTS.
--   * No destructive operations.
--
-- Operator command:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f \
--     services/api/sql/drift-patches/2026-05-20-media-intelligence-signals.sql


CREATE TABLE IF NOT EXISTS "media_intelligence_signals" (
  "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id"                  UUID NOT NULL,
  "evidence_id"              UUID NOT NULL,
  -- NULL when the signal applies to the whole Evidence (e.g.
  -- DUPLICATE_HASH_MATCH against another Evidence). Non-NULL when
  -- the signal is tied to a specific EvidencePart.
  "material_id"              UUID,
  "signal_type"              VARCHAR(48) NOT NULL,
  "severity"                 VARCHAR(24) NOT NULL DEFAULT 'INFO',
  "confidence"               VARCHAR(16) NOT NULL DEFAULT 'MEDIUM',
  -- Operator-readable summary. Bounded to 240 chars. The service-
  -- layer SafeWording library produces these from a closed set of
  -- templates so the tone stays advisory.
  "safe_summary"             VARCHAR(240) NOT NULL,
  -- Internal diagnostic JSON. Never exposed via public verify or
  -- external reviewer surfaces. Operator UI may render selected
  -- safe fields.
  "technical_details_json"   JSONB,
  -- Lifecycle: PENDING (default), ACKNOWLEDGED (reviewer marked
  -- as understood / not concerning), DISMISSED (reviewer marked
  -- as not actionable). No state for "confirmed manipulation" or
  -- similar — those determinations are out of platform scope.
  "status"                   VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  "acknowledged_by_user_id"  UUID,
  "acknowledged_at_utc"      TIMESTAMPTZ(6),
  "engine_version"           VARCHAR(48) NOT NULL DEFAULT 'phase31-v1',
  "created_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "media_intelligence_signals_signal_type_bounded"
    CHECK ("signal_type" IN (
      'EXIF_MISSING',
      'EXIF_TIMESTAMP_MISMATCH',
      'CLIENT_SERVER_TIME_GAP',
      'MIME_EXTENSION_MISMATCH',
      'CODEC_CONTAINER_OBSERVATION',
      'SCREENSHOT_LIKE_FILENAME',
      'DUPLICATE_HASH_MATCH',
      'SIMILAR_FILE_CANDIDATE',
      'POSSIBLE_DERIVATIVE_FILE',
      'TRANSCODING_LINEAGE_CANDIDATE',
      'AUDIO_METADATA_OBSERVATION',
      'VIDEO_DURATION_OBSERVATION',
      'FRAME_EXTRACTION_AVAILABLE',
      'THUMBNAIL_AVAILABLE',
      'OCR_AVAILABLE',
      'TRANSCRIPT_AVAILABLE'
    )),
  CONSTRAINT "media_intelligence_signals_severity_bounded"
    CHECK ("severity" IN ('INFO', 'REVIEW_RECOMMENDED', 'ATTENTION')),
  CONSTRAINT "media_intelligence_signals_confidence_bounded"
    CHECK ("confidence" IN ('LOW', 'MEDIUM', 'HIGH')),
  CONSTRAINT "media_intelligence_signals_status_bounded"
    CHECK ("status" IN ('PENDING', 'ACKNOWLEDGED', 'DISMISSED'))
);

-- Idempotency: re-runs of the analyzer upsert into the same
-- (evidence_id, material_id, signal_type) tuple. NULL material_id
-- needs special handling because PG treats NULLs as distinct in
-- unique indexes — we use COALESCE on a sentinel UUID for the
-- partial index.
CREATE UNIQUE INDEX IF NOT EXISTS "media_intelligence_signals_evidence_material_type_uk"
  ON "media_intelligence_signals" (
    "evidence_id",
    COALESCE("material_id", '00000000-0000-0000-0000-000000000000'::uuid),
    "signal_type"
  );

-- Per-team activity feed: "what intelligence has been generated
-- for my workspace recently?"
CREATE INDEX IF NOT EXISTS "media_intelligence_signals_team_status_idx"
  ON "media_intelligence_signals" ("team_id", "status", "updated_at_utc" DESC);

-- Per-evidence drilldown: "all signals for this evidence record."
CREATE INDEX IF NOT EXISTS "media_intelligence_signals_evidence_severity_idx"
  ON "media_intelligence_signals" ("evidence_id", "severity");

-- Operator queue: "which PENDING signals need triage?"
CREATE INDEX IF NOT EXISTS "media_intelligence_signals_pending_idx"
  ON "media_intelligence_signals" ("team_id", "created_at_utc" DESC)
  WHERE "status" = 'PENDING';


-- =========================================================================
-- BLOCK: 2026-05-20-evidence-part-exif-summaries.sql
-- =========================================================================
-- =============================================================================
-- Phase 31.8 — Bounded per-EvidencePart EXIF summary persistence
-- =============================================================================
--
-- Adds the persistence layer for the EXIF extractor library shipped in
-- Phase 31.7. The extractor itself is a pure function over byte input
-- (see `services/api/src/services/media-intelligence/exif-extractor.service.ts`);
-- this table records the BOUNDED projection produced by the worker
-- after a successful S3 fetch + parse.
--
-- Hard custody / privacy rules:
--   * One row per (team_id, evidence_part_id). Re-running the
--     extractor UPDATES the row in place (idempotent).
--   * Raw GPS is NEVER stored. We persist only `has_gps` (boolean).
--     Operators with explicit policy approval can re-extract with
--     `allow_raw_gps` at runtime; the persistence layer refuses to
--     keep it.
--   * Strings bounded: camera_make / camera_model / software each
--     VARCHAR(64), matching the extractor's STRING_FIELD_MAX.
--   * Date fields are TIMESTAMPTZ — exifr returns Date objects which
--     the extractor reproduces as ISO UTC.
--   * dimensions bounded by smallint range; orientation 1..8 per
--     EXIF spec.
--   * exifr_engine_version captured so a future format change can be
--     reasoned about without re-deriving from raw bytes.
--   * status / error bounded so failed extractions don't pollute
--     operator surfaces.
--
-- Anti-leak: NO storage_key, NO storage_bucket, NO multipart_upload_id,
-- NO signed_url. The evidence_part_id link is the only join key.
--
-- Side change: the existing `media_intelligence_runs_kind_bounded`
-- CHECK is widened to include `extract_exif` so the existing run-
-- tracker can record EXIF extraction lifecycle alongside the other 7
-- analyzer kinds. Backward-compatible: previous values stay valid.
--
-- IDEMPOTENT: CREATE TABLE / INDEX IF NOT EXISTS. The CHECK swap is
-- done by DROP + ADD inside the transaction so a partial application
-- never leaves the constraint with an inconsistent vocabulary.
--
-- Neon (or any PostgreSQL) application command:
--   psql "$DATABASE_URL" \
--     -f services/api/sql/drift-patches/2026-05-20-evidence-part-exif-summaries.sql


-- -----------------------------------------------------------------------------
-- 1. Widen the runs CHECK to include extract_exif
-- -----------------------------------------------------------------------------

ALTER TABLE "media_intelligence_runs"
  DROP CONSTRAINT IF EXISTS "media_intelligence_runs_kind_bounded";

ALTER TABLE "media_intelligence_runs"
  ADD CONSTRAINT "media_intelligence_runs_kind_bounded"
  CHECK ("kind" IN (
    'analyze_metadata',
    'extract_exif',
    'extract_assets',
    'compute_duplicates',
    'compute_lineage',
    'wire_ocr_transcript',
    'reindex',
    'reconcile'
  ));

-- -----------------------------------------------------------------------------
-- 1b. Widen the signals CHECK to include DEVICE_METADATA_OBSERVATION
-- -----------------------------------------------------------------------------
--
-- The Phase 31.8 analyzer emits this signal when the real EXIF
-- extractor recorded at least one bounded device field (make /
-- model / dimensions / software). NEVER classifies the device.

ALTER TABLE "media_intelligence_signals"
  DROP CONSTRAINT IF EXISTS "media_intelligence_signals_signal_type_bounded";

ALTER TABLE "media_intelligence_signals"
  ADD CONSTRAINT "media_intelligence_signals_signal_type_bounded"
  CHECK ("signal_type" IN (
    'EXIF_MISSING',
    'EXIF_TIMESTAMP_MISMATCH',
    'CLIENT_SERVER_TIME_GAP',
    'MIME_EXTENSION_MISMATCH',
    'CODEC_CONTAINER_OBSERVATION',
    'SCREENSHOT_LIKE_FILENAME',
    'DUPLICATE_HASH_MATCH',
    'SIMILAR_FILE_CANDIDATE',
    'POSSIBLE_DERIVATIVE_FILE',
    'TRANSCODING_LINEAGE_CANDIDATE',
    'AUDIO_METADATA_OBSERVATION',
    'VIDEO_DURATION_OBSERVATION',
    'FRAME_EXTRACTION_AVAILABLE',
    'THUMBNAIL_AVAILABLE',
    'OCR_AVAILABLE',
    'TRANSCRIPT_AVAILABLE',
    'DEVICE_METADATA_OBSERVATION'
  ));

-- -----------------------------------------------------------------------------
-- 2. EXIF summary table
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "evidence_part_exif_summaries" (
  "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id"                  UUID NOT NULL,
  "evidence_id"              UUID NOT NULL,
  "evidence_part_id"         UUID NOT NULL,

  -- High-level signal: did the parser find ANY recognised EXIF tag?
  -- false === no EXIF (e.g. PNG without tEXt blocks, or stripped).
  "exif_present"             BOOLEAN NOT NULL DEFAULT FALSE,

  -- Bounded time fields. exifr surfaces these as Date objects. We
  -- persist as TZ-aware timestamptz — the extractor documents that
  -- DateTimeOriginal is naive-local in the EXIF spec and surfaces a
  -- best-effort ISO. Downstream consumers know to interpret with
  -- care; the SAFE_SUMMARY library carries the wording.
  "date_time_original_utc"   TIMESTAMPTZ(6),
  "create_date_utc"          TIMESTAMPTZ(6),

  -- Image dimensions. NULL if the parser couldn't extract them.
  "image_width_px"           INTEGER,
  "image_height_px"          INTEGER,

  -- Device metadata. NULL when missing / rejected by sanitisation.
  -- Bounded to 64 chars — matches the extractor's
  -- STRING_FIELD_MAX constant.
  "camera_make"              VARCHAR(64),
  "camera_model"             VARCHAR(64),
  "software"                 VARCHAR(64),

  -- GPS presence flag only. Raw coordinates NEVER stored. A future
  -- policy layer that wants to expose raw GPS will need to either
  -- (a) re-extract on demand with `allow_raw_gps: true`, or (b)
  -- add a separate, RBAC-gated column. We deliberately keep this
  -- table redaction-safe by default.
  "has_gps"                  BOOLEAN NOT NULL DEFAULT FALSE,

  -- EXIF orientation flag (1..8) per the EXIF spec. NULL when
  -- absent.
  "orientation"              SMALLINT,

  -- Provenance + lifecycle.
  "engine_version"           VARCHAR(48) NOT NULL DEFAULT 'exifr-v7-phase31-v1',
  "extracted_at_utc"         TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "extracted_bytes"          INTEGER NOT NULL DEFAULT 0,

  -- Operator-readable status. Useful when the extractor refused
  -- the bytes (e.g. parse_failed, input_too_large).
  "status"                   VARCHAR(24) NOT NULL DEFAULT 'OK',
  "last_error"               VARCHAR(240),

  "created_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "evidence_part_exif_summaries_dim_w_bounded"
    CHECK ("image_width_px" IS NULL OR ("image_width_px" > 0 AND "image_width_px" <= 200000)),
  CONSTRAINT "evidence_part_exif_summaries_dim_h_bounded"
    CHECK ("image_height_px" IS NULL OR ("image_height_px" > 0 AND "image_height_px" <= 200000)),
  CONSTRAINT "evidence_part_exif_summaries_orientation_bounded"
    CHECK ("orientation" IS NULL OR ("orientation" >= 1 AND "orientation" <= 8)),
  CONSTRAINT "evidence_part_exif_summaries_status_bounded"
    CHECK ("status" IN (
      'OK',
      'PARSE_FAILED',
      'UNSUPPORTED_FORMAT',
      'INPUT_TOO_LARGE',
      'EMPTY_INPUT',
      'FETCH_FAILED'
    ))
);

-- One row per (team, evidence_part). Per-team unique so cross-tenant
-- enumeration is impossible at the index layer; the evidence_part_id
-- is globally unique but we anchor on team for defence in depth.
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_part_exif_summaries_team_part_uk"
  ON "evidence_part_exif_summaries" ("team_id", "evidence_part_id");

-- Per-evidence lookup (used by the analyzer).
CREATE INDEX IF NOT EXISTS "evidence_part_exif_summaries_evidence_idx"
  ON "evidence_part_exif_summaries" ("evidence_id");

-- Operator backlog visibility.
CREATE INDEX IF NOT EXISTS "evidence_part_exif_summaries_status_updated_idx"
  ON "evidence_part_exif_summaries" ("status", "updated_at_utc" DESC);


-- =========================================================================
-- BLOCK: 2026-05-20-evidence-part-derived-assets.sql
-- =========================================================================
-- =============================================================================
-- Phase 31.13 — Derived assets pipeline persistence
-- =============================================================================
--
-- Persists the bounded record for derived media artifacts (image
-- thumbnails this session; representative video frames + audio
-- waveforms when ffmpeg is added in a future phase).
--
-- Hard custody / privacy rules:
--
--   * Derived assets NEVER replace originals. The original
--     `evidence_parts` row is unchanged. The derived bytes are
--     stored in a separate S3 prefix with their own SHA-256.
--   * One row per (team_id, evidence_part_id, asset_kind) — a
--     given part can have multiple derived kinds (e.g. an
--     image_thumbnail and a future low_res_proxy), but only one
--     entry per kind. Re-running the worker UPDATES the existing
--     row.
--   * Bounded status enum so failures are auditable + bounded
--     last_error so stack traces / storage paths cannot leak.
--   * `derived_sha256` is the SHA-256 of the DERIVED bytes — NOT
--     the source. The source linkage lives in
--     `source_sha256_at_generation` which records the source
--     hash AT THE MOMENT the derived asset was generated, so
--     downstream consumers can verify the source has not been
--     mutated since (cross-checking against the canonical
--     `evidence_parts.sha256`).
--   * Storage internals (bucket, key) ARE persisted here because
--     the worker needs them to serve the bytes back. They are
--     NEVER projected to any API response — the read endpoint
--     emits ONLY `id`, `assetKind`, `derivedSha256`, `sizeBytes`,
--     `widthPx`, `heightPx`, `contentType`, `status`,
--     `generatedAtUtc` (and an opaque signed download token only
--     when the caller has explicit access).
--
-- IDEMPOTENT: CREATE TABLE / INDEX IF NOT EXISTS.
--
-- Apply with:
--   psql "$DATABASE_URL" \
--     -f services/api/sql/drift-patches/2026-05-20-evidence-part-derived-assets.sql
--
-- Rollback:
--   DROP TABLE IF EXISTS "evidence_part_derived_assets";


CREATE TABLE IF NOT EXISTS "evidence_part_derived_assets" (
  "id"                                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id"                           UUID NOT NULL,
  "evidence_id"                       UUID NOT NULL,
  "evidence_part_id"                  UUID NOT NULL,

  -- Bounded asset kind.
  -- image_thumbnail        — small image preview (this phase, via sharp)
  -- video_frame            — representative video frame (future, via ffmpeg)
  -- audio_waveform         — waveform image preview (future, via ffmpeg)
  -- low_res_proxy          — full-asset low-resolution proxy (future)
  -- compact_review_preview — compact reviewer-facing preview (future)
  "asset_kind"                        VARCHAR(48) NOT NULL,

  -- Bounded lifecycle status.
  -- PENDING      — row created; worker not yet started
  -- PROCESSING   — worker has the job
  -- COMPLETED    — bytes generated + stored
  -- FAILED       — worker tried + gave up (last_error carries reason)
  -- UNSUPPORTED  — capability detection refused (no sharp/ffmpeg)
  "status"                            VARCHAR(24) NOT NULL DEFAULT 'PENDING',

  -- Derived bytes provenance.
  "derived_sha256"                    VARCHAR(64),
  "size_bytes"                        INTEGER,
  "content_type"                      VARCHAR(80),
  "width_px"                          INTEGER,
  "height_px"                         INTEGER,

  -- Source linkage. The source hash AT THE MOMENT the derived
  -- asset was generated. Lets downstream consumers verify the
  -- source has not been mutated since (they cross-check against
  -- the canonical evidence_parts.sha256).
  "source_sha256_at_generation"       VARCHAR(64),

  -- Storage reference — INTERNAL USE ONLY. Never projected to
  -- any API response. The read API serves the bytes via the
  -- bounded download endpoint (with auth checks) that reads
  -- these columns internally.
  "storage_bucket"                    VARCHAR(255),
  "storage_key"                       VARCHAR(512),

  -- Bounded error summary for failed generations.
  "last_error"                        VARCHAR(240),

  -- Provenance.
  "engine_version"                    VARCHAR(48) NOT NULL DEFAULT 'sharp-v0-phase31-v1',
  "generated_at_utc"                  TIMESTAMPTZ(6),
  "created_at_utc"                    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at_utc"                    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "evidence_part_derived_assets_kind_bounded"
    CHECK ("asset_kind" IN (
      'image_thumbnail',
      'video_frame',
      'audio_waveform',
      'low_res_proxy',
      'compact_review_preview'
    )),
  CONSTRAINT "evidence_part_derived_assets_status_bounded"
    CHECK ("status" IN (
      'PENDING',
      'PROCESSING',
      'COMPLETED',
      'FAILED',
      'UNSUPPORTED'
    )),
  CONSTRAINT "evidence_part_derived_assets_dim_w_bounded"
    CHECK ("width_px" IS NULL OR ("width_px" > 0 AND "width_px" <= 200000)),
  CONSTRAINT "evidence_part_derived_assets_dim_h_bounded"
    CHECK ("height_px" IS NULL OR ("height_px" > 0 AND "height_px" <= 200000)),
  CONSTRAINT "evidence_part_derived_assets_size_bounded"
    CHECK ("size_bytes" IS NULL OR ("size_bytes" >= 0 AND "size_bytes" <= 50000000))
);

-- One row per (team, part, kind). Re-running the worker upserts.
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_part_derived_assets_team_part_kind_uk"
  ON "evidence_part_derived_assets" ("team_id", "evidence_part_id", "asset_kind");

-- Per-evidence drilldown.
CREATE INDEX IF NOT EXISTS "evidence_part_derived_assets_evidence_idx"
  ON "evidence_part_derived_assets" ("evidence_id");

-- Operator backlog visibility — failures + pending lookups.
CREATE INDEX IF NOT EXISTS "evidence_part_derived_assets_status_updated_idx"
  ON "evidence_part_derived_assets" ("status", "updated_at_utc" DESC);


-- =========================================================================
-- BLOCK: 2026-05-20-investigation-graph.sql
-- =========================================================================
-- =============================================================================
-- Phase 32 — Investigation graph data model
-- =============================================================================
--
-- Three tables:
--
--   * investigation_graph_nodes — one row per logical entity in the
--     investigation graph. Most node kinds project from existing
--     domain rows (EVIDENCE → Evidence row, CASE → Case row, etc.);
--     the graph table carries only the projection + visibility
--     metadata. USER_CREATED_ENTITY is the one exception that has
--     no upstream — operators create it via the manual-relationship
--     UI.
--
--   * investigation_graph_edges — directed edges between nodes,
--     with bounded edge_type vocabulary and team-anchored scope.
--     System-built edges have `source_kind = 'SYSTEM'`; user-built
--     edges have `source_kind = 'MANUAL'`.
--
--   * manual_relationships — separate, write-side log of operator-
--     created relationships. Audit trail. Source of truth for
--     MANUALLY_LINKED_TO edges in the graph_edges table.
--
-- Hard rules encoded here:
--   * Every table is team_id-anchored. No cross-team graph traversal
--     is possible at the schema level — the API layer enforces
--     visibility on top.
--   * Edge type / node type are CHECK-bounded against the catalog.
--   * Confidence bounded LOW / MEDIUM / HIGH (matches the rest of
--     the platform's vocabulary).
--   * stale_at_utc lets the reconciliation worker mark edges
--     inactive without deleting them (preserves audit trail).
--   * No raw GPS, no storage_key, no signed URLs in any column.
--
-- IDEMPOTENT.


-- ---------------------------------------------------------------------------
-- Nodes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "investigation_graph_nodes" (
  "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id"                  UUID NOT NULL,
  -- Bounded node-kind vocabulary. Catalogued in service layer.
  "node_kind"                VARCHAR(32) NOT NULL,
  -- Reference to the upstream entity. For EVIDENCE/CASE/REVIEW_TASK/
  -- etc., this is the source row's UUID. For USER_CREATED_ENTITY,
  -- this is the manual-relationship row id.
  "external_id"              UUID NOT NULL,
  -- Operator-facing label. Bounded. Never includes private notes,
  -- legal notes, or raw evidence content.
  "safe_label"               VARCHAR(240),
  -- Visibility scope. Bounded. Drives the API's visibility filter.
  "visibility_scope"         VARCHAR(32) NOT NULL DEFAULT 'WORKSPACE_INTERNAL',
  -- Soft-delete: when set, the API hides the node + every edge
  -- touching it. Used by the reconciliation worker to tombstone
  -- nodes whose upstream row was destroyed / hidden by legal hold.
  "stale_at_utc"             TIMESTAMPTZ(6),
  "created_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "investigation_graph_nodes_kind_bounded"
    CHECK ("node_kind" IN (
      'EVIDENCE',
      'CASE',
      'INCIDENT',
      'REVIEW_TASK',
      'ESCALATION',
      'LEGAL_HOLD',
      'EXPORT',
      'REPORT',
      'VERIFICATION_PACKAGE',
      'MEDIA_SIGNAL',
      'OCR',
      'TRANSCRIPT',
      'EXTERNAL_REVIEW',
      'USER_CREATED_ENTITY'
    )),
  CONSTRAINT "investigation_graph_nodes_visibility_bounded"
    CHECK ("visibility_scope" IN (
      'WORKSPACE_INTERNAL',
      'REVIEWER_RESTRICTED',
      'EXTERNAL_REVIEWER_SCOPED',
      'PUBLIC_VERIFY_SAFE'
    ))
);

-- Unique per-team (kind, external_id) so the graph builder can
-- upsert idempotently.
CREATE UNIQUE INDEX IF NOT EXISTS "investigation_graph_nodes_team_kind_ext_uk"
  ON "investigation_graph_nodes" ("team_id", "node_kind", "external_id");

CREATE INDEX IF NOT EXISTS "investigation_graph_nodes_team_kind_idx"
  ON "investigation_graph_nodes" ("team_id", "node_kind")
  WHERE "stale_at_utc" IS NULL;

-- ---------------------------------------------------------------------------
-- Edges
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "investigation_graph_edges" (
  "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id"                  UUID NOT NULL,
  "source_node_id"           UUID NOT NULL REFERENCES "investigation_graph_nodes"("id") ON DELETE CASCADE,
  "target_node_id"           UUID NOT NULL REFERENCES "investigation_graph_nodes"("id") ON DELETE CASCADE,
  -- Bounded edge-type vocabulary.
  "edge_type"                VARCHAR(48) NOT NULL,
  -- 'SYSTEM' for builder-produced edges, 'MANUAL' for operator-
  -- created edges. Source distinction matters for the visibility
  -- + acknowledgement UX.
  "source_kind"              VARCHAR(16) NOT NULL DEFAULT 'SYSTEM',
  "confidence"               VARCHAR(16) NOT NULL DEFAULT 'MEDIUM',
  -- Operator-readable summary. Bounded. Safe-wording-library
  -- enforced at the service layer.
  "safe_summary"             VARCHAR(240),
  "created_by_user_id"       UUID,
  "stale_at_utc"             TIMESTAMPTZ(6),
  "created_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "investigation_graph_edges_type_bounded"
    CHECK ("edge_type" IN (
      'BELONGS_TO_CASE',
      'CAPTURED_IN_SESSION',
      'SAME_HASH_AS',
      'SIMILAR_TO',
      'POSSIBLE_DERIVATIVE_OF',
      'REFERENCES_SAME_INCIDENT',
      'REVIEWED_BY',
      'ESCALATED_FROM',
      'BLOCKED_BY_LEGAL_HOLD',
      'EXPORTED_AS',
      'GENERATED_REPORT',
      'GENERATED_PACKAGE',
      'HAS_MEDIA_SIGNAL',
      'HAS_TRANSCRIPT',
      'HAS_OCR',
      'MANUALLY_LINKED_TO'
    )),
  CONSTRAINT "investigation_graph_edges_source_kind_bounded"
    CHECK ("source_kind" IN ('SYSTEM', 'MANUAL')),
  CONSTRAINT "investigation_graph_edges_confidence_bounded"
    CHECK ("confidence" IN ('LOW', 'MEDIUM', 'HIGH'))
);

-- Upsert key: per-team unique (source, target, edge_type).
CREATE UNIQUE INDEX IF NOT EXISTS "investigation_graph_edges_team_triple_uk"
  ON "investigation_graph_edges" ("team_id", "source_node_id", "target_node_id", "edge_type");

-- Outgoing traversal: "given a node, what are its outbound edges?"
CREATE INDEX IF NOT EXISTS "investigation_graph_edges_outbound_idx"
  ON "investigation_graph_edges" ("team_id", "source_node_id", "edge_type")
  WHERE "stale_at_utc" IS NULL;

-- Incoming traversal.
CREATE INDEX IF NOT EXISTS "investigation_graph_edges_inbound_idx"
  ON "investigation_graph_edges" ("team_id", "target_node_id", "edge_type")
  WHERE "stale_at_utc" IS NULL;

-- ---------------------------------------------------------------------------
-- Manual relationships (audit log)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "manual_relationships" (
  "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id"                  UUID NOT NULL,
  "source_node_id"           UUID NOT NULL REFERENCES "investigation_graph_nodes"("id") ON DELETE CASCADE,
  "target_node_id"           UUID NOT NULL REFERENCES "investigation_graph_nodes"("id") ON DELETE CASCADE,
  "edge_type"                VARCHAR(48) NOT NULL,
  "created_by_user_id"       UUID NOT NULL,
  -- Operator note. Bounded. Audit-only; never indexed by search.
  "safe_note"                VARCHAR(400),
  -- Lifecycle: ACTIVE while the relationship stands; RETRACTED
  -- when an operator removes it (we keep the row for audit).
  "status"                   VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  "retracted_by_user_id"     UUID,
  "retracted_at_utc"         TIMESTAMPTZ(6),
  "retraction_reason"        VARCHAR(240),
  "created_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "manual_relationships_edge_type_bounded"
    CHECK ("edge_type" IN (
      'REFERENCES_SAME_INCIDENT',
      'MANUALLY_LINKED_TO'
    )),
  CONSTRAINT "manual_relationships_status_bounded"
    CHECK ("status" IN ('ACTIVE', 'RETRACTED'))
);

CREATE INDEX IF NOT EXISTS "manual_relationships_team_status_idx"
  ON "manual_relationships" ("team_id", "status", "created_at_utc" DESC);

CREATE INDEX IF NOT EXISTS "manual_relationships_source_target_idx"
  ON "manual_relationships" ("team_id", "source_node_id", "target_node_id");


-- =========================================================================
-- BLOCK: 2026-05-20-ocr-transcript-indexed-signals.sql
-- =========================================================================
-- =============================================================================
-- Phase 31.20 — widen media_intelligence_signals.signal_type CHECK to
-- include the two new "indexed" markers (OCR_INDEXED + TRANSCRIPT_INDEXED).
-- =============================================================================
--
-- Background:
--   The Phase 31.20 OCR / transcript producers emit two signal types per
--   surface:
--     * OCR_AVAILABLE       — at least one non-redacted, non-blocked
--                              `evidence_ocr_text` row exists for the
--                              evidence record.
--     * OCR_INDEXED         — at least one of those rows has
--                              `indexed_at_utc IS NOT NULL` (the search
--                              projection has consumed it).
--     * TRANSCRIPT_AVAILABLE — symmetric for `evidence_transcript_segments`.
--     * TRANSCRIPT_INDEXED   — symmetric.
--
--   The two AVAILABLE signal types are already in the catalog and the
--   schema CHECK constraint. This patch adds the two _INDEXED signal
--   types to the CHECK constraint so the indexing producer can insert
--   them without violating the bounded vocabulary.
--
-- Hard schema rules preserved:
--   * `signal_type` remains bounded by CHECK constraint.
--   * No destructive operations — DROP then ADD is the standard pattern
--     for widening a CHECK constraint without losing the bound.
--   * Idempotent: re-running this patch is a no-op (the DROP is
--     conditional and the ADD overwrites the constraint).
--
-- Rollback:
--   To revert, run the same DROP CONSTRAINT then re-issue the previous
--   ADD CONSTRAINT (see 2026-05-20-evidence-part-exif-summaries.sql line
--   77-101 for the previous bounded list).
--
-- Operator command:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f \
--     services/api/sql/drift-patches/2026-05-20-ocr-transcript-indexed-signals.sql


ALTER TABLE "media_intelligence_signals"
  DROP CONSTRAINT IF EXISTS "media_intelligence_signals_signal_type_bounded";

ALTER TABLE "media_intelligence_signals"
  ADD CONSTRAINT "media_intelligence_signals_signal_type_bounded"
    CHECK ("signal_type" IN (
      'EXIF_MISSING',
      'EXIF_TIMESTAMP_MISMATCH',
      'CLIENT_SERVER_TIME_GAP',
      'MIME_EXTENSION_MISMATCH',
      'CODEC_CONTAINER_OBSERVATION',
      'SCREENSHOT_LIKE_FILENAME',
      'DUPLICATE_HASH_MATCH',
      'SIMILAR_FILE_CANDIDATE',
      'POSSIBLE_DERIVATIVE_FILE',
      'TRANSCODING_LINEAGE_CANDIDATE',
      'AUDIO_METADATA_OBSERVATION',
      'VIDEO_DURATION_OBSERVATION',
      'FRAME_EXTRACTION_AVAILABLE',
      'THUMBNAIL_AVAILABLE',
      'OCR_AVAILABLE',
      'OCR_INDEXED',
      'TRANSCRIPT_AVAILABLE',
      'TRANSCRIPT_INDEXED',
      'DEVICE_METADATA_OBSERVATION'
    ));


-- =========================================================================
-- BLOCK: 2026-05-20-reviewer-ops-phase25-consolidation.sql
-- =========================================================================
-- =============================================================================
-- Phase 31.22 — reviewer_ops drift consolidation patch.
-- =============================================================================
--
-- Reviewer_ops subsystem reported `runtime.schema_validation.degraded`
-- at API startup because at least one of the registered fields below
-- is missing in the production database. The canonical migration that
-- creates them lives at:
--
--   services/api/prisma/migrations/
--     20260601100000_add_reviewer_operations_phase25/migration.sql
--
-- That migration is idempotent (every CREATE / ALTER guarded by
-- IF NOT EXISTS) but won't run if Prisma believes it has already
-- been applied OR if the `_prisma_migrations` ledger drifted on this
-- environment. This drift patch is the safe-by-construction operator
-- recovery: run it directly via psql to bring the schema up to spec
-- WITHOUT touching the Prisma migration ledger.
--
-- Hard rules preserved:
--   * No DROP. No data migration. No destructive operations.
--   * Every CREATE / ALTER guarded by IF NOT EXISTS / NOT EXISTS.
--   * Wrapped in BEGIN / COMMIT for atomicity.
--   * Idempotent: re-running this patch is a no-op once applied.
--
-- The fields registered by `services/api/src/runtime/schema-validation.ts`
-- under the reviewer_ops subsystem are:
--   * table  evidence_review_workflows
--   * column evidence_review_workflows.assignment_due_at_utc (critical)
--   * column evidence_review_workflows.completion_due_at_utc (critical)
--   * column evidence_review_workflows.paused_reason         (critical)
--   * column evidence_review_workflows.active_escalation_id  (critical)
--   * table  evidence_review_workflow_events                 (critical)
--   * table  review_escalations                              (critical)
--   * index  review_escalations.review_escalations_team_fingerprint_uk (critical)
--   * table  reviewer_workload_snapshots                     (critical)
--   * table  reviewer_ops_reminders                          (important)
--   * table  saved_search_views                              (important)
--   * column saved_search_views.scope                        (critical)
--   * column saved_search_views.query_json                   (critical)
--   * column saved_search_views.visibility                   (important)
--   * column saved_search_views.pinned                       (important)
--   * column saved_search_views.last_used_at_utc             (important)
--
-- This patch reissues only the Phase 25 reviewer-operations additions
-- (the largest cluster). The saved_search_views.scope column is
-- already covered by 2026-05-19-saved-search-views-scope.sql.
--
-- Operator command:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f \
--     services/api/sql/drift-patches/2026-05-20-reviewer-ops-phase25-consolidation.sql
--
-- Verification (post-apply):
--   SELECT table_name FROM information_schema.tables
--    WHERE table_name IN (
--      'evidence_review_workflows','evidence_review_workflow_events',
--      'review_escalations','reviewer_workload_snapshots',
--      'reviewer_ops_reminders'
--    );
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'evidence_review_workflows'
--      AND column_name IN (
--        'assignment_due_at_utc','completion_due_at_utc',
--        'paused_reason','active_escalation_id'
--      );
--   SELECT indexname FROM pg_indexes
--    WHERE indexname = 'review_escalations_team_fingerprint_uk';
--
-- Rollback: see the rollback block at the bottom of
--   services/api/prisma/migrations/20260601100000_add_reviewer_operations_phase25/migration.sql
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Additive columns on evidence_review_workflows.
-- -----------------------------------------------------------------------------

ALTER TABLE "evidence_review_workflows"
  ADD COLUMN IF NOT EXISTS "assignment_due_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "completion_due_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "paused_reason"         VARCHAR(400),
  ADD COLUMN IF NOT EXISTS "active_escalation_id"  UUID;

CREATE INDEX IF NOT EXISTS "evidence_review_workflows_assignment_due_at_utc_idx"
  ON "evidence_review_workflows" ("assignment_due_at_utc");

CREATE INDEX IF NOT EXISTS "evidence_review_workflows_completion_due_at_utc_idx"
  ON "evidence_review_workflows" ("completion_due_at_utc");

-- -----------------------------------------------------------------------------
-- 2. review_escalations table + indexes + FKs.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "review_escalations" (
  "id"                       UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                  UUID         NOT NULL,
  "workflow_id"              UUID         NOT NULL,
  "workflow_instance_id"     UUID,
  "evidence_id"              UUID,
  "reason"                   VARCHAR(48)  NOT NULL,
  "severity"                 VARCHAR(16)  NOT NULL DEFAULT 'WARNING',
  "status"                   VARCHAR(16)  NOT NULL DEFAULT 'OPEN',
  "safe_summary"             VARCHAR(400) NOT NULL,
  "created_by_user_id"       UUID,
  "assigned_to_user_id"      UUID,
  "acknowledged_at_utc"      TIMESTAMPTZ(6),
  "acknowledged_by_user_id"  UUID,
  "resolved_at_utc"          TIMESTAMPTZ(6),
  "resolved_by_user_id"      UUID,
  "resolution_note"          VARCHAR(400),
  "suppressed_at_utc"        TIMESTAMPTZ(6),
  "suppression_reason"       VARCHAR(400),
  "incident_id"              UUID,
  "fingerprint"              VARCHAR(80)  NOT NULL,
  "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "review_escalations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "review_escalations_team_fingerprint_uk"
  ON "review_escalations" ("team_id", "fingerprint");

CREATE INDEX IF NOT EXISTS "review_escalations_team_status_idx"
  ON "review_escalations" ("team_id", "status");

CREATE INDEX IF NOT EXISTS "review_escalations_team_severity_idx"
  ON "review_escalations" ("team_id", "severity");

CREATE INDEX IF NOT EXISTS "review_escalations_team_reason_idx"
  ON "review_escalations" ("team_id", "reason");

CREATE INDEX IF NOT EXISTS "review_escalations_workflow_created_idx"
  ON "review_escalations" ("workflow_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "review_escalations_workflow_instance_idx"
  ON "review_escalations" ("workflow_instance_id");

CREATE INDEX IF NOT EXISTS "review_escalations_assigned_to_status_idx"
  ON "review_escalations" ("assigned_to_user_id", "status");

CREATE INDEX IF NOT EXISTS "review_escalations_incident_idx"
  ON "review_escalations" ("incident_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'review_escalations_team_id_fkey'
  ) THEN
    ALTER TABLE "review_escalations"
      ADD CONSTRAINT "review_escalations_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'review_escalations_workflow_id_fkey'
  ) THEN
    ALTER TABLE "review_escalations"
      ADD CONSTRAINT "review_escalations_workflow_id_fkey"
      FOREIGN KEY ("workflow_id") REFERENCES "evidence_review_workflows"("id") ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'review_escalations_created_by_user_id_fkey'
  ) THEN
    ALTER TABLE "review_escalations"
      ADD CONSTRAINT "review_escalations_created_by_user_id_fkey"
      FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'review_escalations_assigned_to_user_id_fkey'
  ) THEN
    ALTER TABLE "review_escalations"
      ADD CONSTRAINT "review_escalations_assigned_to_user_id_fkey"
      FOREIGN KEY ("assigned_to_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'review_escalations_acknowledged_by_user_id_fkey'
  ) THEN
    ALTER TABLE "review_escalations"
      ADD CONSTRAINT "review_escalations_acknowledged_by_user_id_fkey"
      FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'review_escalations_resolved_by_user_id_fkey'
  ) THEN
    ALTER TABLE "review_escalations"
      ADD CONSTRAINT "review_escalations_resolved_by_user_id_fkey"
      FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 3. reviewer_workload_snapshots table + indexes + FKs.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "reviewer_workload_snapshots" (
  "id"                          UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                     UUID         NOT NULL,
  "reviewer_user_id"            UUID         NOT NULL,
  "active_review_count"         INTEGER      NOT NULL DEFAULT 0,
  "overdue_review_count"        INTEGER      NOT NULL DEFAULT 0,
  "due_soon_review_count"       INTEGER      NOT NULL DEFAULT 0,
  "escalated_review_count"      INTEGER      NOT NULL DEFAULT 0,
  "needs_info_review_count"     INTEGER      NOT NULL DEFAULT 0,
  "capacity_score"              INTEGER      NOT NULL DEFAULT 100,
  "safe_note"                   VARCHAR(400),
  "computed_at_utc"             TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "reviewer_workload_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "reviewer_workload_snapshots_team_reviewer_computed_idx"
  ON "reviewer_workload_snapshots"
     ("team_id", "reviewer_user_id", "computed_at_utc" DESC);

CREATE INDEX IF NOT EXISTS "reviewer_workload_snapshots_team_computed_idx"
  ON "reviewer_workload_snapshots" ("team_id", "computed_at_utc" DESC);

CREATE INDEX IF NOT EXISTS "reviewer_workload_snapshots_team_capacity_idx"
  ON "reviewer_workload_snapshots" ("team_id", "capacity_score");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reviewer_workload_snapshots_team_id_fkey'
  ) THEN
    ALTER TABLE "reviewer_workload_snapshots"
      ADD CONSTRAINT "reviewer_workload_snapshots_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reviewer_workload_snapshots_reviewer_user_id_fkey'
  ) THEN
    ALTER TABLE "reviewer_workload_snapshots"
      ADD CONSTRAINT "reviewer_workload_snapshots_reviewer_user_id_fkey"
      FOREIGN KEY ("reviewer_user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
END
$$;


-- =========================================================================
-- BLOCK: reviewer_ops_reminders (Phase 32.5 — never had a drift patch)
-- =========================================================================
--
-- Phase 25.5 / 25.7 shipped ReviewerOpsReminder as a Prisma model and the
-- reviewer ops reminder engine writes to `reviewer_ops_reminders`, but
-- the table was never created by any migration NOR by any drift patch.
-- Any code path that hits the reminder engine on a fresh DB would throw
-- P2021 ("relation does not exist"). This block closes that schema hole.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
-- Rollback: DROP TABLE IF EXISTS "reviewer_ops_reminders" CASCADE;

CREATE TABLE IF NOT EXISTS "reviewer_ops_reminders" (
  "id"                       UUID NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                  UUID NOT NULL,
  "kind"                     VARCHAR(40) NOT NULL,
  "dedup_key"                VARCHAR(80) NOT NULL,
  "workflow_id"              UUID,
  "escalation_id"            UUID,
  "reviewer_user_id"         UUID,
  "safe_summary"             VARCHAR(400) NOT NULL,
  "communication_message_id" UUID,
  "status"                   VARCHAR(16) NOT NULL DEFAULT 'SCHEDULED',
  "day_bucket"               VARCHAR(10) NOT NULL,
  "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "reviewer_ops_reminders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "reviewer_ops_reminders_team_kind_dedup_uk"
  ON "reviewer_ops_reminders" ("team_id", "kind", "dedup_key");

CREATE INDEX IF NOT EXISTS "reviewer_ops_reminders_team_kind_created_idx"
  ON "reviewer_ops_reminders" ("team_id", "kind", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "reviewer_ops_reminders_team_workflow_idx"
  ON "reviewer_ops_reminders" ("team_id", "workflow_id");

CREATE INDEX IF NOT EXISTS "reviewer_ops_reminders_team_reviewer_created_idx"
  ON "reviewer_ops_reminders" ("team_id", "reviewer_user_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "reviewer_ops_reminders_team_status_idx"
  ON "reviewer_ops_reminders" ("team_id", "status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reviewer_ops_reminders_team_id_fkey'
  ) THEN
    ALTER TABLE "reviewer_ops_reminders"
      ADD CONSTRAINT "reviewer_ops_reminders_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;
  END IF;
END
$$;
