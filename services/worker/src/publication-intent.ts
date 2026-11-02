import { prisma } from "./db.js";

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
  family: "reports" | "verification";
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
