-- PHASE 4B FOUNDATION — Packaging, Entitlements, Webhooks, Retention,
-- Legal Hold, Archive Tiers, Destruction Governance & Lifecycle Dashboard.
--
-- Rules (Phase O-Final compliant):
--   * Brand-new tables → plain CREATE TABLE (no IF NOT EXISTS on tables).
--   * Every CREATE INDEX wrapped in a DO/information_schema guard block
--     with column-existence checks for every referenced column.
--   * No ALTER on existing tables in this migration.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. entitlement_grants
-- ---------------------------------------------------------------------------

CREATE TABLE "entitlement_grants" (
  "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"             UUID         NOT NULL,
  "key"                 VARCHAR(80)  NOT NULL,
  "kind"                VARCHAR(20)  NOT NULL,
  "value_bool"          BOOLEAN,
  "value_number"        BIGINT,
  "source"              VARCHAR(20)  NOT NULL DEFAULT 'PLAN',
  "product_line"        VARCHAR(60),
  "granted_by_user_id"  UUID,
  "granted_at_utc"      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "expires_at_utc"      TIMESTAMPTZ(6),
  "notes"               VARCHAR(400),
  CONSTRAINT "entitlement_grants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "entitlement_grants_team_key_uniq"
  ON "entitlement_grants" ("team_id", "key");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='entitlement_grants'
                AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='entitlement_grants'
                    AND column_name='kind') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "entitlement_grants_team_kind_idx" ON "entitlement_grants" ("team_id", "kind")';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. entitlement_usage
-- ---------------------------------------------------------------------------

CREATE TABLE "entitlement_usage" (
  "id"                UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"           UUID         NOT NULL,
  "key"               VARCHAR(80)  NOT NULL,
  "period_start_utc"  TIMESTAMPTZ(6) NOT NULL,
  "consumed"          BIGINT       NOT NULL DEFAULT 0,
  "updated_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "entitlement_usage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "entitlement_usage_team_key_period_uniq"
  ON "entitlement_usage" ("team_id", "key", "period_start_utc");

-- ---------------------------------------------------------------------------
-- 3. evidence_exchange_packages
-- ---------------------------------------------------------------------------

CREATE TABLE "evidence_exchange_packages" (
  "id"                          UUID          NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                     UUID          NOT NULL,
  "kind"                        VARCHAR(40)   NOT NULL,
  "state"                       VARCHAR(20)   NOT NULL DEFAULT 'DRAFT',
  "evidence_ids"                JSONB         NOT NULL,
  "case_id"                     UUID,
  "scope_note"                  VARCHAR(400),
  "signed_url"                  VARCHAR(1024),
  "signed_url_expires_at_utc"   TIMESTAMPTZ(6),
  "package_sha256"              VARCHAR(64),
  "package_size_bytes"          BIGINT,
  "storage_key"                 VARCHAR(400),
  "created_by_user_id"          UUID          NOT NULL,
  "created_at"                  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "ready_at_utc"                TIMESTAMPTZ(6),
  "delivered_at_utc"            TIMESTAMPTZ(6),
  "expired_at_utc"              TIMESTAMPTZ(6),
  "revoked_at_utc"              TIMESTAMPTZ(6),
  CONSTRAINT "evidence_exchange_packages_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='evidence_exchange_packages'
                AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='evidence_exchange_packages'
                    AND column_name='state') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "evidence_exchange_packages_team_state_idx" ON "evidence_exchange_packages" ("team_id", "state")';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='evidence_exchange_packages'
                AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='evidence_exchange_packages'
                    AND column_name='kind') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "evidence_exchange_packages_team_kind_idx" ON "evidence_exchange_packages" ("team_id", "kind")';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='evidence_exchange_packages'
                AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='evidence_exchange_packages'
                    AND column_name='created_at') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "evidence_exchange_packages_team_created_idx" ON "evidence_exchange_packages" ("team_id", "created_at" DESC)';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. evidence_exchange_package_deliveries
-- ---------------------------------------------------------------------------

CREATE TABLE "evidence_exchange_package_deliveries" (
  "id"                  UUID          NOT NULL DEFAULT gen_random_uuid(),
  "team_id"             UUID          NOT NULL,
  "package_id"          UUID          NOT NULL,
  "recipient_email"     VARCHAR(320),
  "recipient_org_slug"  VARCHAR(120),
  "channel"             VARCHAR(20)   NOT NULL DEFAULT 'SIGNED_URL',
  "delivered_at_utc"    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "downloaded_at_utc"   TIMESTAMPTZ(6),
  "verified_at_utc"     TIMESTAMPTZ(6),
  "ip_address_hash"     VARCHAR(64),
  CONSTRAINT "evidence_exchange_package_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "evidence_exchange_package_deliveries_package_fk"
    FOREIGN KEY ("package_id") REFERENCES "evidence_exchange_packages" ("id") ON DELETE CASCADE
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='evidence_exchange_package_deliveries'
                AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='evidence_exchange_package_deliveries'
                    AND column_name='package_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='evidence_exchange_package_deliveries'
                    AND column_name='delivered_at_utc') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "evidence_exchange_package_deliveries_team_pkg_idx" ON "evidence_exchange_package_deliveries" ("team_id", "package_id", "delivered_at_utc" DESC)';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. chain_transfers
