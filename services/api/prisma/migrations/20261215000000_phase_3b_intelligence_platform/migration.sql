-- PHASE 3B — Enterprise Intelligence Platform.
--
-- Six new tables (Phase O-Final hygienic):
--
--   media_intelligence_records   — unified provider record store
--   media_intelligence_entities  — bounded entity rows
--   reviewer_corrections         — append-only corrections
--   provider_usage_events        — one row per provider call
--   provider_budgets             — bounded soft/hard budget rows
--   provider_budget_alerts       — bounded threshold alerts
--
-- Hard rules:
--   * Brand-new tables → plain CREATE TABLE (loud failure on collision).
--   * Every CREATE INDEX wrapped in a DO/information_schema guard.
--   * Cascade deletes from parents.
--   * No existing tables altered.

BEGIN;

-- =============================================================================
-- 1. media_intelligence_records
-- =============================================================================
CREATE TABLE "media_intelligence_records" (
  "id"                          UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                     UUID         NOT NULL,
  "evidence_id"                 UUID         NOT NULL,
  "modality"                    VARCHAR(20)  NOT NULL,
  "kind"                        VARCHAR(40)  NOT NULL,
  "provider"                    VARCHAR(60)  NOT NULL,
  "state"                       VARCHAR(20)  NOT NULL DEFAULT 'INGESTED',
  "provider_confidence"         DOUBLE PRECISION NOT NULL,
  "provider_confidence_band"    VARCHAR(20)  NOT NULL,
  "review_confidence_band"      VARCHAR(20),
  "final_confidence_band"       VARCHAR(20)  NOT NULL DEFAULT 'LOW',
  "label"                       VARCHAR(120),
  "anchor"                      JSONB,
  "payload"                     JSONB        NOT NULL,
  "provider_record_key"         VARCHAR(200),
  "created_at"                  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "reviewed_at_utc"             TIMESTAMPTZ(6),
  "superseded_at_utc"           TIMESTAMPTZ(6),
  CONSTRAINT "media_intelligence_records_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "media_intelligence_records_provider_key_uniq"
  ON "media_intelligence_records" ("team_id", "evidence_id", "provider", "provider_record_key");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='media_intelligence_records'
                AND column_name='kind') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "media_intelligence_records_team_evidence_kind_idx" ON "media_intelligence_records" ("team_id", "evidence_id", "kind")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "media_intelligence_records_team_state_idx" ON "media_intelligence_records" ("team_id", "state")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "media_intelligence_records_team_provider_idx" ON "media_intelligence_records" ("team_id", "provider")';
  END IF;
END $$;

-- =============================================================================
-- 2. media_intelligence_entities
-- =============================================================================
CREATE TABLE "media_intelligence_entities" (
  "id"               UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"          UUID         NOT NULL,
  "record_id"        UUID         NOT NULL,
  "evidence_id"      UUID         NOT NULL,
  "kind"             VARCHAR(40)  NOT NULL,
  "preview_label"    VARCHAR(80),
  "value_hash"       VARCHAR(64)  NOT NULL,
  "raw_confidence"   DOUBLE PRECISION NOT NULL,
  "confidence_band"  VARCHAR(20)  NOT NULL,
  "anchor"           JSONB,
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "media_intelligence_entities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "media_intelligence_entities_record_fk"
    FOREIGN KEY ("record_id") REFERENCES "media_intelligence_records" ("id") ON DELETE CASCADE
);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='media_intelligence_entities'
                AND column_name='value_hash') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "media_intelligence_entities_team_evidence_kind_idx" ON "media_intelligence_entities" ("team_id", "evidence_id", "kind")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "media_intelligence_entities_team_value_idx" ON "media_intelligence_entities" ("team_id", "value_hash")';
  END IF;
END $$;

