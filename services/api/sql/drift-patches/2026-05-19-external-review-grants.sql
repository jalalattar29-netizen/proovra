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

BEGIN;

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

COMMIT;
