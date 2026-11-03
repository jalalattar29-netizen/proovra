import { prisma } from "./db.js";
import {
  buildPublicationKey,
  readBackPublishedArtifact,
  type PublishedArtifact,
} from "./immutable-publication.js";
import { isObjectLockEnabled, type ResolvedObjectLock } from "./storage.js";

type Family = "reports" | "verification";

/**
 * REPORT-006 — THE INTENT COMES FIRST. A published object is locked and cannot be
 * deleted before its horizon, and the row that references it commits afterwards.
 * Recording the key before the write means a failed commit or a crash leaves an
 * object the orphan scan can count, instead of one nothing lists. A failure here
 * stops the publication: nothing goes to locked storage unaccounted.
 */
export async function recordPublicationIntent(input: {
  evidenceId: string;
  requestId: string;
  family: Family;
  bucket: string;
  key: string;
}): Promise<void> {
  await prisma.artifactPublicationIntent.createMany({
    data: [
      {
        evidenceId: input.evidenceId,
        requestId: input.requestId,
        family: input.family,
        storageBucket: input.bucket,
        storageKey: input.key,
      },
    ],
    skipDuplicates: true,
  });
}

/**
 * Publish once per request and bytes (REPORT-006).
 *
 * Each attempt wrote to a new key under the record's lock, so a request that
 * published and then failed to commit left one undeletable copy per attempt, up
 * to twelve. A retry of the SAME request whose bytes are identical now reuses
 * the object an earlier attempt published and verified, after reading it back by
 * version again. Anything else (other bytes, another request, an object that no
 * longer reads back as sent, one a committed row already references) publishes
 * afresh, exactly as before.
 */
export async function publishThroughIntent(input: {
  evidenceId: string;
  requestId: string;
  family: Family;
  bucket: string;
  version: number;
  extension: "pdf" | "zip";
  sizeBytes: number;
  sha256Base64: string;
  lock: ResolvedObjectLock | null;
  publish: (key: string) => Promise<PublishedArtifact>;
}): Promise<PublishedArtifact & { reused: boolean }> {
  const sha256Hex = Buffer.from(input.sha256Base64, "base64").toString("hex");
  const candidates = await prisma.$queryRaw<Array<{ storage_key: string; version_id: string | null }>>`
    SELECT i."storage_key", i."version_id"
      FROM "artifact_publication_intents" i
     WHERE i."request_id" = ${input.requestId}::uuid
       AND i."evidence_id" = ${input.evidenceId}::uuid
       AND i."family" = ${input.family}
       AND i."storage_bucket" = ${input.bucket}
       AND i."sha256_hex" = ${sha256Hex}
       AND i."size_bytes" = ${BigInt(input.sizeBytes)}
       AND i."verified_at_utc" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "reports" r
                        WHERE r."storage_bucket" = i."storage_bucket" AND r."storage_key" = i."storage_key")
       AND NOT EXISTS (SELECT 1 FROM "verification_packages" p
                        WHERE p."storage_bucket" = i."storage_bucket" AND p."storage_key" = i."storage_key")
     ORDER BY i."verified_at_utc" DESC
     LIMIT 1`;
  const candidate = candidates[0];
  if (candidate) {
    const lockEnabled = isObjectLockEnabled();
    const read = await readBackPublishedArtifact({
      bucket: input.bucket,
      key: candidate.storage_key,
      versionId: candidate.version_id,
      sizeBytes: input.sizeBytes,
      sha256Base64: input.sha256Base64,
      lockMode: lockEnabled && input.lock ? input.lock.mode : null,
      minimumRetainUntil: lockEnabled && input.lock ? input.lock.retainUntil : null,
    }).catch(() => null);
    if (read && read.mismatches.length === 0) return { ...read.artifact, reused: true };
  }

  const key = buildPublicationKey({
    family: input.family,
    evidenceId: input.evidenceId,
    version: input.version,
    requestId: input.requestId,
    extension: input.extension,
  });
  await recordPublicationIntent({
    evidenceId: input.evidenceId,
    requestId: input.requestId,
    family: input.family,
    bucket: input.bucket,
    key,
  });
  const published = await input.publish(key);
  // Only an object the publication read back as sent is ever offered for reuse.
  await prisma.artifactPublicationIntent.updateMany({
    where: { storageBucket: input.bucket, storageKey: key },
    data: {
      sha256Hex: published.sha256Hex,
      sizeBytes: BigInt(published.sizeBytes),
      versionId: published.versionId,
      verifiedAtUtc: new Date(),
    },
  });
  return { ...published, reused: false };
}
