-- Split the dispatcher's idempotency marker out of provider_message_id
-- (which must hold the REAL Twilio SID for webhook correlation + UI
-- delivery tracking) into a dedicated column.
--
-- Background:
--   The intake-link dispatcher was hijacking provider_message_id with
--   synthetic markers like `intake-idem:<hash>`. That clobbered the
--   actual Twilio SID (SM…/MM…), so the status webhook could never
--   match and the UI could never show real delivery state.
--
-- Forward path:
--   1. Add new column `delivery_idempotency_key` VARCHAR(128).
--   2. Backfill: every row whose provider_message_id starts with
--      `intake-idem:` is migrated to the new column AND its
--      provider_message_id is set to NULL (the real SID was never
--      stored — these rows have no recoverable provider tracking).
--   3. Add an index for the dispatcher's lookup
--      (related_intake_link_id, channel, delivery_idempotency_key).
--
-- Safe to re-run: every step is gated on `IF NOT EXISTS` / WHERE
-- clauses so this migration is idempotent under prisma deploy
-- retries.

ALTER TABLE "communication_messages"
  ADD COLUMN IF NOT EXISTS "delivery_idempotency_key" VARCHAR(128);

-- Move the hijacked markers into the new column. Strip the
-- `intake-idem:` prefix so the stored value matches what the
-- dispatcher would write fresh today.
UPDATE "communication_messages"
SET
  "delivery_idempotency_key" = SUBSTRING(
    "provider_message_id" FROM (LENGTH('intake-idem:') + 1)
  ),
  "provider_message_id" = NULL
WHERE "provider_message_id" LIKE 'intake-idem:%';

-- Phase O-Final guarded-INDEX pattern. The CI safety gate
-- (test/phase-o-migration-safety-gate.test.ts) flags CREATE INDEX
-- statements that reference columns without a preceding
-- information_schema.columns existence check. We just added
-- `delivery_idempotency_key` above, but a fresh Postgres without that
-- column (e.g. a partial replay) would otherwise fail mid-migration.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'communication_messages'
       AND column_name  = 'delivery_idempotency_key'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'communication_messages'
       AND column_name  = 'related_intake_link_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'communication_messages'
       AND column_name  = 'channel'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "communication_messages_delivery_idem_uk" ON "communication_messages" ("related_intake_link_id", "channel", "delivery_idempotency_key")';
  END IF;
END $$;
