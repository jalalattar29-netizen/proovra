import * as prismaPkg from "@prisma/client";

/**
 * ET-INT-03 / ET-ACQ-02 — THE counted-record predicate. An evidence record
 * occupies an allowance slot when it is ESTABLISHED (finalized: it left
 * CREATED/UPLOADING) or while it is a LIVE RESERVATION (an unfinished upload
 * younger than the reservation window). An abandoned draft — an interrupted
 * web capture, an anonymous intake session that never submitted — stops
 * consuming the owner's allowance when its reservation expires instead of
 * holding the slot forever. Completion still settles funding under the
 * per-subject lock, so an expired reservation that later completes is counted
 * then. Every allowance count (admission, settlement, the billing meters) uses
 * this one predicate.
 */
export const EVIDENCE_RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;

export function countedEvidenceRecordWhere(now: Date = new Date()): prismaPkg.Prisma.EvidenceWhereInput {
  return {
    OR: [
      { status: { notIn: [prismaPkg.EvidenceStatus.CREATED, prismaPkg.EvidenceStatus.UPLOADING] } },
      { createdAt: { gte: new Date(now.getTime() - EVIDENCE_RESERVATION_TTL_MS) } },
    ],
  };
}
