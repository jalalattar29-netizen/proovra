-- UC-COM-004 — at most one ACTIVE entitlement per user, enforced by the database.
--
-- Entitlement bootstrap was check-then-create in several places, so two concurrent first
-- requests could create two active rows and the wallet/plan reader would pick one
-- arbitrarily. Every writer now goes through ensureEntitlement (create, then re-read the
-- winner on a unique violation); this partial unique index is the backstop.
--
-- FAIL CLOSED, NOTHING MERGED: if a user already has more than one active entitlement the
-- migration stops and names the count; credits on the duplicate rows must be reconciled
-- by an operator (they may be purchases), never summed or discarded automatically. Find:
--   SELECT user_id, count(*) FROM entitlements WHERE active GROUP BY 1 HAVING count(*) > 1;
--
-- EXPAND. Additive partial index (raw-schema object: Prisma cannot express WHERE).
DO $$
DECLARE dup_count integer;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT 1 FROM "entitlements" WHERE "active" = true GROUP BY "user_id" HAVING count(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'UC-COM-004: % user(s) have more than one active entitlement; reconcile them before applying this migration', dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "entitlements_user_id_active_key"
  ON "entitlements" ("user_id") WHERE "active" = true;
