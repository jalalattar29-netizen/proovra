-- PHASE 12 CORRECTIVE PASS §2/§3 (INV-001 + NEW-004) — CONTRACT.
--
-- THIS FILE CONTAINS DESTRUCTIVE STATEMENTS. EVERY ONE OF THEM IS PRECEDED,
-- IN THIS SAME FILE, BY THE READINESS CHECK THAT AUTHORISES IT.
--
-- That ordering is the point. A guard that ships in a different artifact, or
-- after the statement it is supposed to authorise, is not a guard — it is a
-- comment. Each block below RAISES on unreadiness, which aborts the whole
-- migration in its transaction and leaves the database exactly as it was.
-- Refusing is always available; destroying is not reversible.
--
-- Readiness is checked HERE rather than delegated to an out-of-band operator
-- script so this migration is safe to apply against any database — a
-- disposable rehearsal, CI, or production — without a human first having run
-- something and remembered the result correctly.
--
-- WHAT IS DROPPED, AND ON WHAT EVIDENCE
-- ---------------------------------------------------------------------------
-- `external_reviewer_role_assignments` carries five columns that duplicate the
-- lifecycle `external_review_grants` owns: grant_state, raw_token, token_hash,
-- expires_at_utc, revoked_at_utc. They were added by a model catch-up
-- migration and no writer has ever populated them. One reader — the
-- organization external-access CSV export — trusted them, and therefore
-- reported every grant as PENDING with no expiry and no revocation.
--
-- The columns are dropped only if every row still holds the value it was
-- created with. If ANY row ever received real data, this migration refuses and
-- says which column, because at that point the assumption behind the whole
-- decision is wrong and a human has to look.

-- ===========================================================================
-- GUARD 1 — no orphans in either direction.
--
-- The FK created below would fail on an orphan anyway, but it would fail with
-- a constraint-violation message naming a row id and nothing about what the
-- operator should do. This says it plainly first.
-- ===========================================================================
DO $$
DECLARE
  orphan_sidecars   BIGINT := 0;
  orphan_deliveries BIGINT := 0;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'external_reviewer_role_assignments'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'external_review_grants'
  ) THEN
    EXECUTE $sql$
      SELECT COUNT(*) FROM "external_reviewer_role_assignments" a
       WHERE NOT EXISTS (
         SELECT 1 FROM "external_review_grants" g WHERE g."id" = a."id"
       )
    $sql$ INTO orphan_sidecars;

    EXECUTE $sql$
      SELECT COUNT(*) FROM "external_review_invitation_deliveries" d
       WHERE NOT EXISTS (
         SELECT 1 FROM "external_reviewer_role_assignments" a WHERE a."id" = d."grant_id"
       )
    $sql$ INTO orphan_deliveries;

    IF orphan_sidecars > 0 THEN
      RAISE EXCEPTION
        'INV-001 readiness failed: % external_reviewer_role_assignments row(s) have no matching external_review_grant. Resolve each explicitly before contracting.',
        orphan_sidecars;
    END IF;
    IF orphan_deliveries > 0 THEN
      RAISE EXCEPTION
        'INV-001 readiness failed: % external_review_invitation_deliveries row(s) reference a missing role assignment.',
        orphan_deliveries;
    END IF;
  END IF;
END $$;

-- ===========================================================================
-- GUARD 2 — the columns about to be dropped hold nothing.
-- ===========================================================================
DO $$
DECLARE
  populated BIGINT := 0;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'external_reviewer_role_assignments'
       AND column_name = 'grant_state'
  ) THEN
    EXECUTE $sql$
      SELECT COUNT(*) FROM "external_reviewer_role_assignments"
       WHERE "grant_state" IS DISTINCT FROM 'PENDING'
    $sql$ INTO populated;
    IF populated > 0 THEN
      RAISE EXCEPTION
        'INV-001 readiness failed: % row(s) carry a non-default external_reviewer_role_assignments.grant_state. The duplicate-authority assumption does not hold; do not drop.',
        populated;
    END IF;
  END IF;

  FOR populated IN
    SELECT 1 WHERE FALSE
  LOOP
    NULL;
  END LOOP;
END $$;

DO $$
DECLARE
  col       TEXT;
  populated BIGINT;
