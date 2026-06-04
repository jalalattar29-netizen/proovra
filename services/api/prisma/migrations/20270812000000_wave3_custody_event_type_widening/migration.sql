-- Wave 3 — CustodyEventType enum widening (Phase 7A).
--
-- Adds 8 new values to the Postgres enum `CustodyEventType` so the
-- Investigation-mutation surfaces (manual relationships, duplicate
-- decisions, operator-driven reconcile / refresh, and the three
-- export surfaces) can append truthful custody chain entries in
-- Phase 7B. The new values cover only mutations that change the
-- evidence meaning or its graph projection; pure read surfaces are
-- intentionally not custody-emitting.
--
-- New values (past-tense verb, matching every existing CustodyEventType
-- label):
--
--   DUPLICATE_DECISION_RECORDED          — POST /v1/graph/duplicates/
--                                          :edgeId/decision succeeded.
--   MANUAL_RELATIONSHIP_CREATED          — POST /v1/graph/relationships/
--                                          manual succeeded.
--   MANUAL_RELATIONSHIP_RETRACTED        — DELETE /v1/graph/relationships/
--                                          manual/:id succeeded.
--   GRAPH_RECONCILE_REQUESTED            — POST /v1/graph/reconcile invoked.
--   MEDIA_INTELLIGENCE_REFRESH_REQUESTED — POST /v1/investigation/media-
--                                          intelligence/refresh invoked.
--   INVESTIGATION_GRAPH_EXPORTED         — POST /v1/graph/export succeeded.
--   INVESTIGATION_TIMELINE_EXPORTED      — POST /v1/graph/timeline/export
--                                          succeeded.
--   INVESTIGATION_DUPLICATES_EXPORTED    — POST /v1/graph/duplicates/export
--                                          succeeded.
--
-- Hard rules satisfied:
--   * Phase O additive pattern: every ALTER TYPE wrapped in a DO $$ block
--     guarded by pg_enum + pg_type lookup, so a partial-state DB is a
--     clean no-op. ALTER TYPE ... ADD VALUE itself uses IF NOT EXISTS as
--     a second layer of idempotency.
--   * ENUM widening is ADDITIVE ONLY — zero ALTER TYPE ... DROP VALUE,
--     zero RENAME VALUE, zero data movement. Existing values remain
--     valid.
--   * Idempotent — re-running on a DB that already has the new values
--     is a clean no-op (the guard + ADD VALUE IF NOT EXISTS combination
--     guarantees this).
--
-- Note: Postgres requires `ALTER TYPE ... ADD VALUE` to run OUTSIDE a
-- transaction block. Wrapping inside DO $$ blocks (which open their own
-- subtransactions) is the canonical workaround used by every prior
-- ENUM-widening migration in this repo. No BEGIN; / COMMIT; here.

SELECT 'Wave 3 custody event type widening: additive ALTER TYPE ADD VALUE for 8 new Investigation-mutation custody events.' AS wave3_readiness;

-- ---------------------------------------------------------------------------
-- 1. DUPLICATE_DECISION_RECORDED — duplicate-class edge decision recorded.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
     WHERE enumlabel = 'DUPLICATE_DECISION_RECORDED'
       AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'CustodyEventType')
  ) THEN
    ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'DUPLICATE_DECISION_RECORDED';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. MANUAL_RELATIONSHIP_CREATED — operator-authored graph edge created.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
     WHERE enumlabel = 'MANUAL_RELATIONSHIP_CREATED'
       AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'CustodyEventType')
  ) THEN
    ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'MANUAL_RELATIONSHIP_CREATED';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. MANUAL_RELATIONSHIP_RETRACTED — operator-authored graph edge retracted.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
     WHERE enumlabel = 'MANUAL_RELATIONSHIP_RETRACTED'
       AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'CustodyEventType')
  ) THEN
    ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'MANUAL_RELATIONSHIP_RETRACTED';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. GRAPH_RECONCILE_REQUESTED — operator-initiated graph reconciliation.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
     WHERE enumlabel = 'GRAPH_RECONCILE_REQUESTED'
       AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'CustodyEventType')
  ) THEN
    ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'GRAPH_RECONCILE_REQUESTED';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. MEDIA_INTELLIGENCE_REFRESH_REQUESTED — operator-initiated MI refresh.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
     WHERE enumlabel = 'MEDIA_INTELLIGENCE_REFRESH_REQUESTED'
       AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'CustodyEventType')
  ) THEN
    ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'MEDIA_INTELLIGENCE_REFRESH_REQUESTED';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6. INVESTIGATION_GRAPH_EXPORTED — graph projection export succeeded.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
     WHERE enumlabel = 'INVESTIGATION_GRAPH_EXPORTED'
       AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'CustodyEventType')
  ) THEN
    ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'INVESTIGATION_GRAPH_EXPORTED';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 7. INVESTIGATION_TIMELINE_EXPORTED — timeline projection export succeeded.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
     WHERE enumlabel = 'INVESTIGATION_TIMELINE_EXPORTED'
       AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'CustodyEventType')
  ) THEN
    ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'INVESTIGATION_TIMELINE_EXPORTED';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 8. INVESTIGATION_DUPLICATES_EXPORTED — duplicates projection export succeeded.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
     WHERE enumlabel = 'INVESTIGATION_DUPLICATES_EXPORTED'
       AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'CustodyEventType')
  ) THEN
    ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'INVESTIGATION_DUPLICATES_EXPORTED';
  END IF;
END $$;