-- =============================================================================
-- 3. reviewer_corrections
-- =============================================================================
CREATE TABLE "reviewer_corrections" (
  "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"             UUID         NOT NULL,
  "record_id"           UUID         NOT NULL,
  "kind"                VARCHAR(60)  NOT NULL,
  "state"               VARCHAR(20)  NOT NULL DEFAULT 'DRAFT',
  "patch"               JSONB        NOT NULL,
  "rationale"           VARCHAR(600),
  "authored_by_user_id" UUID         NOT NULL,
  "accepted_by_user_id" UUID,
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "accepted_at_utc"     TIMESTAMPTZ(6),
  "reverted_at_utc"     TIMESTAMPTZ(6),
  CONSTRAINT "reviewer_corrections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reviewer_corrections_record_fk"
    FOREIGN KEY ("record_id") REFERENCES "media_intelligence_records" ("id") ON DELETE CASCADE
);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='reviewer_corrections'
                AND column_name='record_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "reviewer_corrections_team_record_created_idx" ON "reviewer_corrections" ("team_id", "record_id", "created_at" DESC)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "reviewer_corrections_team_kind_idx" ON "reviewer_corrections" ("team_id", "kind")';
  END IF;
END $$;

-- =============================================================================
-- 4. provider_usage_events
-- =============================================================================
CREATE TABLE "provider_usage_events" (
  "id"                       UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                  UUID         NOT NULL,
  "provider"                 VARCHAR(60)  NOT NULL,
  "operation"                VARCHAR(40)  NOT NULL,
  "unit"                     VARCHAR(20)  NOT NULL,
  "units"                    DOUBLE PRECISION NOT NULL,
  "estimated_cost_usd_micros" BIGINT      NOT NULL,
  "evidence_id"              UUID,
  "case_id"                  UUID,
  "project_id"               UUID,
  "initiated_by_user_id"     UUID,
  "decision"                 VARCHAR(20)  NOT NULL,
  "failure_reason"           VARCHAR(120),
  "occurred_at_utc"          TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "provider_usage_events_pkey" PRIMARY KEY ("id")
);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='provider_usage_events'
                AND column_name='provider') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "provider_usage_events_team_provider_occ_idx" ON "provider_usage_events" ("team_id", "provider", "occurred_at_utc" DESC)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "provider_usage_events_team_evidence_idx" ON "provider_usage_events" ("team_id", "evidence_id")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "provider_usage_events_team_case_idx" ON "provider_usage_events" ("team_id", "case_id")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "provider_usage_events_team_project_idx" ON "provider_usage_events" ("team_id", "project_id")';
  END IF;
END $$;

-- =============================================================================
-- 5. provider_budgets
-- =============================================================================
CREATE TABLE "provider_budgets" (
  "id"                    UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"               UUID         NOT NULL,
  "scope"                 VARCHAR(20)  NOT NULL,
  "scope_target_id"       UUID,
  "provider"              VARCHAR(60),
  "period"                VARCHAR(20)  NOT NULL,
  "soft_limit_usd_micros" BIGINT       NOT NULL,
  "hard_limit_usd_micros" BIGINT       NOT NULL,
  "state"                 VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE',
  "created_by_user_id"    UUID         NOT NULL,
  "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "provider_budgets_pkey" PRIMARY KEY ("id")
);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='provider_budgets'
                AND column_name='scope') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "provider_budgets_team_scope_idx" ON "provider_budgets" ("team_id", "scope", "scope_target_id")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "provider_budgets_team_provider_idx" ON "provider_budgets" ("team_id", "provider")';
  END IF;
END $$;

-- =============================================================================
-- 6. provider_budget_alerts
-- =============================================================================
CREATE TABLE "provider_budget_alerts" (
  "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"             UUID         NOT NULL,
  "budget_id"           UUID         NOT NULL,
  "threshold"           VARCHAR(8)   NOT NULL,
  "consumed_usd_micros" BIGINT       NOT NULL,
  "occurred_at_utc"     TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "provider_budget_alerts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "provider_budget_alerts_budget_fk"
    FOREIGN KEY ("budget_id") REFERENCES "provider_budgets" ("id") ON DELETE CASCADE
);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='provider_budget_alerts'
                AND column_name='budget_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "provider_budget_alerts_team_budget_occ_idx" ON "provider_budget_alerts" ("team_id", "budget_id", "occurred_at_utc" DESC)';
  END IF;
END $$;

COMMIT;
