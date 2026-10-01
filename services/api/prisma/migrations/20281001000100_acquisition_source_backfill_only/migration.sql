-- UC-PROV-009 — the acquisition set-once trigger also refuses giving a record that was
-- created WITHOUT an acquisition a contemporaneous-looking source later.
--
-- Before: NULL -> (any mode, 'RECORDED_AT_CREATION') was allowed on UPDATE, so a legacy
-- record could be relabelled as if its channel had been recorded when it was created.
-- After: RECORDED_AT_CREATION is written only by the INSERT that creates the record; a
-- source assigned later must be a BACKFILL_* source, which every reader projects as a
-- backfill. The existing immutability rules are unchanged.
--
-- EXPAND. CREATE OR REPLACE of the trigger FUNCTION only; the trigger binding is untouched.
-- Idempotent. Safe before or after the API image (the image never assigns a source late).
CREATE OR REPLACE FUNCTION "evidence_acquisition_set_once"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."acquisition_mode" IS NOT NULL
     AND (NEW."acquisition_mode" IS NULL
          OR NEW."acquisition_mode" <> OLD."acquisition_mode") THEN
    RAISE EXCEPTION 'evidence.acquisition_mode is immutable once recorded'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."acquisition_mode_source" IS NOT NULL
     AND (NEW."acquisition_mode_source" IS NULL
          OR NEW."acquisition_mode_source" <> OLD."acquisition_mode_source") THEN
    RAISE EXCEPTION 'evidence.acquisition_mode_source is immutable once recorded'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."acquisition_mode_source" IS NULL
     AND NEW."acquisition_mode_source" IS NOT NULL
     AND NEW."acquisition_mode_source" NOT LIKE 'BACKFILL\_%' THEN
    RAISE EXCEPTION 'evidence.acquisition_mode_source % cannot be assigned after creation', NEW."acquisition_mode_source"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
