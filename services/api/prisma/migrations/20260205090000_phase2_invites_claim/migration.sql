DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'TeamRole' AND e.enumlabel = 'VIEWER'
  ) THEN
    ALTER TYPE "TeamRole" ADD VALUE 'VIEWER';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'CustodyEventType' AND e.enumlabel = 'EVIDENCE_CLAIMED'
  ) THEN
    ALTER TYPE "CustodyEventType" ADD VALUE 'EVIDENCE_CLAIMED';
  END IF;
END $$;

ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS "team_id" UUID;
ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS "guest_identity_id" UUID;

CREATE TABLE IF NOT EXISTS "guest_identities" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "claimed_by_user_id" UUID,
  "claimed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "guest_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "guest_identities_claimed_by_user_id_fkey" FOREIGN KEY ("claimed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "guest_identities_user_id_key" ON "guest_identities"("user_id");
CREATE INDEX IF NOT EXISTS "guest_identities_claimed_by_user_id_idx" ON "guest_identities"("claimed_by_user_id");

CREATE TABLE IF NOT EXISTS "team_invites" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID NOT NULL,
  "email" VARCHAR(320) NOT NULL,
  "role" "TeamRole" NOT NULL,
  "token" VARCHAR(128) NOT NULL,
  "invited_by_user_id" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "accepted_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "team_invites_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "team_invites_token_key" ON "team_invites"("token");
CREATE INDEX IF NOT EXISTS "team_invites_team_id_idx" ON "team_invites"("team_id");
CREATE INDEX IF NOT EXISTS "team_invites_email_idx" ON "team_invites"("email");

CREATE INDEX IF NOT EXISTS "evidence_team_id_idx" ON "evidence"("team_id");
CREATE INDEX IF NOT EXISTS "evidence_guest_identity_id_idx" ON "evidence"("guest_identity_id");
