-- Phase 7 — Collaboration Completion (additive, safe).
--
-- Adds 7 new tables alongside the Phase 5 collaboration_team* tables.
-- All additive. No ALTER, no UPDATE, no SET NOT NULL, no backfill.
--
-- Hardening rules (Phase O):
--   * Every CREATE TABLE inside a DO block with pg_tables existence check.
--   * Every FK is guarded by parent column existence.
--   * Every CREATE INDEX is guarded by pg_tables + per-column check.
--   * No raw token columns; mention parsing happens server-side only.
-- Rollback note: DROP TABLE CASCADE on the 7 tables. No production
-- data depends on them until services start writing.

BEGIN;

-- =============================================================================
-- collaboration_team_comments
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_team_comments') THEN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_teams')
    AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='teams')
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='users' AND column_name='id'
    ) THEN
      EXECUTE $sql$
        CREATE TABLE "collaboration_team_comments" (
          "id" UUID NOT NULL DEFAULT gen_random_uuid(),
          "team_id" UUID NOT NULL,
          "workspace_id" UUID NOT NULL,
          "author_user_id" UUID NOT NULL,
          "target_type" VARCHAR(20) NOT NULL,
          "target_id" UUID,
          "body" VARCHAR(4000) NOT NULL,
          "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
          "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
          "deleted_at_utc" TIMESTAMPTZ(6),
          "deleted_by_user_id" UUID,
          CONSTRAINT "collaboration_team_comments_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "collaboration_team_comments_team_id_fkey"
            FOREIGN KEY ("team_id") REFERENCES "collaboration_teams"("id") ON DELETE CASCADE,
          CONSTRAINT "collaboration_team_comments_workspace_id_fkey"
            FOREIGN KEY ("workspace_id") REFERENCES "teams"("id") ON DELETE CASCADE,
          CONSTRAINT "collaboration_team_comments_author_user_id_fkey"
            FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
          CONSTRAINT "collaboration_team_comments_deleted_by_user_id_fkey"
            FOREIGN KEY ("deleted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
        );
      $sql$;
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_team_comments')
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='collaboration_team_comments' AND column_name='team_id')
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='collaboration_team_comments' AND column_name='created_at') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "collaboration_team_comments_team_id_created_at_idx" ON "collaboration_team_comments" ("team_id", "created_at" DESC)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_team_comments')
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='collaboration_team_comments' AND column_name='target_type')
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='collaboration_team_comments' AND column_name='target_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "collaboration_team_comments_team_target_idx" ON "collaboration_team_comments" ("team_id", "target_type", "target_id")';
  END IF;
END $$;

-- =============================================================================
-- collaboration_team_comment_mentions
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_team_comment_mentions') THEN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_team_comments')
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='users' AND column_name='id'
    ) THEN
      EXECUTE $sql$
        CREATE TABLE "collaboration_team_comment_mentions" (
          "id" UUID NOT NULL DEFAULT gen_random_uuid(),
          "comment_id" UUID NOT NULL,
          "team_id" UUID NOT NULL,
          "mention_type" VARCHAR(10) NOT NULL,
          "mentioned_user_id" UUID,
          "raw_handle" VARCHAR(80),
          "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
          CONSTRAINT "collaboration_team_comment_mentions_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "collaboration_team_comment_mentions_comment_id_fkey"
            FOREIGN KEY ("comment_id") REFERENCES "collaboration_team_comments"("id") ON DELETE CASCADE,
          CONSTRAINT "collaboration_team_comment_mentions_user_id_fkey"
            FOREIGN KEY ("mentioned_user_id") REFERENCES "users"("id") ON DELETE SET NULL
        );
      $sql$;
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_team_comment_mentions')
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='collaboration_team_comment_mentions' AND column_name='team_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "collaboration_team_comment_mentions_team_type_idx" ON "collaboration_team_comment_mentions" ("team_id", "mention_type")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "collaboration_team_comment_mentions_comment_idx" ON "collaboration_team_comment_mentions" ("comment_id")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "collaboration_team_comment_mentions_user_idx" ON "collaboration_team_comment_mentions" ("mentioned_user_id")';
  END IF;
END $$;

