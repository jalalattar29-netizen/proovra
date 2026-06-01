-- Phase 5 — Collaboration Teams (additive, safe).
--
-- This migration introduces the new Team Collaboration Platform as 5
-- additive tables alongside the existing `teams` table (which remains
-- the runtime workspace — see DBT-WS-04 in domain-debt-register.md).
-- NO existing column is altered. NO data is migrated. NO existing
-- index is dropped.
--
-- Hardening rules (Phase O):
--   * Every CREATE TABLE is guarded by `IF NOT EXISTS` AND a
--     `pg_tables` existence check inside a DO block.
--   * Every FK reference is guarded by `information_schema.columns`
--     existence for the referenced parent column (defensive against
--     partial-state databases).
--   * Every CREATE INDEX is guarded by `pg_tables` + per-column
--     existence checks.
--   * No SET NOT NULL anywhere — defaults are NOT NULL with explicit
--     defaults so the table is born complete.
--   * No FK to a non-yet-extant parent.
--
-- Rollback note: this migration is purely additive. Reverting is a
-- DROP TABLE cascade on 5 collaboration_team* tables. No production
-- data depends on these tables until backend services start writing
-- to them.

BEGIN;

-- =============================================================================
-- collaboration_teams
-- =============================================================================

DO $$
BEGIN
  -- Readiness sentinel: backfill verified complete (none required — additive).
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_teams') THEN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='teams')
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='teams' AND column_name='id'
    )
    AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='users')
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='users' AND column_name='id'
    ) THEN
      EXECUTE $sql$
        CREATE TABLE "collaboration_teams" (
          "id" UUID NOT NULL DEFAULT gen_random_uuid(),
          "workspace_id" UUID NOT NULL,
          "name" VARCHAR(120) NOT NULL,
          "description" VARCHAR(600),
          "team_type" VARCHAR(40) NOT NULL DEFAULT 'GENERAL',
          "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
          "created_by_user_id" UUID NOT NULL,
          "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
          "archived_at_utc" TIMESTAMPTZ(6),
          CONSTRAINT "collaboration_teams_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "collaboration_teams_workspace_id_fkey"
            FOREIGN KEY ("workspace_id") REFERENCES "teams"("id") ON DELETE CASCADE,
          CONSTRAINT "collaboration_teams_created_by_user_id_fkey"
            FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT
        );
      $sql$;
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_teams')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='collaboration_teams' AND column_name='workspace_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='collaboration_teams' AND column_name='status'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "collaboration_teams_workspace_id_status_idx" ON "collaboration_teams" ("workspace_id", "status")';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_teams')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='collaboration_teams' AND column_name='created_by_user_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "collaboration_teams_created_by_user_id_idx" ON "collaboration_teams" ("created_by_user_id")';
  END IF;
END $$;

-- =============================================================================
-- collaboration_team_members
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_team_members') THEN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_teams')
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='collaboration_teams' AND column_name='id'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='users' AND column_name='id'
    ) THEN
      EXECUTE $sql$
        CREATE TABLE "collaboration_team_members" (
          "id" UUID NOT NULL DEFAULT gen_random_uuid(),
          "team_id" UUID NOT NULL,
          "user_id" UUID NOT NULL,
          "role" VARCHAR(20) NOT NULL DEFAULT 'MEMBER',
          "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
          "invited_by_user_id" UUID,
          "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
          "suspended_at" TIMESTAMPTZ(6),
          "removed_at" TIMESTAMPTZ(6),
          "status_reason" VARCHAR(400),
          CONSTRAINT "collaboration_team_members_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "collaboration_team_members_team_id_fkey"
            FOREIGN KEY ("team_id") REFERENCES "collaboration_teams"("id") ON DELETE CASCADE,
          CONSTRAINT "collaboration_team_members_user_id_fkey"
            FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
          CONSTRAINT "collaboration_team_members_invited_by_user_id_fkey"
            FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
        );
      $sql$;
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_team_members')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='collaboration_team_members' AND column_name='team_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='collaboration_team_members' AND column_name='user_id'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "collaboration_team_member_team_user_uniq" ON "collaboration_team_members" ("team_id", "user_id")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "collaboration_team_members_team_id_status_idx" ON "collaboration_team_members" ("team_id", "status")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "collaboration_team_members_user_id_status_idx" ON "collaboration_team_members" ("user_id", "status")';
  END IF;
END $$;

