-- =============================================================================
-- SIGNING-KEY PURPOSE (2026-10-07).
--
-- The signing-key registry served one purpose — the evidence signature — and
-- the verification-package seal began registering its key in the same rows.
-- With no purpose column, a row registered for a package seal was
-- indistinguishable from an evidence-signing key: an evidence row naming that
-- (key_id, version) would have been verified against it, and in the default
-- configuration (no PACKAGE_SIGNING_* identity) the two signers share one
-- (key_id, version).
--
-- Every row now states its purpose, and uniqueness is per purpose: the same key
-- material MAY be published for both purposes, as two rows, and the evidence
-- path accepts only EVIDENCE_SIGNATURE rows.
--
--   purpose             EVIDENCE_SIGNATURE | PACKAGE_SEAL. Existing rows were
--                       written by the evidence signer and its seed, so they
--                       are EVIDENCE_SIGNATURE (constant DEFAULT: catalog-only).
--   algorithm           Ed25519 — the only algorithm the registry verifies.
--   fingerprint_sha256  SHA-256 of the DER SubjectPublicKeyInfo, recorded at
--                       registration. NULL on rows registered before this
--                       migration (computed from public_key_pem on read).
--
-- Purpose, algorithm and a recorded fingerprint join the immutable identity:
-- the trigger refuses changing them (a NULL fingerprint may be filled once,
-- with the value computed from the stored key).
--
-- SAFE BEFORE THE NEW CODE: previous images register evidence keys without a
-- purpose and get EVIDENCE_SIGNATURE, and look keys up by (key_id, version),
-- which still finds their row. Nothing is backfilled or rewritten.
-- =============================================================================

ALTER TABLE "signing_keys" ADD COLUMN IF NOT EXISTS "purpose" VARCHAR(32) NOT NULL DEFAULT 'EVIDENCE_SIGNATURE';
ALTER TABLE "signing_keys" ADD COLUMN IF NOT EXISTS "algorithm" VARCHAR(16) NOT NULL DEFAULT 'Ed25519';
ALTER TABLE "signing_keys" ADD COLUMN IF NOT EXISTS "fingerprint_sha256" VARCHAR(64);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signing_keys_purpose_check') THEN
    ALTER TABLE "signing_keys"
      ADD CONSTRAINT "signing_keys_purpose_check"
      CHECK ("purpose" IN ('EVIDENCE_SIGNATURE', 'PACKAGE_SEAL'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signing_keys_algorithm_check') THEN
    ALTER TABLE "signing_keys"
      ADD CONSTRAINT "signing_keys_algorithm_check"
      CHECK ("algorithm" IN ('Ed25519'));
  END IF;
END $$;

-- The purpose-aware identity key, then (only once it exists) the retirement of
-- the purpose-blind (key_id, version) key, in one guarded block.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'signing_keys' AND column_name = 'key_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'signing_keys' AND column_name = 'version'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "signing_keys_key_id_version_purpose_key" ON "signing_keys" ("key_id", "version", "purpose")';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "signing_keys_fingerprint_sha256_idx" ON "signing_keys" ("fingerprint_sha256");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'signing_keys_key_id_version_purpose_key'
  ) THEN
    RAISE EXCEPTION
      'signing-key purpose refused: the (key_id, version, purpose) key is missing, so retiring (key_id, version) would leave the registry without identity uniqueness';
  END IF;
  EXECUTE 'DROP INDEX IF EXISTS "signing_keys_key_id_version_key"';
END $$;

-- Identity is immutable, now including purpose, algorithm and a recorded
-- fingerprint. A revocation still cannot be cleared; rows are still never
-- deleted (the no-delete trigger is unchanged).
CREATE OR REPLACE FUNCTION "signing_keys_identity_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."public_key_pem" <> OLD."public_key_pem"
     OR NEW."key_id" <> OLD."key_id"
     OR NEW."version" <> OLD."version"
     OR NEW."purpose" <> OLD."purpose"
     OR NEW."algorithm" <> OLD."algorithm" THEN
    RAISE EXCEPTION 'signing_keys identity is immutable (rotate with a new version)'
      USING ERRCODE = 'check_violation';
  END IF;
  -- A recorded fingerprint may be neither changed nor cleared.
  IF OLD."fingerprint_sha256" IS NOT NULL
     AND (NEW."fingerprint_sha256" IS NULL OR NEW."fingerprint_sha256" <> OLD."fingerprint_sha256") THEN
    RAISE EXCEPTION 'a recorded signing key fingerprint is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS NULL THEN
    RAISE EXCEPTION 'a signing key revocation cannot be cleared'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
