-- =============================================================================
-- 2026-11-18 — PRO-T1-06 / DEC-18: workspace ownership moves by OFFER and
-- recipient ACCEPTANCE.
--
-- The owner of a (legacy) Owned Workspace made another member its owner of
-- record and billing owner by a unilateral act. An offer row now records the
-- owner's intent; nothing moves until the named recipient accepts (with their
-- own step-up). Statuses: PENDING / ACCEPTED / DECLINED / CANCELLED /
-- SUPERSEDED / EXPIRED. One PENDING offer per workspace is kept by the
-- service under the workspace row lock (a new offer supersedes the old).
--
-- EXPAND / SAFE_TO_APPLY_NOW. A new table only; no existing row is read or
-- rewritten and an older image never touches it. No foreign keys (the rows
-- are history of a lifecycle act, kept like activity rows). Rollback: leave
-- the table, or drop it once no image references it.
-- =============================================================================

CREATE TABLE "workspace_ownership_offers" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "team_id" UUID NOT NULL,
  "from_user_id" UUID NOT NULL,
  "to_user_id" UUID NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at_utc" TIMESTAMPTZ(6) NOT NULL,
  "decided_at_utc" TIMESTAMPTZ(6),

  CONSTRAINT "workspace_ownership_offers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "workspace_ownership_offers_team_id_status_idx"
  ON "workspace_ownership_offers" ("team_id", "status");

CREATE INDEX "workspace_ownership_offers_to_user_id_status_idx"
  ON "workspace_ownership_offers" ("to_user_id", "status");