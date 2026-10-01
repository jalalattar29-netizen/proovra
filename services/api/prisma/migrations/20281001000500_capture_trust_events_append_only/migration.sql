-- UC-TRUST-004 — the capture trust-event sub-chain is append-only, like custody_events.
--
-- Rows were hash-linked on write but could be edited or deleted silently. The same
-- canonical refusal function the custody chain uses (20280805000000_custody_append_only)
-- now guards capture_trust_event_records; nothing in the product updates or deletes them
-- (no code path, no cascade), and verification recomputes the chain on read.
--
-- EXPAND. Trigger only. Idempotent. Safe before or after any image.
DROP TRIGGER IF EXISTS "capture_trust_event_records_append_only" ON "capture_trust_event_records";
CREATE TRIGGER "capture_trust_event_records_append_only"
  BEFORE UPDATE OR DELETE ON "capture_trust_event_records"
  FOR EACH ROW EXECUTE FUNCTION "proovra_refuse_history_rewrite"();
