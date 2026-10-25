-- A RESTRICTED CASE STAYS RESTRICTED (members audit re-audit, defect 6,
-- 2026-10-26).
--
-- "Restricted" meant only "has at least one access row" (a named member in
-- case_access, or a Collaboration Team in case_collaboration_team_access).
-- Ending a member's standing reach deletes their case_access rows, so the
-- DEPARTURE of the only named member silently emptied the list and opened the
-- case — with its evidence, reports and packages — to every member of the
-- workspace, viewers included.
--
-- Restriction becomes a property of the case: cases.restricted_at_utc. The
-- product sets it when access is first granted and clears it only when an
-- authorised manager removes the last entry through the case-access routes; a
-- departure removes the person and leaves the case restricted.
--
-- BACKFILL, forward-only: every case that carries an access list now is
-- flagged (restricted since now). A case whose list was ALREADY emptied by an
-- earlier departure cannot be told apart from one its manager deliberately
-- opened, so it is left as it is (unrestricted) — no reach is invented.
-- Nothing is deleted. Idempotent: the column is added once and the backfill
-- touches only unflagged cases.

ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "restricted_at_utc" TIMESTAMPTZ(6);

UPDATE "cases" c
   SET "restricted_at_utc" = NOW()
 WHERE c."restricted_at_utc" IS NULL
   AND (EXISTS (SELECT 1 FROM "case_access" a WHERE a."case_id" = c."id")
        OR EXISTS (SELECT 1 FROM "case_collaboration_team_access" t WHERE t."case_id" = c."id"));
