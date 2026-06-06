-- Phase T — coding schema UUID default repair for production DB drift.
-- This migration only fixes the missing id defaults on existing tables.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE IF EXISTS "coding_schemas"
  ALTER COLUMN "id" SET DEFAULT gen_random_uuid();

ALTER TABLE IF EXISTS "coding_fields"
  ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
