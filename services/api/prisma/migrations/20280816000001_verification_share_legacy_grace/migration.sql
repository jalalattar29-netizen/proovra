-- =============================================================================
-- LEGACY RECORD-ID VERIFY LINKS — BOUNDED GRACE (2026-09-30, ET-PKG-07). BACKFILL.
--
-- Every record published before share tokens existed is reachable at
-- /verify/<evidence id>, and that address is already printed in issued reports
-- and their QR codes. Turning it off at deploy would break every document in
-- circulation; leaving it on forever keeps the permanent UUID capability the
-- finding is about.
--
-- The transition is bounded: each record that is PUBLISHED and signed when this
-- runs may be verified by its id for 180 more days (LEGACY_VERIFY_LINK_GRACE_DAYS
-- in the verification-share authority). After that only a share token works.
-- An owner can end a record's legacy link earlier; nothing extends it; a record
-- published after this migration never has one.
--
-- FIRST APPLICATION ONLY. The UPDATE runs only while no row carries a legacy
-- date yet. A later re-run would otherwise hand a record-id capability to
-- records their owners published afterwards, through share links alone.
--
-- Apply AFTER 20280816000000 and BEFORE the ET-PKG-07 API image: the new image
-- serves a record-id link only inside this window, so a record without the
-- date is not reachable by id at all.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'evidence' AND column_name = 'legacy_verify_uuid_until_utc'
  ) AND NOT EXISTS (
    SELECT 1 FROM "evidence" WHERE "legacy_verify_uuid_until_utc" IS NOT NULL
  ) THEN
    UPDATE "evidence"
       SET "legacy_verify_uuid_until_utc" = CURRENT_TIMESTAMP + INTERVAL '180 days'
     WHERE "public_verify_state" = 'PUBLISHED'
       AND "signed_at_utc" IS NOT NULL
       AND "lifecycle_state" <> 'DESTROYED';
  END IF;
END $$;
