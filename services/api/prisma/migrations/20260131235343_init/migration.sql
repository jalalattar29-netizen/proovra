-- CreateEnum
CREATE TYPE "EvidenceType" AS ENUM ('VIDEO', 'AUDIO', 'PHOTO');

-- CreateEnum
CREATE TYPE "EvidenceStatus" AS ENUM ('CREATED', 'UPLOADING', 'UPLOADED', 'SIGNED', 'REPORTED');

-- CreateEnum
CREATE TYPE "CustodyEventType" AS ENUM ('EVIDENCE_CREATED', 'UPLOAD_STARTED', 'UPLOAD_COMPLETED', 'SIGNATURE_APPLIED', 'REPORT_GENERATED', 'EVIDENCE_VIEWED', 'EVIDENCE_DOWNLOADED');

-- CreateTable
CREATE TABLE "evidence" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" "EvidenceType" NOT NULL,
    "status" "EvidenceStatus" NOT NULL DEFAULT 'CREATED',
    "owner_user_id" TEXT NOT NULL,
    "organization_id" UUID,
    "mime_type" VARCHAR(128),
    "size_bytes" BIGINT,
    "duration_sec" DOUBLE PRECISION,
    "file_sha256" VARCHAR(64),
    "storage_bucket" VARCHAR(255),
    "storage_key" VARCHAR(512),
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "accuracy_meters" DOUBLE PRECISION,
    "captured_at_utc" TIMESTAMPTZ(6),
    "device_time_utc" TIMESTAMPTZ(6),
    "timezone_offset_min" INTEGER,
    "uploaded_at_utc" TIMESTAMPTZ(6),
    "signed_at_utc" TIMESTAMPTZ(6),
    "report_generated_at_utc" TIMESTAMPTZ(6),
    "fingerprint_canonical_json" TEXT,
    "fingerprint_hash" VARCHAR(64),
    "signature_base64" VARCHAR(256),
    "signing_key_id" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custody_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "evidence_id" UUID NOT NULL,
    "event_type" "CustodyEventType" NOT NULL,
    "at_utc" TIMESTAMPTZ(6) NOT NULL,
    "sequence" INTEGER NOT NULL,
    "prev_event_hash" VARCHAR(64),
    "event_hash" VARCHAR(64),
    "payload" JSONB,
    "actor_type" VARCHAR(32) NOT NULL,
    "actor_id" VARCHAR(128),
    "ip" VARCHAR(45),
    "user_agent" VARCHAR(512),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custody_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "evidence_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "storage_bucket" VARCHAR(255) NOT NULL,
    "storage_key" VARCHAR(512) NOT NULL,
    "report_sha256" VARCHAR(64) NOT NULL,
    "generated_at_utc" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signing_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key_id" VARCHAR(64) NOT NULL,
    "public_key_pem" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "signing_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "evidence_owner_user_id_created_at_idx" ON "evidence"("owner_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "evidence_owner_user_id_status_idx" ON "evidence"("owner_user_id", "status");

-- CreateIndex
CREATE INDEX "evidence_organization_id_created_at_idx" ON "evidence"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "evidence_file_sha256_idx" ON "evidence"("file_sha256");

-- CreateIndex
CREATE INDEX "evidence_fingerprint_hash_idx" ON "evidence"("fingerprint_hash");

-- CreateIndex
CREATE INDEX "evidence_status_idx" ON "evidence"("status");

-- CreateIndex
CREATE INDEX "evidence_deleted_at_idx" ON "evidence"("deleted_at");

-- CreateIndex
CREATE INDEX "custody_events_evidence_id_at_utc_idx" ON "custody_events"("evidence_id", "at_utc" ASC);

-- CreateIndex
CREATE INDEX "custody_events_evidence_id_idx" ON "custody_events"("evidence_id");

-- CreateIndex
CREATE INDEX "custody_events_event_type_idx" ON "custody_events"("event_type");

-- CreateIndex
CREATE UNIQUE INDEX "custody_events_evidence_id_sequence_key" ON "custody_events"("evidence_id", "sequence");

-- CreateIndex
CREATE INDEX "reports_evidence_id_idx" ON "reports"("evidence_id");

-- CreateIndex
CREATE INDEX "reports_generated_at_utc_idx" ON "reports"("generated_at_utc" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "reports_evidence_id_version_key" ON "reports"("evidence_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "signing_keys_key_id_key" ON "signing_keys"("key_id");

-- CreateIndex
CREATE INDEX "signing_keys_revoked_at_idx" ON "signing_keys"("revoked_at");

-- AddForeignKey
ALTER TABLE "custody_events" ADD CONSTRAINT "custody_events_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