-- ---------------------------------------------------------------------------

CREATE TABLE "chain_transfers" (
  "id"                    UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"               UUID         NOT NULL,
  "from_organization_id"  UUID         NOT NULL,
  "to_organization_slug"  VARCHAR(120) NOT NULL,
  "to_organization_id"    UUID,
  "evidence_ids"          JSONB        NOT NULL,
  "case_id"               UUID,
  "state"                 VARCHAR(40)  NOT NULL DEFAULT 'INITIATED',
  "package_id"            UUID,
  "reason_note"           VARCHAR(400),
  "expires_at_utc"        TIMESTAMPTZ(6),
  "initiated_by_user_id"  UUID         NOT NULL,
  "accepted_by_user_id"   UUID,
  "rejected_by_user_id"   UUID,
  "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "responded_at_utc"      TIMESTAMPTZ(6),
  "completed_at_utc"      TIMESTAMPTZ(6),
  CONSTRAINT "chain_transfers_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='chain_transfers'
                AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='chain_transfers'
                    AND column_name='state') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "chain_transfers_team_state_idx" ON "chain_transfers" ("team_id", "state")';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='chain_transfers'
                AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='chain_transfers'
                    AND column_name='from_organization_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "chain_transfers_team_from_org_idx" ON "chain_transfers" ("team_id", "from_organization_id")';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6. webhook_endpoints
-- ---------------------------------------------------------------------------

CREATE TABLE "webhook_endpoints" (
  "id"                    UUID          NOT NULL DEFAULT gen_random_uuid(),
  "team_id"               UUID          NOT NULL,
  "url"                   VARCHAR(1024) NOT NULL,
  "secret"                VARCHAR(128)  NOT NULL,
  "subscribed_events"     JSONB         NOT NULL,
  "state"                 VARCHAR(20)   NOT NULL DEFAULT 'ACTIVE',
  "created_by_user_id"    UUID          NOT NULL,
  "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "deactivated_at_utc"    TIMESTAMPTZ(6),
  CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='webhook_endpoints'
                AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='webhook_endpoints'
                    AND column_name='state') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "webhook_endpoints_team_state_idx" ON "webhook_endpoints" ("team_id", "state")';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 7. webhook_deliveries
-- ---------------------------------------------------------------------------

CREATE TABLE "webhook_deliveries" (
  "id"                      UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                 UUID         NOT NULL,
  "endpoint_id"             UUID         NOT NULL,
  "event_kind"              VARCHAR(60)  NOT NULL,
  "payload"                 JSONB        NOT NULL,
  "signature"               VARCHAR(200) NOT NULL,
  "state"                   VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
  "attempt_count"           INTEGER      NOT NULL DEFAULT 0,
  "last_attempt_at_utc"     TIMESTAMPTZ(6),
  "delivered_at_utc"        TIMESTAMPTZ(6),
  "dead_lettered_at_utc"    TIMESTAMPTZ(6),
  "response_status"         INTEGER,
  "response_body_preview"   VARCHAR(400),
  "enqueued_at_utc"         TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webhook_deliveries_endpoint_fk"
    FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints" ("id") ON DELETE CASCADE
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='webhook_deliveries'
                AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='webhook_deliveries'
                    AND column_name='state')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='webhook_deliveries'
                    AND column_name='enqueued_at_utc') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "webhook_deliveries_team_state_enqueued_idx" ON "webhook_deliveries" ("team_id", "state", "enqueued_at_utc" DESC)';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='webhook_deliveries'
                AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='webhook_deliveries'
                    AND column_name='event_kind') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "webhook_deliveries_team_event_kind_idx" ON "webhook_deliveries" ("team_id", "event_kind")';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 8. retention_policy_configs
-- ---------------------------------------------------------------------------

