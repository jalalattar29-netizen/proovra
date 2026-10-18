/**
 * Test helper — give a recipient a reviewer share link the way an owner does
 * (ET-PKG-07): mint an OWNER_SHARE link through the verification-share
 * authority. Returns the token; `/public/verify/<token>` opens the record.
 *
 * A record's id is not a public link, so a test that used to request
 * `/public/verify/<id>` of a row it had just created now asks for a link.
 *
 * (2026-10-18) There is no publication step any more. A reviewer share is
 * gated by the record's canonical ACCESS state (and lifecycle) and by its own
 * state; what it discloses is the link's own profile — a STANDARD link opens
 * the content preview by itself, a BASIC link shows verification only — and
 * originals only with an explicit `allowOriginalDownload` grant. Creating a
 * link never changes the record's disclosure policy.
 */
import { mintVerificationShareTokenTx, type VerificationShareProjection } from "@proovra/shared-runtime";

type Db = (typeof import("../../src/db.js"))["prisma"];

export async function createReviewerShareLink(
  prisma: Db,
  evidenceId: string,
  opts: { projection?: VerificationShareProjection; allowOriginalDownload?: boolean } = {},
): Promise<string> {
  const record = await prisma.evidence.findUniqueOrThrow({
    where: { id: evidenceId },
    select: { id: true, teamId: true },
  });
  const minted = await prisma.$transaction((tx) =>
    mintVerificationShareTokenTx(tx, {
      evidenceId: record.id,
      teamId: record.teamId,
      purpose: "OWNER_SHARE",
      projection: opts.projection ?? "STANDARD",
      audience: "test recipient",
      ...(opts.allowOriginalDownload ? { allowOriginalDownload: true } : {}),
    }),
  );
  return minted.token;
}

const issued = new Map<string, string>();

/**
 * The share link for a record, created on first use and reused afterwards —
 * so a test that requests the same record several times holds ONE link, as a
 * recipient would.
 */
export async function shareLinkFor(prisma: Db, evidenceId: string): Promise<string> {
  let token = issued.get(evidenceId);
  if (!token) {
    token = await createReviewerShareLink(prisma, evidenceId);
    issued.set(evidenceId, token);
  }
  return token;
}
