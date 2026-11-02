-- =============================================================================
-- 2026-11-01 — the OIDC client secret, sealed so the code exchange can read it.
--
-- EXPAND / SAFE_TO_APPLY_NOW, no backfill. One nullable text column. No row is
-- rewritten: only a one-way hash of the secret exists today, so it cannot be
-- filled in. A connection keeps NULL until its secret is rotated, and readiness
-- says so. No sign-in could complete on such a connection before this either.
-- =============================================================================

ALTER TABLE "sso_connections" ADD COLUMN IF NOT EXISTS "client_secret_sealed" TEXT;