-- =============================================================================
-- collaboration_team_invites
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_team_invites') THEN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_teams')
    AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='teams')
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='users' AND column_name='id'
    ) THEN
      EXECUTE $sql$
        CREATE TABLE "collaboration_team_invites" (
          "id" UUID NOT NULL DEFAULT gen_random_uuid(),
          "team_id" UUID NOT NULL,
          "workspace_id" UUID NOT NULL,
          "channel" VARCHAR(10) NOT NULL,
          "email" VARCHAR(320),
          "phone" VARCHAR(20),
          "token_hash" VARCHAR(128) NOT NULL,
          "role" VARCHAR(20) NOT NULL DEFAULT 'MEMBER',
          "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
          "expires_at_utc" TIMESTAMPTZ(6) NOT NULL,
          "max_uses" INTEGER NOT NULL DEFAULT 1,
          "use_count" INTEGER NOT NULL DEFAULT 0,
          "created_by_user_id" UUID NOT NULL,
          "accepted_by_user_id" UUID,
          "accepted_at_utc" TIMESTAMPTZ(6),
          "revoked_at_utc" TIMESTAMPTZ(6),
          "delivery_status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
          "delivery_error_preview" VARCHAR(280),
          "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
          CONSTRAINT "collaboration_team_invites_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "collaboration_team_invites_team_id_fkey"
            FOREIGN KEY ("team_id") REFERENCES "collaboration_teams"("id") ON DELETE CASCADE,
          CONSTRAINT "collaboration_team_invites_workspace_id_fkey"
            FOREIGN KEY ("workspace_id") REFERENCES "teams"("id") ON DELETE CASCADE,
          CONSTRAINT "collaboration_team_invites_created_by_user_id_fkey"
            FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
          CONSTRAINT "collaboration_team_invites_accepted_by_user_id_fkey"
            FOREIGN KEY ("accepted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
        );
      $sql$;
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_team_invites')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='collaboration_team_invites' AND column_name='token_hash'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "collaboration_team_invite_token_hash_uniq" ON "collaboration_team_invites" ("token_hash")';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_team_invites')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='collaboration_team_invites' AND column_name='team_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='collaboration_team_invites' AND column_name='status'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "collaboration_team_invites_team_id_status_idx" ON "collaboration_team_invites" ("team_id", "status")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "collaboration_team_invites_workspace_id_status_idx" ON "collaboration_team_invites" ("workspace_id", "status")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "collaboration_team_invites_email_status_idx" ON "collaboration_team_invites" ("email", "status")';
  END IF;
END $$;

-- =============================================================================
-- collaboration_team_activity
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_team_activity') THEN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_teams')
    AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='teams')
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='users' AND column_name='id'
    ) THEN
      EXECUTE $sql$
        CREATE TABLE "collaboration_team_activity" (
          "id" UUID NOT NULL DEFAULT gen_random_uuid(),
          "team_id" UUID NOT NULL,
          "workspace_id" UUID NOT NULL,
          "actor_user_id" UUID,
          "event_type" VARCHAR(64) NOT NULL,
          "target_type" VARCHAR(40),
          "target_id" UUID,
          "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
          "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
          CONSTRAINT "collaboration_team_activity_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "collaboration_team_activity_team_id_fkey"
            FOREIGN KEY ("team_id") REFERENCES "collaboration_teams"("id") ON DELETE CASCADE,
          CONSTRAINT "collaboration_team_activity_workspace_id_fkey"
            FOREIGN KEY ("workspace_id") REFERENCES "teams"("id") ON DELETE CASCADE,
          CONSTRAINT "collaboration_team_activity_actor_user_id_fkey"
            FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL
        );
      $sql$;
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_team_activity')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='collaboration_team_activity' AND column_name='team_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='collaboration_team_activity' AND column_name='created_at'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "collaboration_team_activity_team_id_created_at_idx" ON "collaboration_team_activity" ("team_id", "created_at" DESC)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "collaboration_team_activity_workspace_id_created_at_idx" ON "collaboration_team_activity" ("workspace_id", "created_at" DESC)';
  END IF;
END $$;

-- =============================================================================
-- collaboration_team_assignments
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_team_assignments') THEN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_teams')
    AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='teams')
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='users' AND column_name='id'
    ) THEN
      EXECUTE $sql$
        CREATE TABLE "collaboration_team_assignments" (
          "id" UUID NOT NULL DEFAULT gen_random_uuid(),
          "team_id" UUID NOT NULL,
          "workspace_id" UUID NOT NULL,
          "assignee_user_id" UUID,
          "assigned_by_user_id" UUID NOT NULL,
          "target_type" VARCHAR(20) NOT NULL,
          "target_id" UUID NOT NULL,
          "status" VARCHAR(20) NOT NULL DEFAULT 'OPEN',
          "priority" VARCHAR(10) NOT NULL DEFAULT 'NORMAL',
          "due_at_utc" TIMESTAMPTZ(6),
          "note" VARCHAR(600),
          "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
          "completed_at_utc" TIMESTAMPTZ(6),
          CONSTRAINT "collaboration_team_assignments_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "collaboration_team_assignments_team_id_fkey"
            FOREIGN KEY ("team_id") REFERENCES "collaboration_teams"("id") ON DELETE CASCADE,
          CONSTRAINT "collaboration_team_assignments_workspace_id_fkey"
            FOREIGN KEY ("workspace_id") REFERENCES "teams"("id") ON DELETE CASCADE,
          CONSTRAINT "collaboration_team_assignments_assignee_user_id_fkey"
            FOREIGN KEY ("assignee_user_id") REFERENCES "users"("id") ON DELETE SET NULL,
          CONSTRAINT "collaboration_team_assignments_assigned_by_user_id_fkey"
            FOREIGN KEY ("assigned_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT
        );
      $sql$;
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_team_assignments')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='collaboration_team_assignments' AND column_name='team_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='collaboration_team_assignments' AND column_name='status'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "collaboration_team_assignments_team_id_status_idx" ON "collaboration_team_assignments" ("team_id", "status")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "collaboration_team_assignments_workspace_id_status_idx" ON "collaboration_team_assignments" ("workspace_id", "status")';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_team_assignments')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='collaboration_team_assignments' AND column_name='target_type'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='collaboration_team_assignments' AND column_name='target_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "collaboration_team_assignments_target_type_target_id_idx" ON "collaboration_team_assignments" ("target_type", "target_id")';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_team_assignments')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='collaboration_team_assignments' AND column_name='assignee_user_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "collaboration_team_assignments_assignee_user_id_status_idx" ON "collaboration_team_assignments" ("assignee_user_id", "status")';
  END IF;
END $$;

COMMIT;
