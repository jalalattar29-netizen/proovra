-- UC-CASE-004 — one link row per (case, evidence) pair, enforced by the database.
--
-- The link service already treats a pair as linked once (read-then-write); concurrent
-- attaches could still insert two rows (different roles) or answer 500. This index is the
-- backstop; the service maps the unique violation to the idempotent "already linked".
--
-- FAIL CLOSED, NOTHING DELETED: if duplicate pairs already exist the migration stops and
-- names them, so an operator decides which link (role, reason, provenance) is kept. It
-- never chooses on the operator's behalf. Find them with:
--   SELECT case_id, evidence_id, count(*) FROM case_evidence_links
--   GROUP BY 1, 2 HAVING count(*) > 1;
--
-- EXPAND. Additive index. The previous (case_id, evidence_id, role) unique stays; it is
-- now implied and can be retired by a later contract migration.
DO $$
DECLARE dup_count integer;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT 1 FROM "case_evidence_links" GROUP BY "case_id", "evidence_id" HAVING count(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'UC-CASE-004: % (case, evidence) pair(s) have more than one link row; resolve them before applying this migration', dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "case_evidence_links_case_id_evidence_id_key"
  ON "case_evidence_links" ("case_id", "evidence_id");
