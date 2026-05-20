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

BEGIN;

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

COMMIT;
