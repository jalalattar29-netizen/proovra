DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'RetentionPolicy'
  ) THEN
    CREATE TYPE "RetentionPolicy" AS ENUM ('YEAR_1','YEAR_5','FOREVER');
  END IF;
END $$;

ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "legal_name" VARCHAR(180);
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "address" TEXT;
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "logo_url" VARCHAR(512);
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "timezone" VARCHAR(64);
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "legal_email" VARCHAR(320);
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "retention_policy" "RetentionPolicy" NOT NULL DEFAULT 'FOREVER';

ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS "locked_at" TIMESTAMPTZ;
ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS "locked_by_user_id" TEXT;

CREATE TABLE IF NOT EXISTS "case_access" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "case_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "case_access_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "case_access_case_id_user_id_key" ON "case_access"("case_id","user_id");
CREATE INDEX IF NOT EXISTS "case_access_case_id_idx" ON "case_access"("case_id");
CREATE INDEX IF NOT EXISTS "case_access_user_id_idx" ON "case_access"("user_id");

CREATE INDEX IF NOT EXISTS "evidence_locked_at_idx" ON "evidence"("locked_at");
