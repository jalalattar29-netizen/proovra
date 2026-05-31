-- PHASE 2B CLOSURE — External Reviewer Portal enterprise closure.
--
-- Three additive changes:
--
--   1. Extend `external_reviewer_role_assignments` with the federation
--      + adaptive-auth fields that let a grant be redeemed via SSO
--      instead of (or in addition to) the raw portal token:
--
--        * auth_method          — TOKEN (default) | SSO
--                                 (bounded by PORTAL_AUTH_METHODS).
--        * sso_connection_id    — FK to the workspace SsoConnection
--                                 row (no DB-level FK; kept additive).
--        * allowed_domains      — bounded array of acceptable email
--                                 domains for SSO assertions.
--        * sso_subject_hash     — hashed SAML nameId of the first
--                                 successful bind. Lets us prove
--                                 the same identity returned next
--                                 time without storing the raw nameId.
--        * sso_name_id          — bounded display-only nameId.
--        * sso_bound_at_utc     — timestamp of first successful bind.
--        * mfa_satisfied_at_utc — moment an MFA challenge succeeded.
--
--   2. Add `external_review_invitation_deliveries` as the single
--      source of truth for "did the invitation email actually leave
--      the platform" — backed by Resend. NEVER stores the raw token;
--      records bounded provider status + outcomes only.
--
--   3. Indexes that match the operator-console read paths
--      (per-team + per-grant timelines, bulk batch lookup,
--      provider-message-id reconciliation).
--
-- Hard rules:
--   * Additive only. No existing column or table is altered destructively.
--   * `auth_method` defaults to TOKEN so existing rows behave identically.
--   * `allowed_domains` defaults to an empty array; an empty array means
--     "exact email match required" at the application layer.
--   * Phase-O safety gate compliance:
--       - Column adds use `ALTER TABLE IF EXISTS ... ADD COLUMN IF NOT
--         EXISTS` so re-running against an already-evolved schema is
--         a no-op (idempotent column evolution).
--       - The brand-new `external_review_invitation_deliveries` table
--         is created with a plain `CREATE TABLE` (no `IF NOT EXISTS`)
--         so any divergent pre-existing copy fails LOUDLY rather than
--         silently skipping column declarations. The `_prisma_migrations`
--         ledger guarantees this migration only ever runs once.
--       - Each `CREATE INDEX` on the new table is wrapped in a
--         `DO $$ ... END $$` block that asserts every referenced
--         column exists in `information_schema.columns` first. This
--         is the Phase O-Final defense against `mentioned_user_id
--         does not exist` (SQL 42703).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. external_reviewer_role_assignments — federation + adaptive auth fields
-- ---------------------------------------------------------------------------

ALTER TABLE IF EXISTS "external_reviewer_role_assignments"
  ADD COLUMN IF NOT EXISTS "auth_method"         VARCHAR(12)  NOT NULL DEFAULT 'TOKEN',
  ADD COLUMN IF NOT EXISTS "sso_connection_id"   UUID,
  ADD COLUMN IF NOT EXISTS "allowed_domains"     VARCHAR(180)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(180)[],
  ADD COLUMN IF NOT EXISTS "sso_subject_hash"    VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "sso_name_id"         VARCHAR(320),
  ADD COLUMN IF NOT EXISTS "sso_bound_at_utc"    TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "mfa_satisfied_at_utc" TIMESTAMPTZ(6);

-- Index adds for the existing role-assignment table are wrapped in
-- column-existence guards — protects against any environment where
-- this migration runs before the `ALTER TABLE` above is committed
-- (defensive against partial-state replays).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='external_reviewer_role_assignments'
       AND column_name='team_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='external_reviewer_role_assignments'
       AND column_name='auth_method'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "external_reviewer_role_assignments_team_auth_idx" ON "external_reviewer_role_assignments" ("team_id", "auth_method")';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='external_reviewer_role_assignments'
       AND column_name='sso_connection_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "external_reviewer_role_assignments_sso_conn_idx" ON "external_reviewer_role_assignments" ("sso_connection_id")';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. external_review_invitation_deliveries — Resend-backed delivery audit
--
-- Brand-new table. Plain CREATE TABLE so an existing divergent copy
-- (none expected) fails loudly rather than silently skipping column
-- declarations. The Prisma migration ledger ensures single-run.
-- ---------------------------------------------------------------------------

CREATE TABLE "external_review_invitation_deliveries" (
  "id"                   UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"              UUID         NOT NULL,
  "grant_id"             UUID         NOT NULL,
  "status"               VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
  "provider"             VARCHAR(40)  NOT NULL DEFAULT 'RESEND_API',
  "provider_message_id"  VARCHAR(200),
  "recipient_email"      VARCHAR(320) NOT NULL,
  "subject"              VARCHAR(200) NOT NULL,
  "queued_at_utc"        TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "sent_at_utc"          TIMESTAMPTZ(6),
  "delivered_at_utc"     TIMESTAMPTZ(6),
  "opened_at_utc"        TIMESTAMPTZ(6),
  "failed_at_utc"        TIMESTAMPTZ(6),
  "revoked_at_utc"       TIMESTAMPTZ(6),
  "expired_at_utc"       TIMESTAMPTZ(6),
  "failure_reason"       VARCHAR(120),
  "attempt"              SMALLINT     NOT NULL DEFAULT 1,
  "bulk_batch_id"        UUID,
  "last_error_preview"   VARCHAR(400),
  "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "external_review_invitation_deliveries_pkey" PRIMARY KEY ("id")
);

-- Indexes are wrapped in the Phase O-Final DO/information_schema
-- pattern so any partial-state replay against a divergent table is a
-- safe no-op instead of crashing on a missing column.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='external_review_invitation_deliveries'
       AND column_name='team_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='external_review_invitation_deliveries'
       AND column_name='grant_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='external_review_invitation_deliveries'
       AND column_name='queued_at_utc'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "external_review_invitation_deliveries_team_grant_queued_idx" ON "external_review_invitation_deliveries" ("team_id", "grant_id", "queued_at_utc" DESC)';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='external_review_invitation_deliveries'
       AND column_name='team_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='external_review_invitation_deliveries'
       AND column_name='status'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "external_review_invitation_deliveries_team_status_idx" ON "external_review_invitation_deliveries" ("team_id", "status")';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='external_review_invitation_deliveries'
       AND column_name='provider_message_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "external_review_invitation_deliveries_provider_msg_idx" ON "external_review_invitation_deliveries" ("provider_message_id")';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='external_review_invitation_deliveries'
       AND column_name='bulk_batch_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "external_review_invitation_deliveries_bulk_batch_idx" ON "external_review_invitation_deliveries" ("bulk_batch_id")';
  END IF;
END $$;

COMMIT;