-- =============================================================================
-- collaboration_team_notifications (in-app inbox; distinct from email/SMS)
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_team_notifications') THEN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='teams')
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='users' AND column_name='id'
    ) THEN
      EXECUTE $sql$
        CREATE TABLE "collaboration_team_notifications" (
          "id" UUID NOT NULL DEFAULT gen_random_uuid(),
          "user_id" UUID NOT NULL,
          "workspace_id" UUID NOT NULL,
          "team_id" UUID,
          "type" VARCHAR(40) NOT NULL,
          "title" VARCHAR(200) NOT NULL,
          "body" VARCHAR(1000),
          "target_type" VARCHAR(40),
          "target_id" UUID,
          "read_at" TIMESTAMPTZ(6),
          "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
          CONSTRAINT "collaboration_team_notifications_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "collaboration_team_notifications_user_id_fkey"
            FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
          CONSTRAINT "collaboration_team_notifications_workspace_id_fkey"
            FOREIGN KEY ("workspace_id") REFERENCES "teams"("id") ON DELETE CASCADE,
          CONSTRAINT "collaboration_team_notifications_team_id_fkey"
            FOREIGN KEY ("team_id") REFERENCES "collaboration_teams"("id") ON DELETE CASCADE
        );
      $sql$;
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_team_notifications')
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='collaboration_team_notifications' AND column_name='user_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "collaboration_team_notifications_user_read_idx" ON "collaboration_team_notifications" ("user_id", "read_at", "created_at" DESC)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "collaboration_team_notifications_team_idx" ON "collaboration_team_notifications" ("team_id", "created_at" DESC)';
  END IF;
END $$;

-- =============================================================================
-- collaboration_team_notification_preferences
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_team_notification_preferences') THEN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_teams')
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='users' AND column_name='id'
    ) THEN
      EXECUTE $sql$
        CREATE TABLE "collaboration_team_notification_preferences" (
          "id" UUID NOT NULL DEFAULT gen_random_uuid(),
          "team_id" UUID NOT NULL,
          "user_id" UUID NOT NULL,
          "mentions" BOOLEAN NOT NULL DEFAULT true,
          "assignments" BOOLEAN NOT NULL DEFAULT true,
          "invite_accepted" BOOLEAN NOT NULL DEFAULT true,
          "digest" VARCHAR(10) NOT NULL DEFAULT 'INSTANT',
          "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
          CONSTRAINT "collaboration_team_notification_preferences_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "collaboration_team_notification_preferences_team_id_fkey"
            FOREIGN KEY ("team_id") REFERENCES "collaboration_teams"("id") ON DELETE CASCADE,
          CONSTRAINT "collaboration_team_notification_preferences_user_id_fkey"
            FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
        );
      $sql$;
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_team_notification_preferences')
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='collaboration_team_notification_preferences' AND column_name='team_id')
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='collaboration_team_notification_preferences' AND column_name='user_id') THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "collaboration_team_notification_preference_team_user_uniq" ON "collaboration_team_notification_preferences" ("team_id", "user_id")';
  END IF;
END $$;

-- =============================================================================
-- collaboration_team_guests
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_team_guests') THEN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_teams')
    AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='teams')
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='users' AND column_name='id'
    ) THEN
      EXECUTE $sql$
        CREATE TABLE "collaboration_team_guests" (
          "id" UUID NOT NULL DEFAULT gen_random_uuid(),
          "team_id" UUID NOT NULL,
          "workspace_id" UUID NOT NULL,
          "email" VARCHAR(320) NOT NULL,
          "expires_at_utc" TIMESTAMPTZ(6) NOT NULL,
          "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
          "invited_by_user_id" UUID NOT NULL,
          "accepted_user_id" UUID,
          "accepted_at_utc" TIMESTAMPTZ(6),
          "revoked_at_utc" TIMESTAMPTZ(6),
          "revoked_by_user_id" UUID,
          "scope_note" VARCHAR(400),
          "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
          CONSTRAINT "collaboration_team_guests_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "collaboration_team_guests_team_id_fkey"
            FOREIGN KEY ("team_id") REFERENCES "collaboration_teams"("id") ON DELETE CASCADE,
          CONSTRAINT "collaboration_team_guests_workspace_id_fkey"
            FOREIGN KEY ("workspace_id") REFERENCES "teams"("id") ON DELETE CASCADE,
          CONSTRAINT "collaboration_team_guests_invited_by_fkey"
            FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
          CONSTRAINT "collaboration_team_guests_accepted_user_fkey"
            FOREIGN KEY ("accepted_user_id") REFERENCES "users"("id") ON DELETE SET NULL,
          CONSTRAINT "collaboration_team_guests_revoked_by_fkey"
            FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
        );
      $sql$;
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_team_guests')
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='collaboration_team_guests' AND column_name='team_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "collaboration_team_guests_team_status_idx" ON "collaboration_team_guests" ("team_id", "status")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "collaboration_team_guests_workspace_status_idx" ON "collaboration_team_guests" ("workspace_id", "status")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "collaboration_team_guests_email_status_idx" ON "collaboration_team_guests" ("email", "status")';
  END IF;
