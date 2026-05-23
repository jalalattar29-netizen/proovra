-- PHASE 37.97 — Dashboard read-model projections.
--
-- Additive only. Two new tables that the dashboard reads instead of
-- running the 140+ live-aggregation queries. Idempotent guards so the
-- migration is safe to re-apply.

CREATE TABLE IF NOT EXISTS "org_health_projections" (
  "team_id"                    UUID NOT NULL,
  "sampled_at_utc"             TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "evidence_count"             INT NOT NULL DEFAULT 0,
  "case_count"                 INT NOT NULL DEFAULT 0,
  "open_incident_count"        INT NOT NULL DEFAULT 0,
  "sla_breach_count"           INT NOT NULL DEFAULT 0,
  "governance_blocker_count"   INT NOT NULL DEFAULT 0,
  "recent_verification_count"  INT NOT NULL DEFAULT 0,
  "pending_package_count"      INT NOT NULL DEFAULT 0,
  "pending_report_count"       INT NOT NULL DEFAULT 0,
  "source"                     VARCHAR(40),
  "created_at"                 TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY ("team_id", "sampled_at_utc")
);

CREATE INDEX IF NOT EXISTS "org_health_projections_team_sampled_desc_idx"
  ON "org_health_projections" ("team_id", "sampled_at_utc" DESC);

CREATE TABLE IF NOT EXISTS "reviewer_queue_projections" (
  "team_id"            UUID NOT NULL PRIMARY KEY,
  "pending_count"      INT NOT NULL DEFAULT 0,
  "in_review_count"    INT NOT NULL DEFAULT 0,
  "blocked_count"      INT NOT NULL DEFAULT 0,
  "escalation_count"   INT NOT NULL DEFAULT 0,
  "refreshed_at_utc"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "source"             VARCHAR(40)
);

CREATE INDEX IF NOT EXISTS "reviewer_queue_projections_team_refreshed_desc_idx"
  ON "reviewer_queue_projections" ("team_id", "refreshed_at_utc" DESC);
