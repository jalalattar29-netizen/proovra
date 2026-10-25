-- MEMBERS & ACCESS HISTORY IS APPEND-ONLY; AN OWNER IS NOT DELETABLE
-- (members audit DOM-12 / DOM-06 / LIFE-05, 2026-10-26).
--
-- 1. APPEND-ONLY HISTORY (DOM-12). The workspace activity trail
--    (team_activities), the organization audit trail
--    (organization_audit_events) and the evidence lifecycle ledger
--    (evidence_lifecycle_events, which carries destruction certificates) were
--    append-only by convention only: any credential with DML could rewrite or
--    erase them, and each cascaded away with its tenant. The same canonical
--    refusal function that guards custody_events and admin_audit_logs
--    (custody append-only, ET-CUS-04) now refuses UPDATE and DELETE on all
--    three, for every role. Nothing in the product updates or deletes their
--    rows: no workspace kind has a self-service hard delete, organizations are
--    archived, evidence is never physically purged, and users are anonymised
--    in place. A cascade from a parent delete is refused too — which is the
--    point: history now outlives any attempt to erase its tenant.
--
-- 2. OWNER RESTRICT (DOM-06). teams.owner_user_id cascaded on user delete, so
--    deleting a user row would have deleted every workspace they owned and,
--    through it, its governance. Users are never deleted (account closure
--    anonymises), so RESTRICT changes no product behaviour; it makes the
--    latent cascade impossible.
--
-- EXPAND-SAFE. Triggers are dropped-if-exists and recreated (idempotent). The
-- foreign key is replaced with the same columns and ON UPDATE rule; only its
-- delete rule changes. No row, column or index is touched.

-- The canonical refusal function (re-declared verbatim, so this migration
-- stands alone on a database restored without the custody migration's body).
CREATE OR REPLACE FUNCTION "proovra_refuse_history_rewrite"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS "team_activities_append_only" ON "team_activities";
CREATE TRIGGER "team_activities_append_only"
  BEFORE UPDATE OR DELETE ON "team_activities"
  FOR EACH ROW EXECUTE FUNCTION "proovra_refuse_history_rewrite"();

DROP TRIGGER IF EXISTS "organization_audit_events_append_only" ON "organization_audit_events";
CREATE TRIGGER "organization_audit_events_append_only"
  BEFORE UPDATE OR DELETE ON "organization_audit_events"
  FOR EACH ROW EXECUTE FUNCTION "proovra_refuse_history_rewrite"();

DROP TRIGGER IF EXISTS "evidence_lifecycle_events_append_only" ON "evidence_lifecycle_events";
CREATE TRIGGER "evidence_lifecycle_events_append_only"
  BEFORE UPDATE OR DELETE ON "evidence_lifecycle_events"
  FOR EACH ROW EXECUTE FUNCTION "proovra_refuse_history_rewrite"();

ALTER TABLE "teams" DROP CONSTRAINT IF EXISTS "teams_owner_user_id_fkey";
ALTER TABLE "teams"
  ADD CONSTRAINT "teams_owner_user_id_fkey"
  FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
