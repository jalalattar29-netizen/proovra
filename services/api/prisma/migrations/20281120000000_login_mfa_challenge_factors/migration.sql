-- =============================================================================
-- 2026-11-07 — AUTH-LOCKOUT-NONTOTP (corrected): sign-in checks the second
-- factor the person actually enrolled.
--
-- A passkey or a verified phone used to count as "has MFA" at sign-in while
-- the sign-in step accepted only an authenticator code or a recovery code, so
-- such an account could not finish signing in. The interim fix stopped
-- counting those factors, which let the account sign in with a password alone
-- and bypassed the person's own MFA choice. The sign-in challenge now carries
-- the state its passkey and phone-code answers need, on the same
-- `mfa_pending_challenges` row that already owns the sign-in second factor:
--
--   passkey_challenge               WebAuthn challenge the assertion must sign
--   passkey_handoff_token_hash      SHA-256 of the single-use token the mobile
--                                   app's system browser presents
--   passkey_verified_at             set when that browser proved the passkey;
--                                   the app's own verify call then completes
--   contact_factor_id               the enrolled phone factor a code was sent to
--   contact_verification_attempt_id the verification attempt that code belongs to
--   contact_team_id                 the tenant the attempt was recorded under
--
-- EXPAND / SAFE_TO_APPLY_NOW. Nullable columns only, no index: the handoff hash
-- is a SHA-256 of a 256-bit random token on a small, hourly-swept table, so a
-- lookup by it needs no index and its uniqueness needs no constraint. No row is
-- rewritten and an older image never reads them. Rollback: leave the columns.
-- =============================================================================

ALTER TABLE "mfa_pending_challenges"
  ADD COLUMN "passkey_challenge" VARCHAR(128),
  ADD COLUMN "passkey_handoff_token_hash" VARCHAR(64),
  ADD COLUMN "passkey_verified_at" TIMESTAMPTZ(6),
  ADD COLUMN "contact_factor_id" UUID,
  ADD COLUMN "contact_verification_attempt_id" UUID,
  ADD COLUMN "contact_team_id" UUID;