CREATE TABLE "retention_policy_configs" (
  "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"             UUID         NOT NULL,
  "name"                VARCHAR(200) NOT NULL,
  "template"            VARCHAR(40)  NOT NULL,
  "years"               INTEGER      NOT NULL,
  "scope_kind"          VARCHAR(40)  NOT NULL DEFAULT 'WORKSPACE',
  "scope_target_id"     UUID,
  "inherits_from_id"    UUID,
  "is_override"         BOOLEAN      NOT NULL DEFAULT FALSE,
  "exceptions"          JSONB        NOT NULL,
  "state"               VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE',
  "created_by_user_id"  UUID         NOT NULL,
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "retention_policy_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "retention_policy_configs_team_scope_uniq"
  ON "retention_policy_configs" ("team_id", "scope_kind", "scope_target_id");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='retention_policy_configs'
                AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='retention_policy_configs'
                    AND column_name='template') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "retention_policy_configs_team_template_idx" ON "retention_policy_configs" ("team_id", "template")';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 9. legal_holds
-- ---------------------------------------------------------------------------

CREATE TABLE "legal_holds" (
  "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"             UUID         NOT NULL,
  "kind"                VARCHAR(40)  NOT NULL,
  "scope_target_id"     UUID,
  "name"                VARCHAR(200) NOT NULL,
  "reason"              VARCHAR(600) NOT NULL,
  "state"               VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE',
  "created_by_user_id"  UUID         NOT NULL,
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "released_by_user_id" UUID,
  "released_at_utc"     TIMESTAMPTZ(6),
  "expires_at_utc"      TIMESTAMPTZ(6),
  CONSTRAINT "legal_holds_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='legal_holds'
                AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='legal_holds'
                    AND column_name='state') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "legal_holds_team_state_idx" ON "legal_holds" ("team_id", "state")';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='legal_holds'
                AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='legal_holds'
                    AND column_name='kind')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='legal_holds'
                    AND column_name='scope_target_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "legal_holds_team_kind_scope_idx" ON "legal_holds" ("team_id", "kind", "scope_target_id")';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 10. archive_tier_transitions
-- ---------------------------------------------------------------------------

CREATE TABLE "archive_tier_transitions" (
  "id"                        UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                   UUID         NOT NULL,
  "evidence_id"               UUID         NOT NULL,
  "from_tier"                 VARCHAR(20)  NOT NULL,
  "to_tier"                   VARCHAR(20)  NOT NULL,
  "reason"                    VARCHAR(400),
  "cost_estimate_usd_micros"  BIGINT       NOT NULL DEFAULT 0,
  "initiated_by_user_id"      UUID,
  "transitioned_at_utc"       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "archive_tier_transitions_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='archive_tier_transitions'
                AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='archive_tier_transitions'
                    AND column_name='evidence_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='archive_tier_transitions'
                    AND column_name='transitioned_at_utc') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "archive_tier_transitions_team_evidence_idx" ON "archive_tier_transitions" ("team_id", "evidence_id", "transitioned_at_utc" DESC)';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='archive_tier_transitions'
                AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='archive_tier_transitions'
                    AND column_name='to_tier') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "archive_tier_transitions_team_to_tier_idx" ON "archive_tier_transitions" ("team_id", "to_tier")';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 11. destruction_requests
-- ---------------------------------------------------------------------------

CREATE TABLE "destruction_requests" (
  "id"                    UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"               UUID         NOT NULL,
  "state"                 VARCHAR(20)  NOT NULL DEFAULT 'REQUESTED',
  "evidence_ids"          JSONB        NOT NULL,
  "reason"                VARCHAR(600) NOT NULL,
  "policy_ref"            VARCHAR(80),
  "requested_by_user_id"  UUID         NOT NULL,
  "approver_user_ids"     JSONB        NOT NULL,
  "executed_at_utc"       TIMESTAMPTZ(6),
  "certified_at_utc"      TIMESTAMPTZ(6),
  "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "destruction_requests_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='destruction_requests'
                AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='destruction_requests'
                    AND column_name='state') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "destruction_requests_team_state_idx" ON "destruction_requests" ("team_id", "state")';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 12. destruction_certificates
-- ---------------------------------------------------------------------------

CREATE TABLE "destruction_certificates" (
  "id"                      UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                 UUID         NOT NULL,
  "request_id"              UUID         NOT NULL,
  "evidence_count"          INTEGER      NOT NULL,
  "approval_chain_user_ids" JSONB        NOT NULL,
  "executed_at_utc"         TIMESTAMPTZ(6) NOT NULL,
  "certified_at_utc"        TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "certificate_hash"        VARCHAR(64)  NOT NULL,
  "certificate_uri"         VARCHAR(400),
  CONSTRAINT "destruction_certificates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "destruction_certificates_request_fk"
    FOREIGN KEY ("request_id") REFERENCES "destruction_requests" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "destruction_certificates_request_uniq"
  ON "destruction_certificates" ("request_id");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='destruction_certificates'
                AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='destruction_certificates'
                    AND column_name='certified_at_utc') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "destruction_certificates_team_certified_idx" ON "destruction_certificates" ("team_id", "certified_at_utc" DESC)';
  END IF;
END $$;

COMMIT;
