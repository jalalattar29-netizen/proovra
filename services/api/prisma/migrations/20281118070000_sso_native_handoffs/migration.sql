-- =============================================================================
-- 2026-11-04 — MOBILE-002: Enterprise SSO sign-in for the native app.
--
-- EXPAND / SAFE_TO_APPLY_NOW, no backfill. A new table; nothing existing is
-- altered. The SSO callback (OIDC) and ACS (SAML) set a browser cookie, which
-- the phone app cannot use, so SSO-required members could not sign in on it.
-- A native attempt records its PKCE challenge here at initiate; after the IdP
-- answer is verified the callback records the verified identity under a
-- single-use code (hash only) and redirects to proovra://sso/complete. The app
-- redeems the code with its verifier at POST /v1/auth/sso/native/exchange. No
-- session token is stored here.
--
-- Apply BEFORE the API image (its Prisma client maps the table). An older image
-- never reads it. Rollback: leave the table.
-- =============================================================================

CREATE TABLE "sso_native_handoffs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "state_hash" VARCHAR(64) NOT NULL,
    "code_challenge" VARCHAR(64) NOT NULL,
    "expires_at_utc" TIMESTAMPTZ(6) NOT NULL,
    "code_hash" VARCHAR(64),
    "code_expires_at_utc" TIMESTAMPTZ(6),
    "used_at_utc" TIMESTAMPTZ(6),
    "user_id" UUID,
    "email" VARCHAR(320),
    "team_id" UUID,
    "sso_connection_id" UUID,
    "auth_method" VARCHAR(8),
    "idp_context" VARCHAR(256),
    "idp_auth_at_utc" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sso_native_handoffs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sso_native_handoffs_state_hash_key" ON "sso_native_handoffs"("state_hash");

CREATE UNIQUE INDEX "sso_native_handoffs_code_hash_key" ON "sso_native_handoffs"("code_hash");

CREATE INDEX "sso_native_handoffs_expires_at_utc_idx" ON "sso_native_handoffs"("expires_at_utc");
