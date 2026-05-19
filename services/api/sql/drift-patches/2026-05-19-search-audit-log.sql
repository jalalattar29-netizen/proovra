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

BEGIN;

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

COMMIT;
