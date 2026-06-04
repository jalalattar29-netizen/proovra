-- Wave 2 — Duplicate / Similarity / Lineage decisions.
--
-- Adds one new table (`duplicate_decisions`) that persists reviewer
-- decisions on graph duplicate-class edges (SAME_HASH_AS, SIMILAR_TO,
-- POSSIBLE_DERIVATIVE_OF) without modifying the edges themselves. The
-- decision row is the source of truth for the Duplicate / Similarity
-- Review surface's "confirmed / dismissed / marked derivative" state.
--
-- Hard rules satisfied:
--   * Phase O additive pattern: CREATE TABLE IF NOT EXISTS, no DROP,
--     no RENAME, no data movement. Re-running on an existing DB is a
--     clean no-op.
--   * Bounded CHECK constraints on edge_type + decision so the
--     vocabulary stays closed at the database layer.
--   * No FK on edge_id (application-level integrity — the graph edge
--     table is reconcile-managed and the reviewer's decision must
--     outlive an edge tombstoning event).
--   * No FK on decided_by_user_id (the audit chain in
--     admin_audit_logs is the durable accountability surface).
--   * Reason note bounded to 400 chars (matches the manual
--     relationships safeNote cap).
--   * (team_id, edge_id) unique → at most one reviewer decision per
--     duplicate edge per team. Idempotent upserts.

BEGIN;

SELECT 'Wave 2 duplicate decisions: additive CREATE TABLE IF NOT EXISTS + bounded CHECK constraints on edge_type + decision.' AS wave2_readiness;

CREATE TABLE IF NOT EXISTS "duplicate_decisions" (
  "id"                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id"             UUID            NOT NULL,
  "edge_id"             UUID            NOT NULL,
  "edge_type"           VARCHAR(48)     NOT NULL,
  "decision"            VARCHAR(32)     NOT NULL,
  "decided_by_user_id"  UUID            NOT NULL,
  "reason_note"         VARCHAR(400),
  "created_at_utc"      TIMESTAMPTZ(6)  NOT NULL DEFAULT NOW(),
  CONSTRAINT "duplicate_decisions_team_edge_unique"
    UNIQUE ("team_id", "edge_id")
);

-- ---------------------------------------------------------------------------
-- Bounded vocabulary CHECKs. Guarded so re-running on an already-
-- migrated DB is a no-op.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE constraint_schema='public'
       AND table_name='duplicate_decisions'
       AND constraint_name='duplicate_decisions_edge_type_bounded'
  ) THEN
    EXECUTE 'ALTER TABLE "duplicate_decisions"
              ADD CONSTRAINT "duplicate_decisions_edge_type_bounded"
              CHECK ("edge_type" IN (
                ''SAME_HASH_AS'',
                ''SIMILAR_TO'',
                ''POSSIBLE_DERIVATIVE_OF''
              ))';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE constraint_schema='public'
       AND table_name='duplicate_decisions'
       AND constraint_name='duplicate_decisions_decision_bounded'
  ) THEN
    EXECUTE 'ALTER TABLE "duplicate_decisions"
              ADD CONSTRAINT "duplicate_decisions_decision_bounded"
              CHECK ("decision" IN (
                ''CONFIRMED'',
                ''DISMISSED'',
                ''MARKED_DERIVATIVE''
              ))';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Read-side index: (team_id, decision) for the Duplicate / Similarity
-- Review surface's "show me all decisions of kind X for my team" query.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "duplicate_decisions_team_decision_idx"
  ON "duplicate_decisions" ("team_id", "decision");

COMMIT;
