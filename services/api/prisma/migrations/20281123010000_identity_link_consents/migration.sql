-- =============================================================================
-- 2026-11-21 — PRO-A2-02 / owner decision A: an Organization IdP link on a
-- SELF-SERVE account is honoured only on the owner's CURRENT consent.
--
-- One row per owner approval, bound to the exact Organization, IdP connection,
-- provider and subject (a SHA-256 digest of the subject: a subject can be an
-- address). The owner-approval flow (organization-link-consent.service.ts,
-- behind the owner's own signed-in session and account step-up) is the ONLY
-- writer of a new row. No administrator route, repair command or backfill
-- writes one: links approved before this release are not consent here, and
-- their owners approve once more.
--
-- A consent ENDS (ended_at_utc + end_reason, the row is kept as history):
--   WITHDRAWN             the owner withdrew it (stepped-up account route)
--   SUPERSEDED            the owner approved the same link again
--   MEMBERSHIP_SUSPENDED  any of the person's memberships in the Organization
--                         went from ACTIVE to SUSPENDED
--   MEMBERSHIP_ENDED      ... went from ACTIVE to REVOKED, or was deleted
--                         (left, removed)
--   MEMBERSHIP_EXPIRED    a lapsed access window was reopened
-- The membership endings are written by the triggers below, so every writer
-- (route, SCIM, orchestrator, raw SQL) ends consent the same way; a
-- reactivation or a rejoin never revives an ended row. A window that lapses
-- without any write is refused at read time (enterprise-account-linking).
--
-- organization_name is the Organization's name when the owner approved,
-- shown back to the owner on their own consent list.
--
-- History is append-only: an ended row cannot be changed, no row can be
-- deleted, and the binding columns never change.
--
-- EXPAND / SAFE_TO_APPLY_NOW. A new table, two functions and three triggers;
-- no existing row is read or rewritten. An older API image never reads the
-- table (it keeps its own rule); the triggers only write this new table.
-- Rollback: drop the triggers, then leave or drop the table.
-- =============================================================================

CREATE TABLE "identity_link_consents" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "provider" VARCHAR(32) NOT NULL,
  "subject_digest" VARCHAR(64) NOT NULL,
  "connection_id" UUID NOT NULL,
  "external_identity_mapping_id" UUID,
  "organization_name" VARCHAR(200),
  "approved_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at_utc" TIMESTAMPTZ(6),
  "end_reason" VARCHAR(32),
  "ended_by_user_id" UUID,

  CONSTRAINT "identity_link_consents_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "identity_link_consents_org_user_idx"
  ON "identity_link_consents" ("organization_id", "user_id", "ended_at_utc");

CREATE INDEX "identity_link_consents_user_idx"
  ON "identity_link_consents" ("user_id", "ended_at_utc");

-- History guard: never deleted; an ended consent never changes again; the
-- binding (Organization, person, provider, subject, connection, approval time)
-- never changes.
CREATE OR REPLACE FUNCTION "identity_link_consents_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'identity_link_consents is append-only history (PRO-A2-02)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."ended_at_utc" IS NOT NULL
     OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
     OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
     OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."subject_digest" IS DISTINCT FROM OLD."subject_digest"
     OR NEW."connection_id" IS DISTINCT FROM OLD."connection_id"
     OR NEW."approved_at_utc" IS DISTINCT FROM OLD."approved_at_utc" THEN
    RAISE EXCEPTION 'an identity link consent is ended once and never rewritten (PRO-A2-02)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "identity_link_consents_guard" ON "identity_link_consents";
CREATE TRIGGER "identity_link_consents_guard"
  BEFORE UPDATE OR DELETE ON "identity_link_consents"
  FOR EACH ROW EXECUTE FUNCTION "identity_link_consents_guard"();

-- Membership endings end the person's live consents in that Organization.
CREATE OR REPLACE FUNCTION "identity_link_consents_end_on_membership"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_org UUID;
  v_reason TEXT := NULL;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_reason := 'MEMBERSHIP_ENDED';
  ELSIF OLD."status"::text = 'ACTIVE' AND NEW."status"::text = 'SUSPENDED' THEN
    v_reason := 'MEMBERSHIP_SUSPENDED';
  ELSIF OLD."status"::text = 'ACTIVE' AND NEW."status"::text <> 'ACTIVE' THEN
    v_reason := 'MEMBERSHIP_ENDED';
  ELSIF TG_TABLE_NAME = 'team_members' THEN
    -- (nested: a record field is resolved only for the table that has it)
    IF OLD."access_expires_at_utc" IS NOT NULL
       AND OLD."access_expires_at_utc" <= now()
       AND NEW."access_expires_at_utc" IS DISTINCT FROM OLD."access_expires_at_utc" THEN
      v_reason := 'MEMBERSHIP_EXPIRED';
    END IF;
  ELSE
    IF OLD."valid_until_utc" IS NOT NULL
       AND OLD."valid_until_utc" <= now()
       AND NEW."valid_until_utc" IS DISTINCT FROM OLD."valid_until_utc" THEN
      v_reason := 'MEMBERSHIP_EXPIRED';
    END IF;
  END IF;
  IF v_reason IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'team_members' THEN
    SELECT "organization_id" INTO v_org FROM "teams" WHERE "id" = OLD."team_id";
  ELSE
    SELECT OLD."organization_id" INTO v_org;
  END IF;
  IF v_org IS NULL THEN
    RETURN NULL;
  END IF;
  UPDATE "identity_link_consents"
     SET "ended_at_utc" = now(), "end_reason" = v_reason
   WHERE "organization_id" = v_org
     AND "user_id" = OLD."user_id"
     AND "ended_at_utc" IS NULL;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS "identity_link_consents_end_on_team_member" ON "team_members";
CREATE TRIGGER "identity_link_consents_end_on_team_member"
  AFTER UPDATE OF "status", "access_expires_at_utc" OR DELETE ON "team_members"
  FOR EACH ROW EXECUTE FUNCTION "identity_link_consents_end_on_membership"();

DROP TRIGGER IF EXISTS "identity_link_consents_end_on_org_membership" ON "organization_memberships";
CREATE TRIGGER "identity_link_consents_end_on_org_membership"
  AFTER UPDATE OF "status", "valid_until_utc" OR DELETE ON "organization_memberships"
  FOR EACH ROW EXECUTE FUNCTION "identity_link_consents_end_on_membership"();
