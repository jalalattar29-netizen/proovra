-- Safe expand or create user country field

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'country'
  ) THEN
    -- Column exists → expand it
    ALTER TABLE "public"."users"
    ALTER COLUMN "country" TYPE VARCHAR(120);
  ELSE
    -- Column does NOT exist → create it
    ALTER TABLE "public"."users"
    ADD COLUMN "country" VARCHAR(120);
  END IF;
END $$;