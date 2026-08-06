-- =============================================================================
-- Track 1B — CaseEvidenceLink referential integrity + final legacy backfill.
--
-- PHASE 12 POINT 6 — SPLIT. This content used to sit in
-- `20271104000000_evidence_case_id_removal` together with the DROP of
-- `evidence.case_id`. That file mixed two release phases in one SQL file:
--
--   * a BACKFILL + FOREIGN KEY expansion, which is safe as soon as the
--     canonical link table exists and MUST run before the runtime cutover; and
--   * a CONTRACT_DROP of the legacy column, which must run only AFTER the
--     cutover has been deployed and observed.
--
-- Because a migration is applied as one unit, the combined file forced either
-- the foreign keys to be late or the column drop to be early. It had never
-- been applied in any environment, so it was split into correctly ordered
-- migrations. The DROP now lives in
-- `20271105000000_evidence_case_id_removal` (Release D).
--
-- REQUIRES: 20271103000000_case_evidence_link_canonical.
--
-- Forward-only, idempotent. Touches ONLY `case_evidence_links` (backfill rows
-- + FK constraints). It DROPS NOTHING. No other column or history is modified.
-- =============================================================================

-- (a) Final idempotent backfill: every evidence row still carrying a
--     legacy case_id pointer that has no corresponding canonical link row
--     gets one (SYSTEM-sourced, PRIMARY role — mirrors the 20271103
--     backfill semantics). Skips pointers at cases that no longer exist
--     (the column never had an FK, so dangling pointers are possible).
--     Executed dynamically inside a column-exists guard: as a plain top-level
--     statement it referenced evidence.case_id at PARSE time, so re-running
--     the file after the Release-D drop failed here with "column e.case_id
--     does not exist" instead of being the no-op it is meant to be.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'evidence' AND column_name = 'case_id'
  ) THEN
    RETURN;
  END IF;

  EXECUTE $sql$
    INSERT INTO "case_evidence_links"
      ("team_id", "case_id", "evidence_id", "role", "source", "reason",
       "linked_at_utc", "created_at", "updated_at")
    SELECT
      e."team_id",
      e."case_id",
      e."id",
      'PRIMARY'::"CaseEvidenceLinkRole",
      'SYSTEM'::"CaseEvidenceLinkSource",
      'backfill:evidence.caseId (final, 20271104000000)',
      now(),
      now(),
      now()
    FROM "evidence" e
    JOIN "cases" c ON c."id" = e."case_id"
    WHERE e."case_id" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM "case_evidence_links" l
        WHERE l."case_id" = e."case_id"
          AND l."evidence_id" = e."id"
      )
  $sql$;
END $$;

-- (b) Real FK constraints on the canonical link table, lock-safe:
--     NOT VALID first (no full-table scan under ACCESS EXCLUSIVE), then
--     VALIDATE CONSTRAINT (SHARE UPDATE EXCLUSIVE only).
--
--     This block previously issued
--       DELETE FROM case_evidence_links WHERE <orphaned>
--     so that VALIDATE could not fail. That made the migration green by
--     DESTROYING case↔evidence association records, which is exactly the
--     failure mode this phase forbids. An orphan link is a real integrity
--     finding for an operator to resolve; it is not the migration's to
--     silently delete. The migration REFUSES and names the rows.
DO $$
DECLARE
  orphan_case int;
  orphan_evidence int;
BEGIN
  SELECT count(*) INTO orphan_case
  FROM case_evidence_links l
  WHERE NOT EXISTS (SELECT 1 FROM cases c WHERE c.id = l.case_id);

  SELECT count(*) INTO orphan_evidence
  FROM case_evidence_links l
  WHERE NOT EXISTS (SELECT 1 FROM evidence e WHERE e.id = l.evidence_id);

  IF orphan_case > 0 OR orphan_evidence > 0 THEN
    RAISE EXCEPTION
      'REFUSING to add link foreign keys: % link row(s) point at a missing Case and % at missing Evidence. These are association records and must NOT be deleted by a migration. Resolve them with scripts/backfill-case-evidence-links.mjs --check, then re-run.',
      orphan_case, orphan_evidence;
  END IF;
END
$$;

--     ADD CONSTRAINT has no IF NOT EXISTS, so re-running the file aborted
--     with "constraint ... already exists". Guarded on pg_constraint instead;
--     VALIDATE stays outside the guard because it is already a no-op on an
--     already-validated constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'case_evidence_links'::regclass
      AND conname = 'case_evidence_links_evidence_id_fkey'
  ) THEN
    ALTER TABLE case_evidence_links
      ADD CONSTRAINT case_evidence_links_evidence_id_fkey
      FOREIGN KEY (evidence_id) REFERENCES evidence(id)
      ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
  END IF;
END $$;

ALTER TABLE case_evidence_links
  VALIDATE CONSTRAINT case_evidence_links_evidence_id_fkey;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'case_evidence_links'::regclass
      AND conname = 'case_evidence_links_case_id_fkey'
  ) THEN
    ALTER TABLE case_evidence_links
      ADD CONSTRAINT case_evidence_links_case_id_fkey
      FOREIGN KEY (case_id) REFERENCES cases(id)
      ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
  END IF;
END $$;

ALTER TABLE case_evidence_links
  VALIDATE CONSTRAINT case_evidence_links_case_id_fkey;
