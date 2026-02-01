-- DropIndex
DROP INDEX IF EXISTS "evidence_file_sha256_idx";

-- DropIndex
DROP INDEX "signing_keys_key_id_key";

-- AlterTable
ALTER TABLE "evidence" DROP COLUMN "device_time_utc",
DROP COLUMN "timezone_offset_min",
ADD COLUMN     "device_time_iso" VARCHAR(64),
ADD COLUMN     "signing_key_version" INTEGER,
ALTER COLUMN "signing_key_id" SET DATA TYPE VARCHAR(64);

-- AlterTable
ALTER TABLE "signing_keys" ADD COLUMN     "version" INTEGER NOT NULL;

-- CreateIndex
CREATE INDEX "custody_events_evidence_id_sequence_idx" ON "custody_events"("evidence_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "signing_keys_key_id_version_key" ON "signing_keys"("key_id", "version");

-- Recreate index to match schema.prisma
CREATE INDEX IF NOT EXISTS "evidence_file_sha256_idx" ON "evidence"("file_sha256");
