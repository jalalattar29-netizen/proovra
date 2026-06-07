-- Subprocessor version-history runtime repair.
--
-- Runtime evidence:
--   * POST /v1/trust/subprocessors/seed currently fails with
--     SCHEMA_NOT_READY on prisma.subprocessorVersion.create().
--   * The active Prisma model for SubprocessorVersion expects:
--       - changeNote      @map("change_note")
--       - effectiveAt     @map("effective_at") @default(now())
--   * The audited database has `change_summary` and `effective_at`,
--     but is missing `change_note`, and `effective_at` has no default.
--
-- Hard rules:
--   * Additive only.
--   * Idempotent.
--   * No destructive rewrites.

ALTER TABLE IF EXISTS "subprocessor_versions"
  ADD COLUMN IF NOT EXISTS "change_note" VARCHAR(800);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'subprocessor_versions'
      AND column_name = 'effective_at'
  ) THEN
    EXECUTE 'ALTER TABLE "subprocessor_versions" ALTER COLUMN "effective_at" SET DEFAULT NOW()';
  END IF;
END $$;
