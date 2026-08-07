-- PHASE 12 CORRECTIVE PASS §2/§3 (INV-001 + NEW-004) — EXPAND.
--
-- WHAT THIS REPLACES, AND WHY
-- ---------------------------------------------------------------------------
-- The previous occupant of this timestamp,
-- `20271120000000_external_review_delivery_intent_idempotency`, created a
-- UNIQUE index on (team_id, grant_id, attempt) and, to make that index
-- creatable, RE-NUMBERED every pre-existing `attempt` value with a window
-- function. It described itself as "EXPAND-ONLY. Adds a constraint; drops
-- nothing and rewrites no history." The re-numbering is a rewrite of a
-- business-visible counter, so that description was false.
--
-- It was also the wrong invariant. `attempt` was being asked to mean two
-- incompatible things at once — how many times we have TRIED to send, and
-- WHICH MESSAGE this is — and the two diverge precisely where it matters:
--
--   * a token ROTATION changes what the message contains. Under the old
--     keying, a rotated invitation kept attempt = 1, collapsed onto the
--     superseded message's intent, and presented the provider a key it had
--     already acknowledged. The provider would acknowledge again and send
--     nothing, leaving the reviewer holding a link that no longer works and
--     no successor to replace it.
--   * `deriveAttemptCounter` computed the next attempt as `count() + 1`, a
--     read-then-write. Two concurrent operator resends both read N, both
--     computed N+1, and the loser ADOPTED the winner's row — so the second
--     deliberate resend was silently never sent, and its caller was told the
--     send succeeded.
--
-- That migration was never committed and never applied outside a disposable
-- database (verified against HEAD, origin/main and every committed migration
-- inventory before it was replaced), so replacing its bytes rewrites no
-- deployed history. The previous 222 historical migrations are untouched.
--
-- THIS FILE IS GENUINELY EXPAND-ONLY. It adds nullable/defaulted columns and
-- nothing else: no constraint, no index on a column that is not yet
-- populated, no data change. Backfill is 20271121000000; the invariants and
-- the drops are 20271122000000, behind a readiness gate that refuses rather
-- than destroys.
--
-- Every statement is wrapped in the information_schema guard, so this is a
-- no-op against a database where the table is absent rather than a hard
-- failure mid-deploy.

-- ---------------------------------------------------------------------------
-- 1. external_review_grants.token_version — WHICH generation of the link.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'external_review_grants'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'external_review_grants'
       AND column_name = 'token_version'
  ) THEN
    EXECUTE 'ALTER TABLE "external_review_grants" ADD COLUMN "token_version" INTEGER NOT NULL DEFAULT 1';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. The delivery intent columns.
--
-- `content_version` and `resend_seq` carry defaults so every existing row is
-- immediately valid without a rewrite. `intent_key` is deliberately NULLABLE
-- here: it is derived per row by the backfill, and a NOT NULL default would
-- have to invent one value for every row, which is exactly the silent
-- collapsing this whole change exists to prevent.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'external_review_invitation_deliveries'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'external_review_invitation_deliveries'
         AND column_name = 'content_version'
    ) THEN
      EXECUTE 'ALTER TABLE "external_review_invitation_deliveries" ADD COLUMN "content_version" INTEGER NOT NULL DEFAULT 1';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'external_review_invitation_deliveries'
         AND column_name = 'resend_seq'
    ) THEN
      EXECUTE 'ALTER TABLE "external_review_invitation_deliveries" ADD COLUMN "resend_seq" INTEGER NOT NULL DEFAULT 0';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'external_review_invitation_deliveries'
         AND column_name = 'intent_key'
    ) THEN
      EXECUTE 'ALTER TABLE "external_review_invitation_deliveries" ADD COLUMN "intent_key" VARCHAR(200)';
    END IF;
  END IF;
END $$;
