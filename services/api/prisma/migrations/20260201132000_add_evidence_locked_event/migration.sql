DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'CustodyEventType' AND e.enumlabel = 'EVIDENCE_LOCKED'
  ) THEN
    ALTER TYPE "CustodyEventType" ADD VALUE 'EVIDENCE_LOCKED';
  END IF;
END $$;
