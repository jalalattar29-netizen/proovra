-- Phase M3.1 — Insurance SIU durability.
--
-- Five additive tables that replace the M3 in-memory registry with a
-- durable Prisma projection. Safe on Neon: no existing column or
-- constraint changes; only CREATE TABLE + CREATE INDEX + ADD FK on
-- the new tables. Bounded VARCHAR caps mirror existing PROOVRA
-- conventions and keep the index footprint small.
--
-- Hard rules:
--   * Workspace-scoped via team_id on the profile (FKs cascade from
--     the profile down to checklist / follow-up / indicator / export).
--   * Bounded operator-facing strings.
--   * Privacy-gated claimant fields persisted alongside a bounded
--     `pii_visibility_policy` column so policy lives next to the data.
--   * Every cascade is `ON DELETE CASCADE` on the profile FK so a
--     deleted profile prunes its dependents cleanly.

-- ------------------------------------------------------------------
-- Profile table.
-- ------------------------------------------------------------------
CREATE TABLE "case_siu_profiles" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "case_id" uuid NOT NULL,
  "team_id" uuid NOT NULL,
  "claim_type" varchar(24) NOT NULL,
  "investigation_status" varchar(24) NOT NULL,
  "claim_number" varchar(80),
  "policy_reference" varchar(120),
  "incident_date" timestamptz(6),
  "incident_location_json" jsonb,
  "loss_description" varchar(2000),
  "assigned_adjuster_user_id" uuid,
  "assigned_siu_reviewer_user_id" uuid,
  "claimant_name" varchar(200),
  "claimant_contact" varchar(200),
  "pii_visibility_policy" varchar(40) NOT NULL DEFAULT 'redacted_by_default',
  "intake_template_id" varchar(60),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(6) NOT NULL,
  CONSTRAINT "case_siu_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "case_siu_profiles_case_id_key"
  ON "case_siu_profiles" ("case_id");

CREATE INDEX "case_siu_profiles_team_id_idx"
  ON "case_siu_profiles" ("team_id");
CREATE INDEX "case_siu_profiles_team_id_investigation_status_idx"
  ON "case_siu_profiles" ("team_id", "investigation_status");
CREATE INDEX "case_siu_profiles_team_id_claim_type_idx"
  ON "case_siu_profiles" ("team_id", "claim_type");
CREATE INDEX "case_siu_profiles_assigned_adjuster_user_id_idx"
  ON "case_siu_profiles" ("assigned_adjuster_user_id");
CREATE INDEX "case_siu_profiles_assigned_siu_reviewer_user_id_idx"
  ON "case_siu_profiles" ("assigned_siu_reviewer_user_id");

-- ------------------------------------------------------------------
-- Checklist items.
-- ------------------------------------------------------------------
CREATE TABLE "case_siu_checklist_items" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "siu_profile_id" uuid NOT NULL,
  "template_item_id" varchar(120) NOT NULL,
  "label" varchar(120) NOT NULL,
  "description" varchar(480),
  "required" boolean NOT NULL DEFAULT false,
  "accepted_kinds_json" jsonb NOT NULL,
  "status" varchar(24) NOT NULL DEFAULT 'missing',
  "mapped_evidence_ids_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "note" varchar(480),
  "due_at" timestamptz(6),
  "satisfied_at" timestamptz(6),
  "satisfied_by_user_id" uuid,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(6) NOT NULL,
  CONSTRAINT "case_siu_checklist_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "case_siu_checklist_profile_item_uniq"
  ON "case_siu_checklist_items" ("siu_profile_id", "template_item_id");
CREATE INDEX "case_siu_checklist_items_siu_profile_id_idx"
  ON "case_siu_checklist_items" ("siu_profile_id");
CREATE INDEX "case_siu_checklist_items_siu_profile_id_status_idx"
  ON "case_siu_checklist_items" ("siu_profile_id", "status");

ALTER TABLE "case_siu_checklist_items"
  ADD CONSTRAINT "case_siu_checklist_items_siu_profile_id_fkey"
  FOREIGN KEY ("siu_profile_id")
  REFERENCES "case_siu_profiles"("id") ON DELETE CASCADE;

