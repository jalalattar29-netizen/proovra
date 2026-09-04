-- EXTERNAL INTAKE IDENTITY SEARCH.
--
-- `recipient_phone_e164` is the canonical form of `recipient_phone`, derived
-- at write time. The stored value is NOT touched: it is provenance, and one
-- number written three ways ("+49 176 12345678", "+4917612345678",
-- "0049 176 12345678") has to resolve to the same row without rewriting what
-- the operator actually typed.
--
-- The backfill is deliberately conservative. It normalises only the two shapes
-- that are unambiguous from the digits alone — a value already in E.164, and
-- one written with the international "00" prefix — and leaves everything else
-- null. A national number without a country code cannot be normalised without
-- guessing which country it belongs to, and a wrong guess here is a search
-- that quietly finds the wrong customer. New rows get the platform's own
-- normaliser at write time.
ALTER TABLE "workflow_intake_links"
  ADD COLUMN IF NOT EXISTS "recipient_phone_e164" VARCHAR(32);

UPDATE "workflow_intake_links"
SET "recipient_phone_e164" =
  CASE
    WHEN "recipient_phone" IS NULL THEN NULL
    WHEN regexp_replace("recipient_phone", '[^0-9+]', '', 'g') LIKE '+%'
      THEN regexp_replace("recipient_phone", '[^0-9]', '', 'g')
    WHEN regexp_replace("recipient_phone", '[^0-9]', '', 'g') LIKE '00%'
      THEN substring(regexp_replace("recipient_phone", '[^0-9]', '', 'g') FROM 3)
    ELSE NULL
  END
WHERE "recipient_phone" IS NOT NULL
  AND "recipient_phone_e164" IS NULL;

-- The digits above are stored without the leading "+" by the CASE, so put it
-- back for the rows that got a value. Done as a second statement so the
-- normalisation rule above stays readable.
UPDATE "workflow_intake_links"
SET "recipient_phone_e164" = '+' || "recipient_phone_e164"
WHERE "recipient_phone_e164" IS NOT NULL
  AND "recipient_phone_e164" NOT LIKE '+%';

CREATE INDEX IF NOT EXISTS "workflow_intake_links_team_id_recipient_email_idx"
  ON "workflow_intake_links" ("team_id", "recipient_email");
CREATE INDEX IF NOT EXISTS "workflow_intake_links_team_id_recipient_phone_e164_idx"
  ON "workflow_intake_links" ("team_id", "recipient_phone_e164");
