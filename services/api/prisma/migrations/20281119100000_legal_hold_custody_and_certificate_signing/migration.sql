-- =============================================================================
-- 2026-11-04 — GOV-009: a legal hold is a custody record; a destruction
-- certificate carries a signature a customer can verify.
--
-- EXPAND / SAFE_TO_APPLY_NOW, no backfill, no row read or rewritten.
--
-- 1. `evidence_legal_holds` refuses DELETE. Release is a state change
--    (status RELEASED with the releaser, the time and the note), which the code
--    already does; no product path deletes a hold. Team and case references are
--    ON DELETE RESTRICT, and a destroyed record keeps its row (tombstone), so the
--    evidence cascade never fires in product either. UPDATE stays allowed: the
--    release, the approval workflow and the version counter are updates.
--    Uses the refusal 20281102000000 defined for destruction certificates.
--
-- 2. `signing_keys.purpose` gains DESTRUCTION_CERTIFICATE, the registry purpose
--    under which the platform signer's public key is published for verifying a
--    destruction certificate's Ed25519 signature. A row of one purpose is never
--    accepted for another.
-- =============================================================================

CREATE OR REPLACE FUNCTION "proovra_refuse_history_rewrite"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS "evidence_legal_holds_no_delete" ON "evidence_legal_holds";
CREATE TRIGGER "evidence_legal_holds_no_delete"
  BEFORE DELETE ON "evidence_legal_holds"
  FOR EACH ROW EXECUTE FUNCTION "proovra_refuse_history_rewrite"();

ALTER TABLE "signing_keys" DROP CONSTRAINT IF EXISTS "signing_keys_purpose_check";
ALTER TABLE "signing_keys"
  ADD CONSTRAINT "signing_keys_purpose_check"
  CHECK ("purpose" IN ('EVIDENCE_SIGNATURE', 'PACKAGE_SEAL', 'DESTRUCTION_CERTIFICATE'));
