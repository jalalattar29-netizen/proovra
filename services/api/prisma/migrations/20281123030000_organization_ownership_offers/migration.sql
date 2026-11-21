-- =============================================================================
-- 2026-11-21 — NEW-RG-26-4 / owner decision E (DEC-18): organization ownership
-- moves by OFFER, recipient ACCEPTANCE and step-up.
--
-- POST /v1/orgs/:id/transfer-ownership made another member the organization
-- owner (and the owner of every organization workspace the outgoing owner
-- held) in one call, with no acceptance by the recipient. An offer row now
-- records the owner's intent; nothing moves until the named recipient accepts
-- with their own step-up. Statuses: PENDING / ACCEPTED / DECLINED / CANCELLED
-- / SUPERSEDED / EXPIRED. One PENDING offer per organization is kept by the
-- service under the organization owners' advisory lock (a new offer supersedes
-- the previous one; accept, decline and cancel take the same lock).
--
-- EXPAND / SAFE_TO_APPLY_NOW. A new table only; no existing row is read or
-- rewritten and an older image never touches it. No foreign keys (the rows are
-- history of a lifecycle act, kept like activity rows), as for
-- workspace_ownership_offers. Rollback: leave the table, or drop it once no
-- image references it.
-- =============================================================================

CREATE TABLE "organization_ownership_offers" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "from_user_id" UUID NOT NULL,
  "to_user_id" UUID NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at_utc" TIMESTAMPTZ(6) NOT NULL,
  "decided_at_utc" TIMESTAMPTZ(6),

  CONSTRAINT "organization_ownership_offers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "organization_ownership_offers_organization_id_status_idx"
  ON "organization_ownership_offers" ("organization_id", "status");

CREATE INDEX "organization_ownership_offers_to_user_id_status_idx"
  ON "organization_ownership_offers" ("to_user_id", "status");
