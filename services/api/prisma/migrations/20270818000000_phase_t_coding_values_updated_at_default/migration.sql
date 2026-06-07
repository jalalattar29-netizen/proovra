-- Phase T — repair missing default for coding_values.updated_at.

ALTER TABLE IF EXISTS "coding_values"
  ALTER COLUMN "updated_at" SET DEFAULT now();
