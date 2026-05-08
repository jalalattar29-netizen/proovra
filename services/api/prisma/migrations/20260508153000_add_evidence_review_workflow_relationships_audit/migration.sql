CREATE TYPE "EvidenceReviewWorkflowStatus" AS ENUM (
  'NOT_STARTED',
  'IN_REVIEW',
  'NEEDS_INFO',
  'READY_FOR_EXTERNAL_REVIEW',
  'APPROVED_INTERNAL',
  'ESCALATED',
  'CLOSED'
);

CREATE TYPE "EvidenceReviewWorkflowPriority" AS ENUM (
  'LOW',
  'NORMAL',
  'HIGH',
  'URGENT'
);

CREATE TYPE "EvidenceReviewWorkflowEventType" AS ENUM (
  'CREATED',
  'ASSIGNED',
  'UNASSIGNED',
  'STATUS_CHANGED',
  'PRIORITY_CHANGED',
  'DUE_DATE_CHANGED',
  'REVIEW_STARTED',
  'REVIEW_COMPLETED',
  'ESCALATED',
  'CLOSED'
);

CREATE TYPE "EvidenceRelationshipType" AS ENUM (
  'RELATED',
  'SUPPORTS',
  'DUPLICATE_OF',
  'DERIVED_FROM',
  'SAME_INCIDENT',
  'CONTRADICTS',
  'REPLACES',
  'REFERENCES'
);

CREATE TYPE "EvidenceReviewerAuditEventType" AS ENUM (
  'COMMENT_CREATED',
  'COMMENT_UPDATED',
  'COMMENT_DELETED',
  'LEGAL_NOTE_CREATED',
  'LEGAL_NOTE_UPDATED',
  'LEGAL_NOTE_DELETED',
  'ANNOTATION_CREATED',
  'ANNOTATION_UPDATED',
  'ANNOTATION_DELETED',
  'WORKFLOW_UPDATED',
  'RELATIONSHIP_CREATED',
  'RELATIONSHIP_UPDATED',
  'RELATIONSHIP_DELETED',
  'AI_CATEGORIZATION_RUN',
  'AI_CATEGORIZATION_ACCEPTED',
  'AI_CATEGORIZATION_REJECTED'
);

CREATE TABLE "evidence_review_workflows" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "evidence_id" UUID NOT NULL,
  "workspace_type" VARCHAR(32) NOT NULL,
  "team_id" UUID,
  "assigned_to_user_id" UUID,
  "assigned_by_user_id" UUID,
  "status" "EvidenceReviewWorkflowStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "priority" "EvidenceReviewWorkflowPriority" NOT NULL DEFAULT 'NORMAL',
  "due_at" TIMESTAMPTZ(6),
  "last_reviewed_at" TIMESTAMPTZ(6),
  "closed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "evidence_review_workflows_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "evidence_review_workflows_evidence_id_fkey"
    FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "evidence_review_workflows_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "evidence_review_workflows_assigned_to_user_id_fkey"
    FOREIGN KEY ("assigned_to_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "evidence_review_workflows_assigned_by_user_id_fkey"
    FOREIGN KEY ("assigned_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "evidence_review_workflow_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workflow_id" UUID NOT NULL,
  "evidence_id" UUID NOT NULL,
  "actor_user_id" UUID,
  "event_type" "EvidenceReviewWorkflowEventType" NOT NULL,
  "previous_value" JSONB,
  "next_value" JSONB,
  "note" VARCHAR(1000),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "evidence_review_workflow_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "evidence_review_workflow_events_workflow_id_fkey"
    FOREIGN KEY ("workflow_id") REFERENCES "evidence_review_workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "evidence_review_workflow_events_evidence_id_fkey"
    FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "evidence_review_workflow_events_actor_user_id_fkey"
    FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "evidence_relationships" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "source_evidence_id" UUID NOT NULL,
  "target_evidence_id" UUID NOT NULL,
  "relationship_type" "EvidenceRelationshipType" NOT NULL,
  "note" VARCHAR(1000),
  "created_by_user_id" UUID,
  "team_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "evidence_relationships_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "evidence_relationships_source_evidence_id_fkey"
    FOREIGN KEY ("source_evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "evidence_relationships_target_evidence_id_fkey"
    FOREIGN KEY ("target_evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "evidence_relationships_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "evidence_relationships_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "evidence_reviewer_audit_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "evidence_id" UUID NOT NULL,
  "actor_user_id" UUID,
  "event_type" "EvidenceReviewerAuditEventType" NOT NULL,
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "evidence_reviewer_audit_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "evidence_reviewer_audit_events_evidence_id_fkey"
    FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "evidence_reviewer_audit_events_actor_user_id_fkey"
    FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "evidence_review_workflows_evidence_id_key"
  ON "evidence_review_workflows"("evidence_id");
CREATE INDEX "evidence_review_workflows_team_id_idx"
  ON "evidence_review_workflows"("team_id");
CREATE INDEX "evidence_review_workflows_assigned_to_user_id_idx"
  ON "evidence_review_workflows"("assigned_to_user_id");
CREATE INDEX "evidence_review_workflows_assigned_by_user_id_idx"
  ON "evidence_review_workflows"("assigned_by_user_id");
CREATE INDEX "evidence_review_workflows_status_idx"
  ON "evidence_review_workflows"("status");
CREATE INDEX "evidence_review_workflows_priority_idx"
  ON "evidence_review_workflows"("priority");
CREATE INDEX "evidence_review_workflows_due_at_idx"
  ON "evidence_review_workflows"("due_at");

CREATE INDEX "evidence_review_workflow_events_workflow_id_created_at_idx"
  ON "evidence_review_workflow_events"("workflow_id", "created_at" DESC);
CREATE INDEX "evidence_review_workflow_events_evidence_id_created_at_idx"
  ON "evidence_review_workflow_events"("evidence_id", "created_at" DESC);
CREATE INDEX "evidence_review_workflow_events_actor_user_id_idx"
  ON "evidence_review_workflow_events"("actor_user_id");
CREATE INDEX "evidence_review_workflow_events_event_type_idx"
  ON "evidence_review_workflow_events"("event_type");

CREATE UNIQUE INDEX "evidence_relationships_source_target_type_key"
  ON "evidence_relationships"("source_evidence_id", "target_evidence_id", "relationship_type");
CREATE INDEX "evidence_relationships_source_evidence_id_created_at_idx"
  ON "evidence_relationships"("source_evidence_id", "created_at" DESC);
CREATE INDEX "evidence_relationships_target_evidence_id_created_at_idx"
  ON "evidence_relationships"("target_evidence_id", "created_at" DESC);
CREATE INDEX "evidence_relationships_relationship_type_idx"
  ON "evidence_relationships"("relationship_type");
CREATE INDEX "evidence_relationships_team_id_idx"
  ON "evidence_relationships"("team_id");

CREATE INDEX "evidence_reviewer_audit_events_evidence_id_created_at_idx"
  ON "evidence_reviewer_audit_events"("evidence_id", "created_at" DESC);
CREATE INDEX "evidence_reviewer_audit_events_actor_user_id_idx"
  ON "evidence_reviewer_audit_events"("actor_user_id");
CREATE INDEX "evidence_reviewer_audit_events_event_type_idx"
  ON "evidence_reviewer_audit_events"("event_type");
