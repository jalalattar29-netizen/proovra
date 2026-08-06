-- =============================================================================
-- PHASE 12B — truthful Exchange download semantics.
--
-- PROBLEM
-- `evidence_exchange_package_deliveries.downloaded_at_utc` was written by
-- `recordPackageDownload`, which runs when the server AUTHORISES a delivery
-- and a short-lived link is issued. That path has no transfer-completion
-- signal: the bytes move from object storage to the recipient without passing
-- through the API, and an issued link may never be used at all. So the column
-- has been asserting "this package was downloaded" on evidence that only ever
-- proved "a download was authorised".
--
-- FIX
--   * NEW `download_authorized_at_utc` = authorisation / link issuance.
--   * `downloaded_at_utc` is narrowed to CONFIRMED transfer completion only
--     (server streaming/proxy completion or a verified storage-access event).
--     While no such signal exists it stays NULL.
--
-- HISTORICAL ROWS — deterministic, provenance-based, never fabricated.
-- Provenance is unambiguous here: `recordPackageDownload` was the ONLY writer
-- of `downloaded_at_utc`, and it fired at authorisation time. Therefore every
-- existing non-null value IS an authorisation timestamp. This migration MOVES
-- each value into `download_authorized_at_utc` (preserving it exactly) and
-- then clears `downloaded_at_utc`, because that column never represented a
-- confirmed transfer and must not keep claiming one.
--
-- No value is destroyed: every timestamp survives in the column whose meaning
-- it actually had. No row is upgraded to "confirmed download" — doing so would
-- fabricate transfer completion, which is expressly forbidden.
--
-- FORWARD-ONLY and IDEMPOTENT. NOT APPLIED by this change.
-- =============================================================================

-- 1. Add the authorisation column (idempotent).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'evidence_exchange_package_deliveries'
      AND column_name = 'download_authorized_at_utc'
  ) THEN
    ALTER TABLE "evidence_exchange_package_deliveries"
      ADD COLUMN "download_authorized_at_utc" TIMESTAMPTZ(6);
  END IF;
END
$$;

-- 2. Move historical authorisation timestamps into the honest column.
--    Guarded so a re-run cannot overwrite an already-migrated value with NULL.
UPDATE "evidence_exchange_package_deliveries"
SET "download_authorized_at_utc" = "downloaded_at_utc"
WHERE "downloaded_at_utc" IS NOT NULL
  AND "download_authorized_at_utc" IS NULL;

-- 3. Clear the completion column for those historical rows. They were never
--    confirmed transfers. The timestamp is NOT lost — step 2 preserved it.
UPDATE "evidence_exchange_package_deliveries"
SET "downloaded_at_utc" = NULL
WHERE "downloaded_at_utc" IS NOT NULL
  AND "download_authorized_at_utc" IS NOT NULL
  AND "download_authorized_at_utc" = "downloaded_at_utc";

-- 4. Post-condition: no row may claim a confirmed download while carrying an
--    identical authorisation timestamp (that would mean step 3 did not run).
DO $$
DECLARE
  ambiguous BIGINT;
BEGIN
  SELECT COUNT(*) INTO ambiguous
  FROM "evidence_exchange_package_deliveries"
  WHERE "downloaded_at_utc" IS NOT NULL
    AND "download_authorized_at_utc" = "downloaded_at_utc";
  IF ambiguous > 0 THEN
    RAISE EXCEPTION
      'Refusing to complete: % delivery row(s) still assert a confirmed download using an authorisation timestamp.',
      ambiguous;
  END IF;
END
$$;
