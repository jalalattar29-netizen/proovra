-- F-01 / F-25 (independent forward audit, 2026-10-21) — THE CAPTURE FACTS A
-- SIGNED FINGERPRINT COMMITS TO ARE PERMANENT ONCE IT IS WRITTEN. EXPAND ONLY.
--
-- The fingerprint signed at finalization (fingerprint_canonical_json) binds the
-- record's capture time, device clock and GPS fix. The row columns those values
-- came from were not protected: the secure-intake submit wrote lat / lng /
-- location_source / device_time_iso before checking whether the record was
-- already sealed, so a retried or racing submit rewrote a sealed record's
-- location — every report, package and verifier read the new row while the
-- signature still committed to the old values. A report run also rewrote the
-- structure field capture_method.
--
-- One BEFORE UPDATE trigger refuses any change (including to or from NULL;
-- compared null-safely as text) of
-- these columns once the record carries a fingerprint. Before the seal they are
-- writable: finalization itself writes them in the same UPDATE that sets the
-- fingerprint (OLD.fingerprint_hash is NULL there). size_bytes and the storage
-- pointers are deliberately excluded: the destruction tombstone rewrites them.
--
-- SAFE BEFORE THE NEW CODE: production code writes none of these columns after
-- the seal except the defects this closes (the intake pre-seal write is moved
-- into the seal transaction; the report commit no longer rewrites
-- capture_method). No row is rewritten. Idempotent. ROLLBACK: drop the trigger.

CREATE OR REPLACE FUNCTION "evidence_sealed_capture_facts_set_once"() RETURNS trigger AS $fn$
BEGIN
  IF OLD."fingerprint_hash" IS NOT NULL AND (
       coalesce(NEW."lat"::text, chr(1)) <> coalesce(OLD."lat"::text, chr(1))
    OR coalesce(NEW."lng"::text, chr(1)) <> coalesce(OLD."lng"::text, chr(1))
    OR coalesce(NEW."accuracy_meters"::text, chr(1)) <> coalesce(OLD."accuracy_meters"::text, chr(1))
    OR coalesce(NEW."location_source"::text, chr(1)) <> coalesce(OLD."location_source"::text, chr(1))
    OR coalesce(NEW."device_time_iso"::text, chr(1)) <> coalesce(OLD."device_time_iso"::text, chr(1))
    OR coalesce(NEW."captured_at_utc"::text, chr(1)) <> coalesce(OLD."captured_at_utc"::text, chr(1))
    OR coalesce(NEW."capture_method"::text, chr(1)) <> coalesce(OLD."capture_method"::text, chr(1))
  ) THEN
    RAISE EXCEPTION 'evidence sealed capture facts are permanent once the fingerprint is written'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "evidence_sealed_capture_facts_set_once" ON "evidence";
CREATE TRIGGER "evidence_sealed_capture_facts_set_once"
  BEFORE UPDATE ON "evidence"
  FOR EACH ROW EXECUTE FUNCTION "evidence_sealed_capture_facts_set_once"();