BEGIN
  FOREACH col IN ARRAY ARRAY['raw_token', 'token_hash', 'expires_at_utc', 'revoked_at_utc']
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'external_reviewer_role_assignments'
         AND column_name = col
    ) THEN
      EXECUTE format(
        'SELECT COUNT(*) FROM "external_reviewer_role_assignments" WHERE %I IS NOT NULL',
        col
      ) INTO populated;
      IF populated > 0 THEN
        RAISE EXCEPTION
          'INV-001 readiness failed: % row(s) carry a value in external_reviewer_role_assignments.%. The duplicate-authority assumption does not hold; do not drop.',
          populated, col;
      END IF;
    END IF;
  END LOOP;
END $$;

-- ===========================================================================
-- GUARD 3 — the delivery intent is unique and complete before it is enforced.
-- ===========================================================================
DO $$
DECLARE
  missing_key BIGINT := 0;
  dup_intent  BIGINT := 0;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'external_review_invitation_deliveries'
       AND column_name = 'intent_key'
  ) THEN
    EXECUTE 'SELECT COUNT(*) FROM "external_review_invitation_deliveries" WHERE "intent_key" IS NULL'
      INTO missing_key;
    IF missing_key > 0 THEN
      RAISE EXCEPTION
        'NEW-004 readiness failed: % delivery row(s) have no durable intent key. Run the backfill (20271121000000) first.',
        missing_key;
    END IF;

    EXECUTE $sql$
      SELECT COALESCE(SUM(n - 1), 0) FROM (
        SELECT COUNT(*) AS n
          FROM "external_review_invitation_deliveries"
         GROUP BY "team_id", "grant_id", "content_version", "resend_seq"
        HAVING COUNT(*) > 1
      ) AS dups
    $sql$ INTO dup_intent;
    IF dup_intent > 0 THEN
      RAISE EXCEPTION
        'NEW-004 readiness failed: % conflicting active logical intent(s). Classify them explicitly; this migration will not choose a winner for you.',
        dup_intent;
    END IF;
  END IF;
END $$;

-- ===========================================================================
-- CONTRACT 1 — the delivery intent invariants.
--
-- The old (team_id, grant_id, attempt) index is removed FIRST: it encoded the
-- wrong invariant and would forbid a legitimate second physical attempt of the
-- same intent.
-- ===========================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 'external_review_invitation_deliveries_grant_attempt_key'
  ) THEN
    EXECUTE 'DROP INDEX "external_review_invitation_deliveries_grant_attempt_key"';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'external_review_invitation_deliveries'
       AND column_name = 'content_version'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'external_review_invitation_deliveries'
       AND column_name = 'resend_seq'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "external_review_invitation_deliveries_intent_key" ON "external_review_invitation_deliveries" ("team_id", "grant_id", "content_version", "resend_seq")';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'external_review_invitation_deliveries'
       AND column_name = 'intent_key'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "external_review_invitation_deliveries_intent_key_uk" ON "external_review_invitation_deliveries" ("intent_key")';
  END IF;
END $$;

-- ===========================================================================
-- CONTRACT 2 — bind the sidecar to the aggregate it belongs to.
--
-- ON DELETE CASCADE, matching the direction the data already flows: a grant is
-- the thing that exists, and the role facet exists only because it does.
-- ===========================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'external_reviewer_role_assignments'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'external_reviewer_role_assignments_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE "external_reviewer_role_assignments" ADD CONSTRAINT "external_reviewer_role_assignments_id_fkey" FOREIGN KEY ("id") REFERENCES "external_review_grants"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END $$;

-- ===========================================================================
-- CONTRACT 3 — remove the duplicate lifecycle authority.
--
-- Authorised by GUARD 2 above, in this same file, immediately before.
-- ===========================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'external_reviewer_role_assignments_token_hash_key'
  ) THEN
    EXECUTE 'ALTER TABLE "external_reviewer_role_assignments" DROP CONSTRAINT "external_reviewer_role_assignments_token_hash_key"';
  END IF;
END $$;

DO $$
DECLARE
  col TEXT;
BEGIN
  FOREACH col IN ARRAY ARRAY['grant_state', 'raw_token', 'token_hash', 'expires_at_utc', 'revoked_at_utc']
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'external_reviewer_role_assignments'
         AND column_name = col
    ) THEN
      EXECUTE format(
        'ALTER TABLE "external_reviewer_role_assignments" DROP COLUMN %I',
        col
      );
    END IF;
  END LOOP;
END $$;
