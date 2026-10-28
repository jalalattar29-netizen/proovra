-- COLLABORATION TEAM ARCHIVE AND STEP-UP ASSURANCE (2026-10-28).
--
-- A Collaboration Team is never customer-deleted: it is archived, and archive
-- requires a recent step-up answered by the strongest authenticator the
-- person holds — a passkey or security key, an Enterprise IdP
-- reauthentication of sufficient assurance, an authenticator app, and only
-- where the Organization allows it an SMS code.
--
-- EXPAND ONLY. Every statement adds (the one constraint re-created below is
-- strictly widened); nothing is dropped, renamed or rewritten, and every new column is nullable or carries a default that
-- preserves today's behaviour (STANDARD assurance, SMS allowed). Safe to apply
-- before the API image that reads it; the previous image ignores it.
-- Idempotent: every statement is guarded.

-- 1. Passkeys are MFA factors (the factor row owns enrolment, revocation and
--    the generation that kills an approval at spend time).
ALTER TYPE "MfaFactorKind" ADD VALUE IF NOT EXISTS 'PASSKEY';

-- The factor payload CHECK (20271201000000) admits only TOTP secrets and
-- SMS/WHATSAPP destinations; a passkey row carries neither (its key is in
-- mfa_webauthn_credentials). WIDENED ONLY: both existing branches are kept
-- verbatim and a PASSKEY branch is added. Compared AS TEXT for the same 55P04
-- reason as 20271201000000 (a new enum label cannot be used in the
-- transaction that added it).
ALTER TABLE "mfa_factors" DROP CONSTRAINT IF EXISTS "mfa_factors_kind_payload_chk";
ALTER TABLE "mfa_factors" ADD CONSTRAINT "mfa_factors_kind_payload_chk" CHECK (
  (
    "kind"::text = 'TOTP'
    AND "secret_ciphertext" IS NOT NULL
    AND "secret_iv" IS NOT NULL
    AND "secret_auth_tag" IS NOT NULL
    AND "secret_kek_id" IS NOT NULL
    AND "destination_ciphertext" IS NULL
    AND "destination_hash" IS NULL
  )
  OR (
    "kind"::text IN ('SMS', 'WHATSAPP')
    AND "destination_ciphertext" IS NOT NULL
    AND "destination_iv" IS NOT NULL
    AND "destination_auth_tag" IS NOT NULL
    AND "destination_kek_id" IS NOT NULL
    AND "destination_hash" IS NOT NULL
    AND "destination_mask" IS NOT NULL
    AND "secret_ciphertext" IS NULL
  )
  OR (
    "kind"::text = 'PASSKEY'
    AND "secret_ciphertext" IS NULL
    AND "secret_iv" IS NULL
    AND "secret_auth_tag" IS NULL
    AND "secret_kek_id" IS NULL
    AND "destination_ciphertext" IS NULL
    AND "destination_hash" IS NULL
  )
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'mfa_webauthn_credentials') THEN
    CREATE TABLE "mfa_webauthn_credentials" (
        "id" UUID NOT NULL DEFAULT gen_random_uuid(),
        "factor_id" UUID NOT NULL,
        "user_id" UUID NOT NULL,
        "credential_id" VARCHAR(1024) NOT NULL,
        "public_key" BYTEA NOT NULL,
        "sign_count" BIGINT NOT NULL DEFAULT 0,
        "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
        "aaguid" VARCHAR(64),
        "backed_up" BOOLEAN NOT NULL DEFAULT false,
        "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMPTZ(6) NOT NULL,

        CONSTRAINT "mfa_webauthn_credentials_pkey" PRIMARY KEY ("id")
    );
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "mfa_webauthn_credentials_factor_id_key" ON "mfa_webauthn_credentials"("factor_id");
CREATE UNIQUE INDEX IF NOT EXISTS "mfa_webauthn_credentials_credential_id_key" ON "mfa_webauthn_credentials"("credential_id");
CREATE INDEX IF NOT EXISTS "mfa_webauthn_credentials_user_id_idx" ON "mfa_webauthn_credentials"("user_id");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mfa_webauthn_credentials_factor_id_fkey') THEN
    ALTER TABLE "mfa_webauthn_credentials"
      ADD CONSTRAINT "mfa_webauthn_credentials_factor_id_fkey"
      FOREIGN KEY ("factor_id") REFERENCES "mfa_factors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- 2. The step-up challenge records which authenticator answers it, and the
--    single-use system-browser handoff (never a secret: hashes and context
--    identifiers only).
ALTER TABLE "step_up_challenges" ADD COLUMN IF NOT EXISTS "method" VARCHAR(16);
ALTER TABLE "step_up_challenges" ADD COLUMN IF NOT EXISTS "sso_connection_id" UUID;
ALTER TABLE "step_up_challenges" ADD COLUMN IF NOT EXISTS "authn_context" VARCHAR(256);
ALTER TABLE "step_up_challenges" ADD COLUMN IF NOT EXISTS "webauthn_challenge" VARCHAR(128);
ALTER TABLE "step_up_challenges" ADD COLUMN IF NOT EXISTS "handoff_token_hash" VARCHAR(64);
ALTER TABLE "step_up_challenges" ADD COLUMN IF NOT EXISTS "handoff_used_at_utc" TIMESTAMPTZ(6);

-- 3. The Organization's step-up assurance (defaults reproduce today).
ALTER TABLE "organization_security_policies" ADD COLUMN IF NOT EXISTS "step_up_assurance" VARCHAR(24) NOT NULL DEFAULT 'STANDARD';
ALTER TABLE "organization_security_policies" ADD COLUMN IF NOT EXISTS "step_up_sms_allowed" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "organization_security_policies" ADD COLUMN IF NOT EXISTS "idp_step_up_accepted_contexts" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "organization_security_policies" ADD COLUMN IF NOT EXISTS "idp_step_up_max_age_seconds" INTEGER NOT NULL DEFAULT 300;

-- 4. How a session was authenticated, so a recent sufficient IdP sign-in can
--    be recognised without asking for another one.
ALTER TABLE "authenticated_sessions" ADD COLUMN IF NOT EXISTS "auth_method" VARCHAR(16);
ALTER TABLE "authenticated_sessions" ADD COLUMN IF NOT EXISTS "authn_context" VARCHAR(256);
ALTER TABLE "authenticated_sessions" ADD COLUMN IF NOT EXISTS "idp_auth_at_utc" TIMESTAMPTZ(6);

-- 5. Archive provenance on the Collaboration Team row.
ALTER TABLE "collaboration_teams" ADD COLUMN IF NOT EXISTS "archived_by_user_id" UUID;
ALTER TABLE "collaboration_teams" ADD COLUMN IF NOT EXISTS "archive_reason" VARCHAR(500);
