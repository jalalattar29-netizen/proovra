-- CreateTable team_activities
CREATE TABLE IF NOT EXISTS "public"."team_activities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "event_type" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex team_activity_team_id_idx
CREATE INDEX IF NOT EXISTS "team_activity_team_id_idx" ON "public"."team_activities"("team_id");

-- CreateIndex team_activity_team_id_created_at_idx
CREATE INDEX IF NOT EXISTS "team_activity_team_id_created_at_idx" ON "public"."team_activities"("team_id", "created_at" DESC);

-- CreateIndex team_activity_actor_user_id_idx
CREATE INDEX IF NOT EXISTS "team_activity_actor_user_id_idx" ON "public"."team_activities"("actor_user_id");

-- AddForeignKey team_activity
DO $$ BEGIN
    ALTER TABLE "public"."team_activities" ADD CONSTRAINT "team_activities_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN OTHERS THEN
    NULL;
END $$;

-- AddForeignKey team_activity actor
DO $$ BEGIN
    ALTER TABLE "public"."team_activities" ADD CONSTRAINT "team_activities_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN OTHERS THEN
    NULL;
END $$;