END $$;

-- =============================================================================
-- collaboration_team_access_reviews
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_team_access_reviews') THEN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_teams')
    AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='teams')
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='users' AND column_name='id'
    ) THEN
      EXECUTE $sql$
        CREATE TABLE "collaboration_team_access_reviews" (
          "id" UUID NOT NULL DEFAULT gen_random_uuid(),
          "team_id" UUID NOT NULL,
          "workspace_id" UUID NOT NULL,
          "created_by_user_id" UUID NOT NULL,
          "status" VARCHAR(20) NOT NULL DEFAULT 'OPEN',
          "due_at_utc" TIMESTAMPTZ(6),
          "completed_at_utc" TIMESTAMPTZ(6),
          "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
          CONSTRAINT "collaboration_team_access_reviews_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "collaboration_team_access_reviews_team_id_fkey"
            FOREIGN KEY ("team_id") REFERENCES "collaboration_teams"("id") ON DELETE CASCADE,
          CONSTRAINT "collaboration_team_access_reviews_workspace_id_fkey"
            FOREIGN KEY ("workspace_id") REFERENCES "teams"("id") ON DELETE CASCADE,
          CONSTRAINT "collaboration_team_access_reviews_created_by_fkey"
            FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT
        );
      $sql$;
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_team_access_reviews')
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='collaboration_team_access_reviews' AND column_name='team_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "collaboration_team_access_reviews_team_status_idx" ON "collaboration_team_access_reviews" ("team_id", "status")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "collaboration_team_access_reviews_workspace_status_idx" ON "collaboration_team_access_reviews" ("workspace_id", "status")';
  END IF;
END $$;

-- =============================================================================
-- collaboration_team_access_review_items
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_team_access_review_items') THEN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_team_access_reviews')
    AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_team_members')
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='users' AND column_name='id'
    ) THEN
      EXECUTE $sql$
        CREATE TABLE "collaboration_team_access_review_items" (
          "id" UUID NOT NULL DEFAULT gen_random_uuid(),
          "review_id" UUID NOT NULL,
          "member_id" UUID NOT NULL,
          "decision" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
          "decided_by_user_id" UUID,
          "decided_at" TIMESTAMPTZ(6),
          "notes" VARCHAR(600),
          CONSTRAINT "collaboration_team_access_review_items_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "collaboration_team_access_review_items_review_id_fkey"
            FOREIGN KEY ("review_id") REFERENCES "collaboration_team_access_reviews"("id") ON DELETE CASCADE,
          CONSTRAINT "collaboration_team_access_review_items_member_id_fkey"
            FOREIGN KEY ("member_id") REFERENCES "collaboration_team_members"("id") ON DELETE CASCADE,
          CONSTRAINT "collaboration_team_access_review_items_decided_by_fkey"
            FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
        );
      $sql$;
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_team_access_review_items')
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='collaboration_team_access_review_items' AND column_name='review_id')
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='collaboration_team_access_review_items' AND column_name='member_id') THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "collaboration_team_access_review_item_review_member_uniq" ON "collaboration_team_access_review_items" ("review_id", "member_id")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "collaboration_team_access_review_items_member_idx" ON "collaboration_team_access_review_items" ("member_id")';
  END IF;
END $$;

COMMIT;
