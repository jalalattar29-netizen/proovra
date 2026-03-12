ALTER TABLE "public"."evidence"
  ADD COLUMN IF NOT EXISTS "tsa_provider" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "tsa_url" VARCHAR(512),
  ADD COLUMN IF NOT EXISTS "tsa_serial_number" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "tsa_gen_time_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "tsa_token_base64" TEXT,
  ADD COLUMN IF NOT EXISTS "tsa_message_imprint" VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "tsa_hash_algorithm" VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "tsa_status" VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "tsa_failure_reason" TEXT;