-- ------------------------------------------------------------------
-- Follow-ups.
-- ------------------------------------------------------------------
CREATE TABLE "case_siu_follow_ups" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "siu_profile_id" uuid NOT NULL,
  "checklist_item_id" varchar(120) NOT NULL,
  "intake_link_id" uuid,
  "recipient_role" varchar(32),
  "recipient_contact_redacted" varchar(120),
  "status" varchar(24) NOT NULL DEFAULT 'open',
  "due_by_utc" timestamptz(6),
  "requested_by_user_id" uuid,
  "requested_at_utc" timestamptz(6) NOT NULL DEFAULT now(),
  "received_at_utc" timestamptz(6),
  "satisfied_at_utc" timestamptz(6),
  "message_template_key" varchar(80),
  "private_notes" varchar(480),
  "returned_evidence_ids_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(6) NOT NULL,
  CONSTRAINT "case_siu_follow_ups_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "case_siu_follow_ups_siu_profile_id_idx"
  ON "case_siu_follow_ups" ("siu_profile_id");
CREATE INDEX "case_siu_follow_ups_siu_profile_id_status_idx"
  ON "case_siu_follow_ups" ("siu_profile_id", "status");
CREATE INDEX "case_siu_follow_ups_siu_profile_id_due_by_utc_idx"
  ON "case_siu_follow_ups" ("siu_profile_id", "due_by_utc");

ALTER TABLE "case_siu_follow_ups"
  ADD CONSTRAINT "case_siu_follow_ups_siu_profile_id_fkey"
  FOREIGN KEY ("siu_profile_id")
  REFERENCES "case_siu_profiles"("id") ON DELETE CASCADE;

-- ------------------------------------------------------------------
-- Review indicators.
-- ------------------------------------------------------------------
CREATE TABLE "case_siu_review_indicators" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "siu_profile_id" uuid NOT NULL,
  "code" varchar(80) NOT NULL,
  "severity" varchar(16) NOT NULL,
  "evidence_id" uuid,
  "checklist_item_id" varchar(120),
  "title" varchar(120),
  "explanation" varchar(240) NOT NULL,
  "source" varchar(24) NOT NULL DEFAULT 'reviewer',
  "status" varchar(16) NOT NULL DEFAULT 'open',
  "created_by_user_id" uuid,
  "observed_at_utc" timestamptz(6) NOT NULL DEFAULT now(),
  "resolved_at_utc" timestamptz(6),
  "resolved_by_user_id" uuid,
  CONSTRAINT "case_siu_review_indicators_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "case_siu_review_indicators_siu_profile_id_idx"
  ON "case_siu_review_indicators" ("siu_profile_id");
CREATE INDEX "case_siu_review_indicators_siu_profile_id_severity_idx"
  ON "case_siu_review_indicators" ("siu_profile_id", "severity");
CREATE INDEX "case_siu_review_indicators_siu_profile_id_status_idx"
  ON "case_siu_review_indicators" ("siu_profile_id", "status");

ALTER TABLE "case_siu_review_indicators"
  ADD CONSTRAINT "case_siu_review_indicators_siu_profile_id_fkey"
  FOREIGN KEY ("siu_profile_id")
  REFERENCES "case_siu_profiles"("id") ON DELETE CASCADE;

-- ------------------------------------------------------------------
-- Exports (durable history).
-- ------------------------------------------------------------------
CREATE TABLE "case_siu_exports" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "siu_profile_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "export_status" varchar(24) NOT NULL DEFAULT 'generated',
  "readiness_state" varchar(40) NOT NULL,
  "warning_codes_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "blocker_codes_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "warning_export_reason" varchar(240),
  "artifact_storage_bucket" varchar(255),
  "artifact_storage_key" varchar(512),
  "artifact_sha256" varchar(64),
  "artifact_size_bytes" bigint,
  "manifest_sha256" varchar(64),
  "artifact_inclusion_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "generated_by_user_id" uuid,
  "generated_at_utc" timestamptz(6) NOT NULL DEFAULT now(),
  "downloaded_at_utc" timestamptz(6),
  "error_code" varchar(80),
  "error_message" varchar(480),
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(6) NOT NULL,
  CONSTRAINT "case_siu_exports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "case_siu_exports_siu_profile_id_generated_at_utc_idx"
  ON "case_siu_exports" ("siu_profile_id", "generated_at_utc" DESC);
CREATE INDEX "case_siu_exports_case_id_generated_at_utc_idx"
  ON "case_siu_exports" ("case_id", "generated_at_utc" DESC);
CREATE INDEX "case_siu_exports_siu_profile_id_export_status_idx"
  ON "case_siu_exports" ("siu_profile_id", "export_status");

ALTER TABLE "case_siu_exports"
  ADD CONSTRAINT "case_siu_exports_siu_profile_id_fkey"
  FOREIGN KEY ("siu_profile_id")
  REFERENCES "case_siu_profiles"("id") ON DELETE CASCADE;
