-- Phase R7 Capture-Trust Schema Fix — HARDENED for partial-state safety.
-- Aligns CaptureDeviceAttestation + CaptureTrustEventRecord Prisma models with
-- the actual fields services/api/src/services/capture-trust/*.ts read + write.
--
-- Hardening rules applied:
--   * ALTER TABLE → IF EXISTS guard
--   * ADD COLUMN  → IF NOT EXISTS guard
--   * DROP NOT NULL → DO block guarded by pg_tables + information_schema.columns
--
-- Capabilities preserved: provenance chain, signed assertions, device
-- attestation, device keys, trust envelopes, offline queue, mobile ingest,
-- verify/report/package integration. No DROP COLUMN.

BEGIN;

-- ---------------------------------------------------------------------------
-- CaptureDeviceAttestation: additive expires_at_utc + provider_metadata.
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "capture_device_attestations"
  ADD COLUMN IF NOT EXISTS "expires_at_utc"    TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "provider_metadata" JSONB;

-- ---------------------------------------------------------------------------
-- CaptureTrustEventRecord: relax evidence_id to nullable + additive device_id.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='capture_trust_event_records')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='capture_trust_event_records' AND column_name='evidence_id'
  ) THEN
    EXECUTE 'ALTER TABLE "capture_trust_event_records" ALTER COLUMN "evidence_id" DROP NOT NULL';
  END IF;
END $$;

ALTER TABLE IF EXISTS "capture_trust_event_records"
  ADD COLUMN IF NOT EXISTS "device_id" UUID;

COMMIT;
