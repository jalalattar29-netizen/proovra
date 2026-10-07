-- =============================================================================
-- HELD — retire verification_packages.external_disclosure_artifact (2026-10-07).
--
-- 20281005000000 added this JSONB column to carry the EXTERNAL_DISCLOSURE
-- package as a companion of the FULL_FORENSIC row. 20281006000000 made every
-- sealed package its own row, and from that image onward NOTHING reads or
-- writes the column: the external package is a row with its own id, state,
-- digest, seal key and lifecycle. This is the contract half: drop it.
--
-- HELD, NOT DEPLOYABLE: it sits in prisma/migrations-held/ so no runner can
-- apply it before the image that stopped using the column is live everywhere.
-- Promote it (git mv into prisma/migrations/, remove the field from
-- schema.prisma in the same commit) only on proof of both conditions below.
--
-- READINESS GUARD: refuse if any row still carries a value — a database where
-- an older image wrote companions would lose that record. (No production
-- database has ever applied 20281005000000; the guard makes that a checked
-- fact, not an assumption.)
-- =============================================================================
DO $$
DECLARE
  carried BIGINT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'verification_packages' AND column_name = 'external_disclosure_artifact'
  ) THEN
    EXECUTE 'SELECT count(*) FROM "verification_packages" WHERE "external_disclosure_artifact" IS NOT NULL' INTO carried;
    IF carried > 0 THEN
      RAISE EXCEPTION
        'external_disclosure_artifact retirement refused: % row(s) still carry a companion package; convert them to EXTERNAL_DISCLOSURE rows first',
        carried;
    END IF;
  END IF;
END $$;

ALTER TABLE "verification_packages" DROP COLUMN IF EXISTS "external_disclosure_artifact";
