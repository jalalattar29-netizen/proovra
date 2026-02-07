DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'AuthProvider'
  ) THEN
    CREATE TYPE "AuthProvider" AS ENUM ('GOOGLE', 'APPLE', 'GUEST');
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'TeamRole'
  ) THEN
    CREATE TYPE "TeamRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'PlanType'
  ) THEN
    CREATE TYPE "PlanType" AS ENUM ('FREE', 'PAYG', 'PRO', 'TEAM');
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'PaymentProvider'
  ) THEN
    CREATE TYPE "PaymentProvider" AS ENUM ('STRIPE', 'PAYPAL');
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'PaymentStatus'
  ) THEN
    CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED');
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'SubscriptionStatus'
  ) THEN
    CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'PAST_DUE', 'CANCELED', 'TRIALING');
  END IF;
END $$;

ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS "case_id" UUID;

CREATE TABLE IF NOT EXISTS "users" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" VARCHAR(320),
  "display_name" VARCHAR(120),
  "provider" "AuthProvider" NOT NULL,
  "provider_user_id" VARCHAR(128) NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "users_provider_provider_user_id_key" ON "users"("provider","provider_user_id");
CREATE INDEX IF NOT EXISTS "users_email_idx" ON "users"("email");

CREATE TABLE IF NOT EXISTS "teams" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" VARCHAR(120) NOT NULL,
  "owner_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "teams_owner_user_id_idx" ON "teams"("owner_user_id");

CREATE TABLE IF NOT EXISTS "team_members" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "role" "TeamRole" NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "team_members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE,
  CONSTRAINT "team_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "team_members_team_id_user_id_key" ON "team_members"("team_id","user_id");
CREATE INDEX IF NOT EXISTS "team_members_user_id_idx" ON "team_members"("user_id");

CREATE TABLE IF NOT EXISTS "entitlements" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "plan" "PlanType" NOT NULL,
  "credits" INTEGER NOT NULL DEFAULT 0,
  "team_seats" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "valid_until" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "entitlements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "entitlements_user_id_idx" ON "entitlements"("user_id");

CREATE TABLE IF NOT EXISTS "subscriptions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "provider" "PaymentProvider" NOT NULL,
  "provider_sub_id" VARCHAR(128) NOT NULL,
  "status" "SubscriptionStatus" NOT NULL,
  "plan" "PlanType" NOT NULL,
  "current_period_end" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_provider_provider_sub_id_key" ON "subscriptions"("provider","provider_sub_id");
CREATE INDEX IF NOT EXISTS "subscriptions_user_id_idx" ON "subscriptions"("user_id");

CREATE TABLE IF NOT EXISTS "payments" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "provider" "PaymentProvider" NOT NULL,
  "provider_payment_id" VARCHAR(128) NOT NULL,
  "amount_cents" INTEGER NOT NULL,
  "currency" VARCHAR(8) NOT NULL,
  "status" "PaymentStatus" NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "payments_provider_provider_payment_id_key" ON "payments"("provider","provider_payment_id");
CREATE INDEX IF NOT EXISTS "payments_user_id_idx" ON "payments"("user_id");

CREATE TABLE IF NOT EXISTS "cases" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" VARCHAR(120) NOT NULL,
  "owner_user_id" TEXT NOT NULL,
  "team_id" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "cases_owner_user_id_idx" ON "cases"("owner_user_id");
CREATE INDEX IF NOT EXISTS "cases_team_id_idx" ON "cases"("team_id");
