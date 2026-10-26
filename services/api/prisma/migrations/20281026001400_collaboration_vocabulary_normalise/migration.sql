-- LEGACY COLLABORATION TEAM VALUES ARE NORMALISED, THEN THE VOCABULARY IS
-- VALIDATED WHERE NOTHING VIOLATES IT (members re-audit N-8, 2026-10-26).
--
-- The Collaboration Team vocabulary CHECK constraints were added NOT VALID:
-- they bind every new write and were not checked against existing rows. But
-- PostgreSQL checks a NOT VALID CHECK on every later UPDATE of a row too, so a
-- legacy row whose role or status falls outside the vocabulary could no longer
-- be updated by any writer — archive, remove, expire, reassign all failed with
-- 23514.
--
-- STEP 1 — normalise, only where the canonical value is certain:
--   * the same vocabulary word in another case or with surrounding
--     whitespace ('active', ' Removed ') becomes that word ('ACTIVE',
--     'REMOVED');
--   * collaboration_team_assignments.status 'CANCELED' (and its case
--     variants) — the one-L spelling of the canonical 'CANCELLED' — becomes
--     'CANCELLED'.
-- Nothing else is guessed. A value with no canonical meaning is left exactly
-- as it is and counted by the readiness query; such a row needs an operator's
-- decision, and its constraint stays NOT VALID.
--
-- STEP 2 — VALIDATE each constraint whose column now holds no violator (a
-- scan under SHARE UPDATE EXCLUSIVE: reads and writes continue). A constraint
-- with a remaining violator is left NOT VALID and named in a NOTICE.
--
-- Readiness: the number of rows still outside the vocabulary, per column
-- (0 everywhere means every constraint is validated).
--
-- Idempotent: step 1 touches only violating rows; step 2 skips a constraint
-- already validated.

-- One UPDATE per table, every column at once: PostgreSQL checks the whole new
-- row, so a row is rewritten only when EVERY one of its vocabulary columns
-- then holds a canonical value. A row with any value that has no canonical
-- meaning is left untouched (an UPDATE of it could not succeed) and counted.

UPDATE "collaboration_teams" SET "status" = UPPER(BTRIM("status"))
 WHERE "status" NOT IN ('ACTIVE', 'ARCHIVED')
   AND UPPER(BTRIM("status")) IN ('ACTIVE', 'ARCHIVED');

UPDATE "collaboration_team_members"
   SET "status" = UPPER(BTRIM("status")),
       "role" = UPPER(BTRIM("role"))
 WHERE ("status" NOT IN ('ACTIVE', 'SUSPENDED', 'REMOVED')
        OR "role" NOT IN ('LEAD', 'ADMIN', 'MEMBER', 'VIEWER', 'EXTERNAL'))
   AND UPPER(BTRIM("status")) IN ('ACTIVE', 'SUSPENDED', 'REMOVED')
   AND UPPER(BTRIM("role")) IN ('LEAD', 'ADMIN', 'MEMBER', 'VIEWER', 'EXTERNAL');

UPDATE "collaboration_team_invites"
   SET "status" = UPPER(BTRIM("status")),
       "role" = UPPER(BTRIM("role")),
       "delivery_status" = UPPER(BTRIM("delivery_status"))
 WHERE ("status" NOT IN ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED')
        OR "role" NOT IN ('LEAD', 'ADMIN', 'MEMBER', 'VIEWER', 'EXTERNAL')
        OR "delivery_status" NOT IN ('PENDING', 'SENT', 'DELIVERED', 'FAILED', 'BOUNCED'))
   AND UPPER(BTRIM("status")) IN ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED')
   AND UPPER(BTRIM("role")) IN ('LEAD', 'ADMIN', 'MEMBER', 'VIEWER', 'EXTERNAL')
   AND UPPER(BTRIM("delivery_status")) IN ('PENDING', 'SENT', 'DELIVERED', 'FAILED', 'BOUNCED');

UPDATE "collaboration_team_assignments"
   SET "status" = CASE WHEN UPPER(BTRIM("status")) = 'CANCELED' THEN 'CANCELLED' ELSE UPPER(BTRIM("status")) END
 WHERE "status" NOT IN ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'REASSIGNED', 'CANCELLED')
   AND UPPER(BTRIM("status")) IN ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'REASSIGNED', 'CANCELLED', 'CANCELED');

DO $$
DECLARE
  c RECORD;
  violators BIGINT;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('collaboration_teams', 'collaboration_teams_status_vocab', 'status', ARRAY['ACTIVE', 'ARCHIVED']),
      ('collaboration_team_members', 'collaboration_team_members_status_vocab', 'status', ARRAY['ACTIVE', 'SUSPENDED', 'REMOVED']),
      ('collaboration_team_members', 'collaboration_team_members_role_vocab', 'role', ARRAY['LEAD', 'ADMIN', 'MEMBER', 'VIEWER', 'EXTERNAL']),
      ('collaboration_team_invites', 'collaboration_team_invites_status_vocab', 'status', ARRAY['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED']),
      ('collaboration_team_invites', 'collaboration_team_invites_role_vocab', 'role', ARRAY['LEAD', 'ADMIN', 'MEMBER', 'VIEWER', 'EXTERNAL']),
      ('collaboration_team_invites', 'collaboration_team_invites_delivery_vocab', 'delivery_status', ARRAY['PENDING', 'SENT', 'DELIVERED', 'FAILED', 'BOUNCED']),
      ('collaboration_team_assignments', 'collaboration_team_assignments_status_vocab', 'status', ARRAY['OPEN', 'IN_PROGRESS', 'COMPLETED', 'REASSIGNED', 'CANCELLED'])
    ) AS v("tbl", "con", "col", "vocab")
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c."con" AND NOT convalidated) THEN
      CONTINUE;
    END IF;
    EXECUTE format('SELECT count(*) FROM %I WHERE NOT (%I = ANY ($1))', c."tbl", c."col")
       INTO violators USING c."vocab";
    IF violators = 0 THEN
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', c."tbl", c."con");
    ELSE
      RAISE NOTICE '% stays NOT VALID: % row(s) of %.% hold a value with no canonical meaning',
        c."con", violators, c."tbl", c."col";
    END IF;
  END LOOP;
END $$;
