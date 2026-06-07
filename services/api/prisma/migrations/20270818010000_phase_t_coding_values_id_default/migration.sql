-- Phase T — repair missing default for coding_values.id.

ALTER TABLE IF EXISTS "coding_values"
  ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
