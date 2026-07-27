-- PHASE 10 §13.2 (2026-07-22) — identity/account mode.
-- Additive + safe: new enum + NOT NULL column with a STANDARD default so
-- every existing row is classified as a normal self-service identity.
-- No existing account is converted to MANAGED_ENTERPRISE by this
-- migration; conversion is an explicit, audited admin action.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'UserIdentityMode') THEN
    CREATE TYPE "UserIdentityMode" AS ENUM ('STANDARD', 'MANAGED_ENTERPRISE');
  END IF;
END
$$;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "identity_mode" "UserIdentityMode" NOT NULL DEFAULT 'STANDARD';
