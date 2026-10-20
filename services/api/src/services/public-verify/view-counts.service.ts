/**
 * AUD-51 (2026-10-20) — THE verification-view counts of one record, read once.
 *
 * The owner workspace issued three separate queries (public count, latest
 * public view, authenticated count) for what is one fact family. Access
 * ACTIVITY on Public Verify (custody access events: views, downloads,
 * verifications) is a different measure, read from the custody chain.
 */
import { prisma } from "../../db.js";

export type VerificationViewCounts = {
  publicViewCount: number;
  authenticatedViewCount: number;
  lastPublicViewAt: Date | null;
};

export async function readVerificationViewCounts(evidenceId: string): Promise<VerificationViewCounts> {
  const rows = await prisma.verificationView.groupBy({
    by: ["viewerType"],
    where: { evidenceId },
    _count: { _all: true },
    _max: { createdAt: true },
  });
  const of = (type: string) => rows.find((r) => String(r.viewerType) === type);
  return {
    publicViewCount: of("PUBLIC")?._count._all ?? 0,
    authenticatedViewCount: of("AUTHENTICATED")?._count._all ?? 0,
    lastPublicViewAt: of("PUBLIC")?._max.createdAt ?? null,
  };
}
