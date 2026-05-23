-- PHASE 38 — Workspace persona profile (UX-layer only).
--
-- Additive only. One row per workspace; default record materialised
-- lazily by the resolver when absent. NEVER grants capabilities.

CREATE TABLE IF NOT EXISTS "workspace_persona_profiles" (
  "team_id"                          UUID NOT NULL PRIMARY KEY,
  "primary_profile"                  VARCHAR(40) NOT NULL DEFAULT 'INDIVIDUAL',
  "secondary_use_cases"              JSONB NOT NULL DEFAULT '[]'::jsonb,
  "onboarding_completed"             BOOLEAN NOT NULL DEFAULT false,
  "preferred_dashboard_layout"       VARCHAR(64),
  "operational_density_preference"   VARCHAR(20) NOT NULL DEFAULT 'comfortable',
  "feature_priority_overrides"       JSONB NOT NULL DEFAULT '[]'::jsonb,
  "onboarding_state"                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at"                       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"                       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_persona_profiles_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams" ("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "workspace_persona_profiles_primary_profile_idx"
  ON "workspace_persona_profiles" ("primary_profile");
