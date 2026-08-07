-- PHASE 12 CORRECTIVE PASS §2/§3 (INV-001 + NEW-004) — BACKFILL.
--
-- WHAT THIS ASSIGNS, AND ON WHAT AUTHORITY
-- ---------------------------------------------------------------------------
-- Every pre-existing delivery row has to be classified into a logical intent,
-- and the classification has to be deterministic (a re-run must produce the
-- same answer) and honest (it must not invent a delivery outcome, and it must
-- not silently renumber a business-visible counter).
--
-- The only structural authority available for a historical row is its
-- ORDERING within its grant. So:
--
--   content_version = 1
--       Rotation did not exist as a durable fact before this change, so no
--       historical row can be attributed to a later generation of the link.
--       Claiming otherwise would be inventing provenance.
--   resend_seq      = dense rank of the row within (team_id, grant_id),
--                     ordered by queued_at_utc then id, starting at 0.
--       The FIRST message to a reviewer is the original send (0); every later
--       one is, by definition, a repeat that reached them — a resend. That is
--       the classification that preserves the rows AS SENT.
--   attempt         UNCHANGED.
--       This is the difference from the migration this replaces. `attempt` is
--       what an operator console has been showing; renumbering it would
--       rewrite what those consoles said. It stays exactly as it was, and its
--       new meaning (physical attempts within an intent) is a superset of the
--       old one for every row this backfill touches.
--
-- NOTHING IS DELETED. Duplicate history is CLASSIFIED, not removed: two rows
-- that were the same logical send under the old model become two distinct
-- intents here, which is the honest reading — two rows exist because two
-- messages were minted, and at least one of them may have reached a human.
-- Collapsing them by deletion would destroy the evidence that it happened.
--
-- NO DELIVERY OUTCOME IS INVENTED. `status`, `sent_at_utc`, `delivered_at_utc`
-- and `failed_at_utc` are not touched by this file at all.
--
-- Re-runnable: every UPDATE is conditioned on the value not already being what
-- it would set, so a second run changes zero rows.

-- ---------------------------------------------------------------------------
-- 1. resend_seq — the deterministic dense rank.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'external_review_invitation_deliveries'
       AND column_name = 'resend_seq'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'external_review_invitation_deliveries'
       AND column_name = 'queued_at_utc'
  ) THEN
    EXECUTE $sql$
      WITH ranked AS (
        SELECT
          "id",
          (ROW_NUMBER() OVER (
            PARTITION BY "team_id", "grant_id"
            ORDER BY "queued_at_utc" ASC, "id" ASC
          ) - 1) AS seq
        FROM "external_review_invitation_deliveries"
      )
      UPDATE "external_review_invitation_deliveries" d
         SET "resend_seq" = r.seq
        FROM ranked r
       WHERE d."id" = r."id"
         AND d."resend_seq" IS DISTINCT FROM r.seq
    $sql$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. content_version — 1 for every historical row, stated explicitly rather
--    than left to the column default, so a row added between the expand and
--    this step is also covered.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'external_review_invitation_deliveries'
       AND column_name = 'content_version'
  ) THEN
    EXECUTE 'UPDATE "external_review_invitation_deliveries" SET "content_version" = 1 WHERE "content_version" IS DISTINCT FROM 1';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. intent_key — derived from the durable triple, never from the row id.
--
--    Deriving it from the surrogate id is what the previous design did, and it
--    is why a retry could not be recognised as a retry: a new row meant a new
--    key. The key must be a function of WHAT THE MESSAGE IS, so that two
--    callers who independently decide to send the same message compute the
--    same key.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'external_review_invitation_deliveries'
       AND column_name = 'intent_key'
  ) THEN
    EXECUTE $sql$
      UPDATE "external_review_invitation_deliveries"
         SET "intent_key" =
               "grant_id"::text || ':' ||
               "content_version"::text || ':' ||
               "resend_seq"::text
       WHERE "intent_key" IS NULL
    $sql$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. token_version — every existing grant is generation 1. Rotation history
--    before this change was not recorded anywhere durable, so a higher number
--    cannot be derived and will not be guessed.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'external_review_grants'
       AND column_name = 'token_version'
  ) THEN
    EXECUTE 'UPDATE "external_review_grants" SET "token_version" = 1 WHERE "token_version" IS NULL OR "token_version" < 1';
  END IF;
END $$;
