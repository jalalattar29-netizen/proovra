CREATE TYPE "EvidenceCommentVisibility" AS ENUM ('INTERNAL', 'TEAM');
CREATE TYPE "EvidenceLegalNoteType" AS ENUM ('GENERAL', 'PRIVILEGED', 'DISCLOSURE', 'REVIEW_BOUNDARY', 'HANDOFF');
CREATE TYPE "EvidenceAnnotationType" AS ENUM ('POINT', 'BOX', 'REGION', 'TIMESTAMP', 'TEXT');
CREATE TYPE "EvidenceAnnotationCoordinateSpace" AS ENUM ('NORMALIZED', 'PIXEL', 'TIME_ONLY', 'DOCUMENT_PAGE');
CREATE TYPE "EvidenceAiCategorizationStatus" AS ENUM ('DISABLED', 'PENDING', 'COMPLETED', 'FAILED');

CREATE TABLE "evidence_saved_views" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "owner_user_id" UUID NOT NULL,
  "team_id" UUID,
  "name" VARCHAR(120) NOT NULL,
  "description" VARCHAR(400),
  "filters_json" JSONB NOT NULL,
  "sort_key" VARCHAR(64),
  "scope" VARCHAR(32) NOT NULL,
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "evidence_saved_views_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "evidence_saved_views_owner_user_id_fkey"
    FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "evidence_saved_views_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "evidence_reviewer_comments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "evidence_id" UUID NOT NULL,
  "author_user_id" UUID NOT NULL,
  "visibility" "EvidenceCommentVisibility" NOT NULL DEFAULT 'INTERNAL',
  "body" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" TIMESTAMPTZ(6),
  CONSTRAINT "evidence_reviewer_comments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "evidence_reviewer_comments_evidence_id_fkey"
    FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "evidence_reviewer_comments_author_user_id_fkey"
    FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "evidence_legal_notes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "evidence_id" UUID NOT NULL,
  "author_user_id" UUID NOT NULL,
  "note_type" "EvidenceLegalNoteType" NOT NULL DEFAULT 'GENERAL',
  "body" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" TIMESTAMPTZ(6),
  CONSTRAINT "evidence_legal_notes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "evidence_legal_notes_evidence_id_fkey"
    FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "evidence_legal_notes_author_user_id_fkey"
    FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "evidence_annotations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "evidence_id" UUID NOT NULL,
  "evidence_part_id" UUID,
  "author_user_id" UUID NOT NULL,
  "annotation_type" "EvidenceAnnotationType" NOT NULL,
  "body" TEXT,
  "page_number" INTEGER,
  "media_timestamp_ms" INTEGER,
  "x" DOUBLE PRECISION,
  "y" DOUBLE PRECISION,
  "width" DOUBLE PRECISION,
  "height" DOUBLE PRECISION,
  "coordinate_space" "EvidenceAnnotationCoordinateSpace" NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" TIMESTAMPTZ(6),
  CONSTRAINT "evidence_annotations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "evidence_annotations_evidence_id_fkey"
    FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "evidence_annotations_evidence_part_id_fkey"
    FOREIGN KEY ("evidence_part_id") REFERENCES "evidence_parts"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "evidence_annotations_author_user_id_fkey"
    FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "evidence_ai_categorizations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "evidence_id" UUID NOT NULL,
  "requested_by_user_id" UUID NOT NULL,
  "status" "EvidenceAiCategorizationStatus" NOT NULL DEFAULT 'PENDING',
  "categories_json" JSONB,
  "suggested_tags_json" JSONB,
  "risk_flags_json" JSONB,
  "summary" TEXT,
  "legal_disclaimer" TEXT NOT NULL,
  "model" VARCHAR(120),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "evidence_ai_categorizations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "evidence_ai_categorizations_evidence_id_fkey"
    FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "evidence_ai_categorizations_requested_by_user_id_fkey"
    FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "evidence_saved_views_owner_user_id_created_at_idx"
  ON "evidence_saved_views"("owner_user_id", "created_at" DESC);
CREATE INDEX "evidence_saved_views_team_id_created_at_idx"
  ON "evidence_saved_views"("team_id", "created_at" DESC);
CREATE INDEX "evidence_saved_views_owner_user_id_is_default_idx"
  ON "evidence_saved_views"("owner_user_id", "is_default");

CREATE INDEX "evidence_reviewer_comments_evidence_id_created_at_idx"
  ON "evidence_reviewer_comments"("evidence_id", "created_at" DESC);
CREATE INDEX "evidence_reviewer_comments_author_user_id_idx"
  ON "evidence_reviewer_comments"("author_user_id");
CREATE INDEX "evidence_reviewer_comments_deleted_at_idx"
  ON "evidence_reviewer_comments"("deleted_at");

CREATE INDEX "evidence_legal_notes_evidence_id_created_at_idx"
  ON "evidence_legal_notes"("evidence_id", "created_at" DESC);
CREATE INDEX "evidence_legal_notes_author_user_id_idx"
  ON "evidence_legal_notes"("author_user_id");
CREATE INDEX "evidence_legal_notes_deleted_at_idx"
  ON "evidence_legal_notes"("deleted_at");

CREATE INDEX "evidence_annotations_evidence_id_created_at_idx"
  ON "evidence_annotations"("evidence_id", "created_at" DESC);
CREATE INDEX "evidence_annotations_evidence_part_id_idx"
  ON "evidence_annotations"("evidence_part_id");
CREATE INDEX "evidence_annotations_author_user_id_idx"
  ON "evidence_annotations"("author_user_id");
CREATE INDEX "evidence_annotations_deleted_at_idx"
  ON "evidence_annotations"("deleted_at");

CREATE INDEX "evidence_ai_categorizations_evidence_id_created_at_idx"
  ON "evidence_ai_categorizations"("evidence_id", "created_at" DESC);
CREATE INDEX "evidence_ai_categorizations_requested_by_user_id_created_at_idx"
  ON "evidence_ai_categorizations"("requested_by_user_id", "created_at" DESC);
CREATE INDEX "evidence_ai_categorizations_status_idx"
  ON "evidence_ai_categorizations"("status");
