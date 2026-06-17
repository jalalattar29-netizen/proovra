-- Intake Links — location collection policy + Evidence location source
-- provenance. Two additive columns, both safe to deploy under
-- prisma deploy without locking either table:
--
--   1. workflow_intake_links.location_policy
--        VARCHAR(20) NOT NULL DEFAULT 'NONE'
--      Default 'NONE' is intentional: every link created before this
--      migration shipped with no location prompt at all. Backfilling
--      'NONE' preserves that behaviour exactly. The Create-link modal
--      defaults NEW links to 'OPTIONAL', so the change is opt-in per
--      link via the operator UI, never silently retroactive.
--
--   2. evidence.location_source
--        VARCHAR(40) NULL
--      Holds the provenance of the (lat, lng, accuracy_meters) tuple.
--      Backfilled to CAPTURE_BROWSER_GEOLOCATION for every existing
--      row that already has coordinates — pre-intake-link-location,
--      that was the only source that ever wrote coordinates. Rows
--      without coordinates stay NULL.
--
-- Both writes are gated by the Phase O-Final guarded-INDEX /
-- guarded-COLUMN pattern (information_schema existence checks) so
-- partial replay is safe.

ALTER TABLE "workflow_intake_links"
  ADD COLUMN IF NOT EXISTS "location_policy" VARCHAR(20) NOT NULL DEFAULT 'NONE';

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "location_source" VARCHAR(40);

-- Backfill: stamp the provenance of historical coordinates. The
-- guard checks the column exists before the UPDATE so a partial
-- replay (where ADD COLUMN succeeded but UPDATE didn't) is safe.
-- WHERE clause restricts to rows that actually have coordinates;
-- every other row keeps location_source NULL, which the display
-- layer treats as "no location available".
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'evidence'
       AND column_name  = 'location_source'
  ) THEN
    EXECUTE $sql$
      UPDATE "evidence"
         SET "location_source" = 'CAPTURE_BROWSER_GEOLOCATION'
       WHERE "lat" IS NOT NULL
         AND "location_source" IS NULL
    $sql$;
  END IF;
END $$;
