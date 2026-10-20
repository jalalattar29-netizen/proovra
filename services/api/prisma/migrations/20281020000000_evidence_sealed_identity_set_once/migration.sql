-- AUD-43 (2026-10-20) — THE SEALED IDENTITY OF A RECORD IS SET ONCE. EXPAND ONLY.
--
-- Finalization writes, in one guarded UPDATE, the facts every report, package
-- and verifier binds to: the content digest and its semantics, the canonical
-- fingerprint, the Ed25519 signature with its key identity, and the signed
-- version of the stored original. Nothing in the database stopped a later
-- UPDATE from changing or clearing them, so an issued report could come to
-- describe a record whose stored identity no longer matched it.
--
-- One BEFORE UPDATE trigger refuses any change to a sealed column that already
-- holds a value (NULL -> value stays allowed: that IS the seal, and an older
-- record that never carried a column can still receive it). Same contract as
-- evidence_verification_ref_set_once (20281014000000).
--
-- SAFE BEFORE THE NEW CODE: no image changes a sealed column once written
-- (finalization claims only CREATED / UPLOADING rows; the purge tombstone
-- leaves them). No row is rewritten. Idempotent. ROLLBACK: drop the trigger.

CREATE OR REPLACE FUNCTION "evidence_sealed_identity_set_once"() RETURNS trigger AS $fn$
BEGIN
  IF (OLD."file_sha256" IS NOT NULL AND (NEW."file_sha256" IS NULL OR NEW."file_sha256" <> OLD."file_sha256"))
     OR (OLD."fingerprint_hash" IS NOT NULL AND (NEW."fingerprint_hash" IS NULL OR NEW."fingerprint_hash" <> OLD."fingerprint_hash"))
     OR (OLD."fingerprint_canonical_json" IS NOT NULL AND (NEW."fingerprint_canonical_json" IS NULL OR NEW."fingerprint_canonical_json" <> OLD."fingerprint_canonical_json"))
     OR (OLD."signature_base64" IS NOT NULL AND (NEW."signature_base64" IS NULL OR NEW."signature_base64" <> OLD."signature_base64"))
     OR (OLD."signed_at_utc" IS NOT NULL AND (NEW."signed_at_utc" IS NULL OR NEW."signed_at_utc" <> OLD."signed_at_utc"))
     OR (OLD."signing_key_id" IS NOT NULL AND (NEW."signing_key_id" IS NULL OR NEW."signing_key_id" <> OLD."signing_key_id"))
     OR (OLD."signing_key_version" IS NOT NULL AND (NEW."signing_key_version" IS NULL OR NEW."signing_key_version" <> OLD."signing_key_version"))
     OR (OLD."signing_key_sha256" IS NOT NULL AND (NEW."signing_key_sha256" IS NULL OR NEW."signing_key_sha256" <> OLD."signing_key_sha256"))
     OR (OLD."multipart_manifest_sha256" IS NOT NULL AND (NEW."multipart_manifest_sha256" IS NULL OR NEW."multipart_manifest_sha256" <> OLD."multipart_manifest_sha256"))
     OR (OLD."hash_semantics" IS NOT NULL AND (NEW."hash_semantics" IS NULL OR NEW."hash_semantics" <> OLD."hash_semantics"))
     OR (OLD."storage_version_id" IS NOT NULL AND (NEW."storage_version_id" IS NULL OR NEW."storage_version_id" <> OLD."storage_version_id"))
  THEN
    RAISE EXCEPTION 'evidence sealed identity is permanent once written'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "evidence_sealed_identity_set_once" ON "evidence";
CREATE TRIGGER "evidence_sealed_identity_set_once"
  BEFORE UPDATE ON "evidence"
  FOR EACH ROW EXECUTE FUNCTION "evidence_sealed_identity_set_once"();
