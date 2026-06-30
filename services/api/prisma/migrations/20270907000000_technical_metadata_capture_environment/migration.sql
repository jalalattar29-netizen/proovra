-- Enterprise Technical Metadata + Capture Environment layer.
-- Additive, nullable-only. No backfill, no destructive changes, no FK/enum changes.

-- Per-part deterministic Layer-1 technical metadata (canonical).
ALTER TABLE "evidence_parts"
  ADD COLUMN IF NOT EXISTS "technical_metadata" JSONB,
  ADD COLUMN IF NOT EXISTS "technical_meta_parsed_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "technical_meta_parser" VARCHAR(64);

-- Evidence-level mirror (single-file convenience) + privacy-safe capture environment.
ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "technical_metadata" JSONB,
  ADD COLUMN IF NOT EXISTS "capture_environment" JSONB;
