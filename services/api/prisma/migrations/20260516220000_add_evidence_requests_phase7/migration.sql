-- Phase 7 Evidence Operations: EvidenceRequest domain
--
-- Forward-only, additive migration:
--   * Six new enums (request status, priority, type, recipient mode,
--     deliverable status, response status).
--   * Four new tables (evidence_requests, evidence_request_deliverables,
--     evidence_request_responses, evidence_request_events).
--   * No existing rows modified, no destructive operations.
--
-- Rollback risk: low. To reverse (in order):
--   DROP TABLE IF EXISTS evidence_request_events;
--   DROP TABLE IF EXISTS evidence_request_responses;
--   DROP TABLE IF EXISTS evidence_request_deliverables;
--   DROP TABLE IF EXISTS evidence_requests;
--   DROP TYPE IF EXISTS "EvidenceRequestResponseStatus";
--   DROP TYPE IF EXISTS "EvidenceRequestDeliverableStatus";
--   DROP TYPE IF EXISTS "EvidenceRequestRecipientMode";
--   DROP TYPE IF EXISTS "EvidenceRequestType";
--   DROP TYPE IF EXISTS "EvidenceRequestPriority";
--   DROP TYPE IF EXISTS "EvidenceRequestStatus";
--
-- Production deploy command:
--   pnpm --filter proovra-api prisma migrate deploy

-- 1. Enums -----------------------------------------------------------------

CREATE TYPE "EvidenceRequestStatus" AS ENUM (
  'DRAFT',
  'OPEN',
  'SENT',
  'VIEWED',
  'IN_PROGRESS',
  'RESPONSE_RECEIVED',
  'UNDER_REVIEW',
  'PARTIALLY_FULFILLED',
  'FULFILLED',
  'NEEDS_MORE_INFO',
  'CANCELLED',
  'CLOSED'
);

CREATE TYPE "EvidenceRequestPriority" AS ENUM (
  'LOW',
  'NORMAL',
  'HIGH',
  'URGENT'
);

CREATE TYPE "EvidenceRequestType" AS ENUM (
  'ADDITIONAL_EVIDENCE',
  'CLARIFICATION',
  'REPLACEMENT_FILE',
  'WITNESS_STATEMENT',
  'DOCUMENT',
  'OTHER'
);

CREATE TYPE "EvidenceRequestRecipientMode" AS ENUM (
  'INTERNAL_USER',
  'EXTERNAL_CONTRIBUTOR',
  'ANONYMOUS_SOURCE',
  'PSEUDONYMOUS_SOURCE'
);

CREATE TYPE "EvidenceRequestDeliverableStatus" AS ENUM (
  'PENDING',
  'PARTIALLY_FULFILLED',
  'FULFILLED',
  'WAIVED',
  'REJECTED'
);

CREATE TYPE "EvidenceRequestResponseStatus" AS ENUM (
  'RECEIVED',
  'UNDER_REVIEW',
  'ACCEPTED',
  'NEEDS_MORE_INFO',
  'REJECTED'
);

-- 2. evidence_requests -----------------------------------------------------

CREATE TABLE "evidence_requests" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID NOT NULL,
  "evidence_id" UUID,
  "case_id" UUID,
  "workflow_template_slug" VARCHAR(120),
  "workflow_template_version" INTEGER,
  "workflow_step_id" VARCHAR(120),
  "request_type" "EvidenceRequestType" NOT NULL,
  "status" "EvidenceRequestStatus" NOT NULL DEFAULT 'DRAFT',
  "priority" "EvidenceRequestPriority" NOT NULL DEFAULT 'NORMAL',
  "title" VARCHAR(180) NOT NULL,
  "instructions" TEXT NOT NULL DEFAULT '',
  "due_at_utc" TIMESTAMPTZ(6),
  "recipient_mode" "EvidenceRequestRecipientMode" NOT NULL,
  "recipient_label" VARCHAR(180),
  "recipient_email" VARCHAR(320),
  "recipient_phone" VARCHAR(32),
  "requested_by_user_id" UUID NOT NULL,
  "assigned_reviewer_user_id" UUID,
  "intake_link_id" UUID,
  "visibility_policy_json" JSONB,
  "export_policy_json" JSONB,
  "reviewer_note" VARCHAR(4000),
  "reviewer_decision_at_utc" TIMESTAMPTZ(6),
  "reviewer_decision_by_user_id" UUID,
  "sent_at_utc" TIMESTAMPTZ(6),
  "first_opened_at_utc" TIMESTAMPTZ(6),
  "closed_at_utc" TIMESTAMPTZ(6),
  "cancelled_at_utc" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "evidence_requests_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "evidence_requests_evidence_id_fkey"
    FOREIGN KEY ("evidence_id") REFERENCES "evidence" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "evidence_requests_requested_by_user_id_fkey"
    FOREIGN KEY ("requested_by_user_id") REFERENCES "users" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "evidence_requests_assigned_reviewer_user_id_fkey"
    FOREIGN KEY ("assigned_reviewer_user_id") REFERENCES "users" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "evidence_requests_reviewer_decision_by_user_id_fkey"
    FOREIGN KEY ("reviewer_decision_by_user_id") REFERENCES "users" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "evidence_requests_intake_link_id_fkey"
    FOREIGN KEY ("intake_link_id") REFERENCES "workflow_intake_links" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "evidence_requests_team_id_status_idx"
  ON "evidence_requests" ("team_id", "status");
