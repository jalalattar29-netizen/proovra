-- Expand user country field from 2 to 120 characters to support full country names
-- This is safe: all existing data will fit within 120 characters
-- Existing 2-char codes (e.g., "DE", "US") will remain intact
ALTER TABLE "public"."users"
  ALTER COLUMN "country" TYPE VARCHAR(120);
