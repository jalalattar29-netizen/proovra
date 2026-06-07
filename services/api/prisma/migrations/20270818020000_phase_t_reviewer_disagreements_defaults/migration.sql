-- Phase T — repair missing defaults on reviewer_disagreements.

ALTER TABLE IF EXISTS "reviewer_disagreements"
  ALTER COLUMN "id" SET DEFAULT gen_random_uuid(),
  ALTER COLUMN "updated_at" SET DEFAULT now();
