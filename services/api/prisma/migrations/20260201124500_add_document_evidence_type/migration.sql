DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'EvidenceType' AND e.enumlabel = 'DOCUMENT'
  ) THEN
    ALTER TYPE "EvidenceType" ADD VALUE 'DOCUMENT';
  END IF;
END $$;
