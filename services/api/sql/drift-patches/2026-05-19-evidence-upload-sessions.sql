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

BEGIN;

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

COMMIT;
