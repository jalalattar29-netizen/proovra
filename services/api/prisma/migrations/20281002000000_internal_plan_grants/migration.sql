-- INTERNAL PLAN GRANT — provider-independent, reversible plan access (TEAM only).
--
-- A Platform Admin can give an existing account internal TEAM access for testing
-- without a Stripe/PayPal subscription, payment, billing attempt or credits. The
-- canonical effective-plan resolution takes the HIGHER of the provider-derived
-- plan (entitlements.plan) and an active, unexpired grant, and reports which one
-- governs (INTERNAL_GRANT). Revoking or expiring a grant returns the account to
-- what the providers say; nothing is deleted.
--
-- EXPAND. One new enum, one new table, constraints on that table only. No
-- existing row is read or written; no backfill. Plain CREATE (no IF NOT EXISTS):
-- an object that already exists is a different object and must fail loudly. Rollback: drop the table and the
-- enum (no other object references them) — after the code no longer reads them.

CREATE TYPE "PlanGrantSource" AS ENUM ('INTERNAL_TEST');

CREATE TABLE "plan_grants" (
  "id"                  UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id"             UUID NOT NULL,
  "plan"                "PlanType" NOT NULL,
  "source"              "PlanGrantSource" NOT NULL,
  "reason"              VARCHAR(500) NOT NULL,
  "granted_by_user_id"  UUID NOT NULL,
  "granted_at_utc"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "expires_at_utc"      TIMESTAMPTZ(6),
  "revoked_at_utc"      TIMESTAMPTZ(6),
  "revoked_by_user_id"  UUID,
  "revocation_reason"   VARCHAR(64),
  "idempotency_key"     VARCHAR(120) NOT NULL,
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "plan_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "plan_grants_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- No arbitrary plan values: only TEAM is grantable.
  CONSTRAINT "plan_grants_plan_team_only" CHECK ("plan" = 'TEAM'),
  CONSTRAINT "plan_grants_reason_present" CHECK (length(btrim("reason")) > 0),
  -- A revocation is complete or absent: never half-recorded.
  CONSTRAINT "plan_grants_revocation_complete" CHECK (
    ("revoked_at_utc" IS NULL AND "revocation_reason" IS NULL)
    OR ("revoked_at_utc" IS NOT NULL AND "revocation_reason" IS NOT NULL)
  ),
  CONSTRAINT "plan_grants_expiry_after_grant" CHECK (
    "expires_at_utc" IS NULL OR "expires_at_utc" > "granted_at_utc"
  )
);

CREATE UNIQUE INDEX "plan_grants_idempotency_key_key"
  ON "plan_grants" ("idempotency_key");
CREATE INDEX "plan_grants_user_id_idx"
  ON "plan_grants" ("user_id");
-- At most ONE unrevoked grant per account and source (raw-schema object: Prisma
-- cannot express WHERE). An expired grant is revoked (reason EXPIRED) by the
-- authority before a new one is applied, so expiry never blocks a re-grant.
CREATE UNIQUE INDEX "plan_grants_one_unrevoked_per_user_source"
  ON "plan_grants" ("user_id", "source") WHERE "revoked_at_utc" IS NULL;
