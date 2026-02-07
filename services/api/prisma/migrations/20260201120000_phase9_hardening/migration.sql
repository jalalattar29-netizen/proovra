DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'CustodyEventType' AND e.enumlabel = 'EVIDENCE_DELETED'
  ) THEN
    ALTER TYPE "CustodyEventType" ADD VALUE 'EVIDENCE_DELETED';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'CustodyEventType' AND e.enumlabel = 'VERIFY_VIEWED'
  ) THEN
    ALTER TYPE "CustodyEventType" ADD VALUE 'VERIFY_VIEWED';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'CustodyEventType' AND e.enumlabel = 'REPORT_DOWNLOADED'
  ) THEN
    ALTER TYPE "CustodyEventType" ADD VALUE 'REPORT_DOWNLOADED';
  END IF;
END $$;

ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS "deleted_at_utc" TIMESTAMPTZ;
ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS "retention_until_utc" TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS "evidence_deleted_at_utc_idx" ON "evidence"("deleted_at_utc");
