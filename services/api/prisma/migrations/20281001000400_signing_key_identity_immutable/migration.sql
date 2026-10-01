-- UC-TRUST-003 — an evidence signing key's identity cannot change under the records it signed.
--
-- 1. evidence.signing_key_sha256: the SPKI SHA-256 of the public key that verified the
--    record's signature AT SIGNING TIME (the signer self-verifies before it is written).
--    Verification compares it with the registered key, so a key row that was later replaced
--    can no longer make an old signature look valid. NULL on records signed before this
--    migration (they are verified against the registered key as before).
-- 2. signing_keys rows are immutable in identity (key_id, version, public_key_pem), a
--    revocation cannot be cleared, and rows are never deleted — rotation is a NEW version.
--    The seed previously upserted public_key_pem and cleared revoked_at.
--
-- EXPAND. Additive column + two triggers. Idempotent. Apply BEFORE the API image that
-- writes signing_key_sha256. ROLLBACK: drop the triggers (the column is harmless).
ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS "signing_key_sha256" VARCHAR(64);

CREATE OR REPLACE FUNCTION "signing_keys_identity_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- The three identity columns are NOT NULL, so <> is exact.
  IF NEW."public_key_pem" <> OLD."public_key_pem"
     OR NEW."key_id" <> OLD."key_id"
     OR NEW."version" <> OLD."version" THEN
    RAISE EXCEPTION 'signing_keys identity is immutable (rotate with a new version)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS NULL THEN
    RAISE EXCEPTION 'a signing key revocation cannot be cleared'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "signing_keys_identity_immutable" ON "signing_keys";
CREATE TRIGGER "signing_keys_identity_immutable"
  BEFORE UPDATE ON "signing_keys"
  FOR EACH ROW EXECUTE FUNCTION "signing_keys_identity_immutable"();

DROP TRIGGER IF EXISTS "signing_keys_no_delete" ON "signing_keys";
CREATE TRIGGER "signing_keys_no_delete"
  BEFORE DELETE ON "signing_keys"
  FOR EACH ROW EXECUTE FUNCTION "proovra_refuse_history_rewrite"();
