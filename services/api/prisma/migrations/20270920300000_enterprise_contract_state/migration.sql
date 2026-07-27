-- =============================================================================
-- PHASE 4 (2026-07-22) — canonical Enterprise contract state (§7.2).
--
-- One authoritative record per CUSTOMER Organization of its commercial
-- scope: status, activation, seats, storage, region, billing references,
-- contract owner, effective/termination dates. Additive only.
--
-- BACKFILL (deterministic, provenance-based — no guessing):
--   every existing CUSTOMER organization receives one ACTIVE contract row
--   derived from the legacy signals the resolver's compatibility fallback
--   reads today: pending_enterprise_seats → seat_count; the billing owner
--   → contract owner; effective date = organization creation. CUSTOMER
--   kind itself was backfilled from enterprise provenance in
--   20270920000000_workspace_kind_discriminator, so this inherits that provenance chain. SYSTEM
--   organizations receive NOTHING (they have no contract by definition).
--
-- Rollback: DROP TABLE + DROP TYPE, zero data loss to pre-existing tables.
-- NOT applied here.
-- =============================================================================

CREATE TYPE "EnterpriseContractStatus" AS ENUM (
  'DRAFT',
  'PENDING_ACTIVATION',
  'ACTIVE',
  'SUSPENDED',
  'TERMINATED'
);

CREATE TABLE "enterprise_contracts" (
  "id"                       UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"          UUID NOT NULL,
  "status"                   "EnterpriseContractStatus" NOT NULL DEFAULT 'PENDING_ACTIVATION',
  "activation_state"         VARCHAR(40),
  "effective_at_utc"         TIMESTAMPTZ(6),
  "ends_at_utc"              TIMESTAMPTZ(6),
  "seat_count"               INTEGER,
  "storage_gb"               INTEGER,
  "region"                   VARCHAR(40),
  "plan_version"             VARCHAR(40),
  "billing_customer_ref"     VARCHAR(200),
  "billing_subscription_ref" VARCHAR(200),
  "contract_owner_user_id"   UUID,
  "terminated_at_utc"        TIMESTAMPTZ(6),
  "termination_reason"       VARCHAR(400),
  "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "enterprise_contracts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "enterprise_contracts_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "enterprise_contracts_organization_id_key"
  ON "enterprise_contracts" ("organization_id");
CREATE INDEX "enterprise_contracts_status_idx"
  ON "enterprise_contracts" ("status");

-- Deterministic backfill: one ACTIVE contract per existing CUSTOMER org.
INSERT INTO "enterprise_contracts"
  ("organization_id", "status", "activation_state", "effective_at_utc",
   "seat_count", "contract_owner_user_id")
SELECT
  o."id",
  'ACTIVE',
  'ACTIVATED',
  o."created_at",
  o."pending_enterprise_seats",
  o."billing_owner_user_id"
FROM "organizations" o
WHERE o."kind" = 'CUSTOMER'
  AND NOT EXISTS (
    SELECT 1 FROM "enterprise_contracts" c
    WHERE c."organization_id" = o."id"
  );
