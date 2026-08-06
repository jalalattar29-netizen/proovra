-- PHASE 12 — POINT 5: durable report/package generation authority.
--
-- OWNER_MIGRATION_PENDING. Forward-only, guarded, idempotent.
--
-- Why this table exists: report generation used to be requested by putting
-- `{ evidenceId, forceRegenerate, regenerateReason }` on a BullMQ payload.
-- `forceRegenerate` is the outcome of an authorization decision — it bypasses
-- the guard refusing to regenerate an already-REPORTED artifact — and it was
-- arriving as an unverified boolean on a queue message. The authorized
-- synchronous path now persists the intent here; the queue carries only this
-- row's id.
--
-- Guards:
--   * every statement is IF NOT EXISTS, so re-running after a partial apply is
--     a clean no-op;
--   * the table is NEW, so there is no backfill, no data movement and nothing
--     to lose — a failed apply leaves the previous state exactly intact;
--   * no existing column is altered or dropped, so a running deployment on the
--     prior build is unaffected until its code is replaced.

CREATE TABLE IF NOT EXISTS "report_generation_requests" (
  "id"                        UUID          NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                   UUID          NOT NULL,
  "evidence_id"               UUID          NOT NULL,
  "artifact_type"             VARCHAR(32)   NOT NULL DEFAULT 'REPORT',
  "purpose"                   VARCHAR(64)   NOT NULL DEFAULT 'evidence_completed',
  "force_regenerate"          BOOLEAN       NOT NULL DEFAULT FALSE,
  "regenerate_reason"         VARCHAR(120),
  "requested_by_user_id"      UUID,
  "requested_by_machine_id"   VARCHAR(64),
  "expected_policy_version"   INTEGER,
  "idempotency_key"           VARCHAR(160)  NOT NULL,
  "state"                     VARCHAR(32)   NOT NULL DEFAULT 'QUEUED',
  "attempt_count"             INTEGER       NOT NULL DEFAULT 0,
  "claimed_at_utc"            TIMESTAMPTZ(6),
  "result_report_id"          UUID,
  "result_checksum"           VARCHAR(128),
  "terminal_reason_code"      VARCHAR(64),
  "created_at_utc"            TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at_utc"            TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "completed_at_utc"          TIMESTAMPTZ(6),
  CONSTRAINT "report_generation_requests_pkey" PRIMARY KEY ("id")
);

-- The idempotency key is what collapses a duplicate request for the same
-- intent. It is a UNIQUE constraint rather than an application check because
-- two concurrent authorized requests must produce one row, and only the
-- database can decide that race.
CREATE UNIQUE INDEX IF NOT EXISTS "report_generation_requests_idempotency_key_key"
  ON "report_generation_requests" ("idempotency_key");

CREATE INDEX IF NOT EXISTS "report_generation_requests_team_state_idx"
  ON "report_generation_requests" ("team_id", "state", "created_at_utc" DESC);

CREATE INDEX IF NOT EXISTS "report_generation_requests_evidence_idx"
  ON "report_generation_requests" ("evidence_id", "state");

-- Supports the stranded-row reconciler's claim scan without a sequential scan
-- over the whole table.
CREATE INDEX IF NOT EXISTS "report_generation_requests_claim_idx"
  ON "report_generation_requests" ("state", "claimed_at_utc");
