-- PHASE 10 §0B (2026-07-23) — MANAGED IDENTITY OWNERSHIP.
--
-- `users.identity_mode` (20270925000000) is a GLOBAL flag. On its own it cannot
-- say WHICH Organization manages the identity — so Organization A setting a
-- global MANAGED_ENTERPRISE would wrongly govern the user's unrelated Personal
-- scope and Organization B. This migration binds the managed flag to exactly
-- ONE managing Organization plus the verified provenance that established it.
--
-- Additive + safe: all columns are NULLable, so every existing row keeps
-- STANDARD self-service semantics (identity_mode default + no managing org).
-- MANAGED_ENTERPRISE is authoritative ONLY when managing_organization_id is set.
-- FKs are ON DELETE SET NULL: deprovisioning/removing the managing Org or its
-- SSO connection releases the management binding without deleting the User, the
-- user's Personal custody, or any unrelated Organization membership.
-- NOT APPLIED (authored for deployment).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ManagedIdentitySource') THEN
    CREATE TYPE "ManagedIdentitySource" AS ENUM ('SAML', 'OIDC', 'SCIM', 'DOMAIN');
  END IF;
END
$$;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "managing_organization_id" UUID,
  ADD COLUMN IF NOT EXISTS "managed_identity_source" "ManagedIdentitySource",
  ADD COLUMN IF NOT EXISTS "managed_by_sso_connection_id" UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_managing_organization_id_fkey'
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_managing_organization_id_fkey"
      FOREIGN KEY ("managing_organization_id") REFERENCES "organizations"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_managed_by_sso_connection_id_fkey'
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_managed_by_sso_connection_id_fkey"
      FOREIGN KEY ("managed_by_sso_connection_id") REFERENCES "sso_connections"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "users_managing_organization_id_idx"
  ON "users"("managing_organization_id");
