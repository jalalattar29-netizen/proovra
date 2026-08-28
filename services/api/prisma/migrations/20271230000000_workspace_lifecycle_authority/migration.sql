-- WORKSPACE LIFECYCLE AUTHORITY (ADM-004, 2026-08-27)
--
-- THE DEFECT
-- ----------
-- `teams` carried NO lifecycle state whatsoever. `executeWorkspaceClosure`
-- revokes every membership, revokes API credentials, disables webhooks and
-- clears switcher pointers — and leaves the `teams` row byte-for-byte
-- indistinguishable from a live workspace. Every Platform Admin population
-- query (`prisma.team.findMany()` with no predicate, `team.count({ billingStatus
-- })`) therefore counted closed workspaces as live, and closure does not touch
-- `billing_plan` / `billing_status` either, so a closed workspace on a paid plan
-- kept reporting as an active paying customer.
--
-- WHY A COLUMN AND NOT A DERIVED PREDICATE
-- ----------------------------------------
-- The obvious alternative — derive liveness from "has no COMPLETED
-- workspace_closure_requests row" — is WRONG against this codebase, and
-- provably so: `reopenClosedWorkspace` (workspace-lifecycle.service.ts §7.4)
-- restores the owner's membership and writes a `workspace_reopened` activity
-- but DELIBERATELY leaves the COMPLETED request row in place as history. A
-- derived predicate would therefore mark every reopened workspace closed
-- forever. An explicit column is the only formulation that both closure and
-- reopen can own.
--
-- Billing state is NOT lifecycle state and is not used as one here. A workspace
-- can be live and unpaid, or closed and mid-cancellation; collapsing the two
-- would recreate the ambiguity in a new place.
--
-- SAFETY
-- ------
--   * EXPAND-ONLY. One nullable column added. Nothing dropped, narrowed or
--     deleted. NULL means "live", so every existing row keeps today's meaning
--     until the backfill below says otherwise.
--   * The backfill claims a workspace closed ONLY on recorded history: a
--     COMPLETED closure request with no `workspace_reopened` activity after it.
--     A workspace whose history is ambiguous stays live — the direction that
--     over-reports rather than hiding a real tenant from its operator.

ALTER TABLE "teams"
  ADD COLUMN IF NOT EXISTS "closed_at_utc" TIMESTAMPTZ(6);

COMMENT ON COLUMN "teams"."closed_at_utc" IS
  'THE workspace-liveness authority (ADM-004). NULL = live. Set by executeWorkspaceClosure, cleared by reopenClosedWorkspace. Never derived from billing state.';

-- Every control-plane population query filters on liveness. Declared as a plain
-- index (not a partial one) so it matches the `@@index([closedAtUtc])` the
-- Prisma schema declares — `prisma migrate diff` cannot express a partial index,
-- and a mismatch here is exactly what `scripts/drift-check.mjs` exists to catch.
CREATE INDEX IF NOT EXISTS "teams_closed_at_utc_idx"
  ON "teams" ("closed_at_utc");

-- ---------------------------------------------------------------------------
-- BACKFILL — recorded history only.
--
-- A workspace is closed when its newest COMPLETED closure request is NEWER than
-- its newest `workspace_reopened` activity (or no such activity exists). The
-- reopen marker is the same one `reopenClosedWorkspace` writes today, so this
-- reads the system's own record rather than guessing.
-- ---------------------------------------------------------------------------
WITH latest_closure AS (
  SELECT
    "team_id",
    MAX(COALESCE("completed_at_utc", "updated_at")) AS closed_at
  FROM "workspace_closure_requests"
  WHERE "status" = 'COMPLETED'
  GROUP BY "team_id"
),
latest_reopen AS (
  SELECT
    "team_id",
    MAX("created_at") AS reopened_at
  FROM "team_activities"
  WHERE "event_type" = 'workspace_reopened'
  GROUP BY "team_id"
)
UPDATE "teams" t
SET "closed_at_utc" = lc.closed_at
FROM latest_closure lc
LEFT JOIN latest_reopen lr ON lr."team_id" = lc."team_id"
WHERE t."id" = lc."team_id"
  AND t."closed_at_utc" IS NULL
  AND (lr.reopened_at IS NULL OR lr.reopened_at < lc.closed_at);
