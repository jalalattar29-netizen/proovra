/*
  Warnings:

  - You are about to drop the column `actor_id` on the `custody_events` table. All the data in the column will be lost.
  - You are about to drop the column `actor_type` on the `custody_events` table. All the data in the column will be lost.
  - You are about to drop the column `event_hash` on the `custody_events` table. All the data in the column will be lost.
  - You are about to drop the column `prev_event_hash` on the `custody_events` table. All the data in the column will be lost.
  - You are about to drop the column `created_at` on the `reports` table. All the data in the column will be lost.
  - You are about to drop the column `report_sha256` on the `reports` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX IF EXISTS "custody_events_evidence_id_sequence_idx";

-- AlterTable
ALTER TABLE "custody_events" DROP COLUMN "actor_id",
DROP COLUMN "actor_type",
DROP COLUMN "event_hash",
DROP COLUMN "prev_event_hash";

-- AlterTable
ALTER TABLE "reports" DROP COLUMN "created_at",
DROP COLUMN "report_sha256";

-- CreateIndex
CREATE INDEX IF NOT EXISTS "evidence_file_sha256_idx" ON "evidence"("file_sha256");
