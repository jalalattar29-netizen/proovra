-- CUSTODY APPEND-ONLY (2026-09-29, ET-CUS-04). Additive only: one trigger
-- function and two triggers. No row, column or constraint is changed.
--
-- custody_events (the per-record chain of custody) and admin_audit_logs (the
-- platform audit chain) were append-only by convention only: any credential
-- with DML on the table could rewrite or erase history, and a fully
-- hash-stripped custody chain verified as "legacy". The database now refuses
-- UPDATE and DELETE on both tables for every role. Removing the protection
-- requires DDL (DROP/DISABLE TRIGGER), which is a visible schema change rather
-- than an ordinary write.

CREATE OR REPLACE FUNCTION "proovra_refuse_history_rewrite"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS "custody_events_append_only" ON "custody_events";
CREATE TRIGGER "custody_events_append_only"
  BEFORE UPDATE OR DELETE ON "custody_events"
  FOR EACH ROW EXECUTE FUNCTION "proovra_refuse_history_rewrite"();

DROP TRIGGER IF EXISTS "admin_audit_logs_append_only" ON "admin_audit_logs";
CREATE TRIGGER "admin_audit_logs_append_only"
  BEFORE UPDATE OR DELETE ON "admin_audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "proovra_refuse_history_rewrite"();
