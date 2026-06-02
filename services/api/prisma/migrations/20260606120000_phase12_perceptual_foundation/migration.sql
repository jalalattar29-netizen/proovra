-- Phase 12 — Perceptual-similarity foundation (additive only).
--
-- Adds two nullable VARCHAR(16) columns to `evidence_parts` so the
-- worker can persist deterministic 64-bit perceptual hashes (one pHash
-- + one dHash) per image part. Both columns are nullable because:
--
--   * Existing rows have no hash yet — backfill is operator-initiated
--     via the worker, not as part of this migration.
--   * Non-image parts (PDFs, video, audio, generic blobs) will never
--     have a hash and that is operationally correct.
--
-- Sized at VARCHAR(16) because each hash is 64 bits → 16 hex chars.
-- Indexes are added per column with column-existence guards so the
-- INDEX_COLUMN_RISK safety gate is satisfied on partial-state DBs.
--
-- This migration is the Phase O additive pattern: every CREATE / ALTER
-- runs inside a DO $$ ... $$ block guarded by `pg_tables` and
-- `information_schema.columns` so a partial-state DB (table missing,
-- column missing) is a clean no-op. No DROP / RENAME. No data loss.

BEGIN;

-- Sentinel — pre-flight readiness assertion. Mirrors the pattern used
-- by the R7 trust schema fix migration so the audit script can pick
-- up the no-destructive-changes signal.
SELECT 'Phase 12 perceptual foundation: additive-only columns + indexes; no destructive changes.' AS phase_12_readiness;

-- ---------------------------------------------------------------------------
-- evidence_parts: two perceptual-hash columns (nullable, additive)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='evidence_parts') THEN
    EXECUTE 'ALTER TABLE "evidence_parts" ADD COLUMN IF NOT EXISTS "perceptual_phash" VARCHAR(16) NULL';
    EXECUTE 'ALTER TABLE "evidence_parts" ADD COLUMN IF NOT EXISTS "perceptual_dhash" VARCHAR(16) NULL';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Indexes — per-column guards + table guard so the safety gate is happy.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='evidence_parts')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_parts' AND column_name='perceptual_phash'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "evidence_parts_perceptual_phash_idx" ON "evidence_parts" ("perceptual_phash") WHERE "perceptual_phash" IS NOT NULL';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='evidence_parts')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_parts' AND column_name='perceptual_dhash'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "evidence_parts_perceptual_dhash_idx" ON "evidence_parts" ("perceptual_dhash") WHERE "perceptual_dhash" IS NOT NULL';
  END IF;
END $$;

COMMIT;
