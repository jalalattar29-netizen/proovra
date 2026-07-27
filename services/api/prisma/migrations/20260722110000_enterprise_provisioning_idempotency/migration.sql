-- =============================================================================
-- PHASE 4 §7.1 (2026-07-22) — Enterprise provisioning idempotency.
--
-- Canonical duplicate-prevention identity = the IMMUTABLE caller-supplied
-- idempotency key (provisioning-request id / CRM contract reference), with a
-- DATABASE unique constraint so concurrent same-key requests collapse to
-- exactly one provisioning result. Normalized names/emails are NEVER an
-- identity (names are not unique; an owner may own several Organizations;
-- both may change) — they only feed an advisory possible-duplicate report.
--
-- Additive only. Rollback: DROP TABLE + DROP TYPE. NOT applied here.
-- =============================================================================

CREATE TYPE "EnterpriseProvisioningRequestStatus" AS ENUM (
  'PENDING',
  'COMPLETED',
  'FAILED'
);

CREATE TABLE "enterprise_provisioning_requests" (
  "id"                     UUID NOT NULL DEFAULT gen_random_uuid(),
  "idempotency_key"        VARCHAR(120) NOT NULL,
  "payload_hash"           VARCHAR(64) NOT NULL,
  "status"                 "EnterpriseProvisioningRequestStatus" NOT NULL DEFAULT 'PENDING',
  "external_contract_ref"  VARCHAR(200),
  "result_organization_id" UUID,
  "result_json"            JSONB,
  "failure_reason"         VARCHAR(400),
  "requested_by_user_id"   UUID NOT NULL,
  "created_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "enterprise_provisioning_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "enterprise_provisioning_requests_idempotency_key_key"
  ON "enterprise_provisioning_requests" ("idempotency_key");
CREATE INDEX "enterprise_provisioning_requests_external_contract_ref_idx"
  ON "enterprise_provisioning_requests" ("external_contract_ref");