CREATE INDEX "evidence_requests_team_id_created_at_idx"
  ON "evidence_requests" ("team_id", "created_at" DESC);
CREATE INDEX "evidence_requests_team_id_priority_idx"
  ON "evidence_requests" ("team_id", "priority");
CREATE INDEX "evidence_requests_evidence_id_idx"
  ON "evidence_requests" ("evidence_id");
CREATE INDEX "evidence_requests_case_id_idx"
  ON "evidence_requests" ("case_id");
CREATE INDEX "evidence_requests_assigned_reviewer_user_id_idx"
  ON "evidence_requests" ("assigned_reviewer_user_id");
CREATE INDEX "evidence_requests_requested_by_user_id_idx"
  ON "evidence_requests" ("requested_by_user_id");
CREATE INDEX "evidence_requests_due_at_utc_idx"
  ON "evidence_requests" ("due_at_utc");
CREATE INDEX "evidence_requests_intake_link_id_idx"
  ON "evidence_requests" ("intake_link_id");

-- 3. evidence_request_deliverables -----------------------------------------

CREATE TABLE "evidence_request_deliverables" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "evidence_request_id" UUID NOT NULL,
  "title" VARCHAR(180) NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "required" BOOLEAN NOT NULL DEFAULT TRUE,
  "accepted_kinds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "min_count" INTEGER NOT NULL DEFAULT 1,
  "max_count" INTEGER,
  "location_requirement" VARCHAR(20) NOT NULL DEFAULT 'optional',
  "capture_after_request" BOOLEAN NOT NULL DEFAULT FALSE,
  "metadata_requirements" JSONB,
  "workflow_step_id" VARCHAR(120),
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "status" "EvidenceRequestDeliverableStatus" NOT NULL DEFAULT 'PENDING',
  "waived_reason" VARCHAR(400),
  "fulfilled_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "evidence_request_deliverables_request_fkey"
    FOREIGN KEY ("evidence_request_id") REFERENCES "evidence_requests" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "evidence_request_deliverables_request_sort_idx"
  ON "evidence_request_deliverables" ("evidence_request_id", "sort_order");
CREATE INDEX "evidence_request_deliverables_request_status_idx"
  ON "evidence_request_deliverables" ("evidence_request_id", "status");

-- 4. evidence_request_responses --------------------------------------------

CREATE TABLE "evidence_request_responses" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "evidence_request_id" UUID NOT NULL,
  "intake_session_id" UUID,
  "response_evidence_id" UUID,
  "submitted_by_user_id" UUID,
  "submitted_by_external_label" VARCHAR(180),
  "status" "EvidenceRequestResponseStatus" NOT NULL DEFAULT 'RECEIVED',
  "reviewer_note" VARCHAR(4000),
  "submitted_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "reviewed_at_utc" TIMESTAMPTZ(6),
  "reviewed_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "evidence_request_responses_request_fkey"
    FOREIGN KEY ("evidence_request_id") REFERENCES "evidence_requests" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "evidence_request_responses_intake_session_fkey"
    FOREIGN KEY ("intake_session_id") REFERENCES "workflow_intake_sessions" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "evidence_request_responses_response_evidence_fkey"
    FOREIGN KEY ("response_evidence_id") REFERENCES "evidence" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "evidence_request_responses_submitted_by_user_fkey"
    FOREIGN KEY ("submitted_by_user_id") REFERENCES "users" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "evidence_request_responses_reviewed_by_user_fkey"
    FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "evidence_request_responses_intake_session_id_key"
  ON "evidence_request_responses" ("intake_session_id");
CREATE UNIQUE INDEX "evidence_request_responses_response_evidence_id_key"
  ON "evidence_request_responses" ("response_evidence_id");
CREATE INDEX "evidence_request_responses_request_submitted_idx"
  ON "evidence_request_responses" ("evidence_request_id", "submitted_at_utc" DESC);
CREATE INDEX "evidence_request_responses_request_status_idx"
  ON "evidence_request_responses" ("evidence_request_id", "status");

-- 5. evidence_request_events -----------------------------------------------

CREATE TABLE "evidence_request_events" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "evidence_request_id" UUID NOT NULL,
  "event_type" VARCHAR(64) NOT NULL,
  "actor_user_id" UUID,
  "payload" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "evidence_request_events_request_fkey"
    FOREIGN KEY ("evidence_request_id") REFERENCES "evidence_requests" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "evidence_request_events_actor_user_fkey"
    FOREIGN KEY ("actor_user_id") REFERENCES "users" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "evidence_request_events_request_created_idx"
  ON "evidence_request_events" ("evidence_request_id", "created_at" DESC);
CREATE INDEX "evidence_request_events_type_created_idx"
  ON "evidence_request_events" ("event_type", "created_at" DESC);
