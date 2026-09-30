/**
 * Test helper — make a record publicly verifiable the way an owner does
 * (ET-PKG-07): publish it and mint a share link through the verification-share
 * authority. Returns the token; `/public/verify/<token>` opens the record.
 *
 * A record's id is not a public link, so a test that used to request
 * `/public/verify/<id>` of a row it had just created now asks for a link.
 */
import { mintVerificationShareTokenTx, type VerificationShareProjection } from "@proovra/shared-runtime";

type Db = (typeof import("../../src/db.js"))["prisma"];

export async function publishWithShareLink(
  prisma: Db,
  evidenceId: string,
  opts: { projection?: VerificationShareProjection; publish?: boolean } = {},
): Promise<string> {
  const record = await prisma.evidence.findUniqueOrThrow({
    where: { id: evidenceId },
    select: { id: true, teamId: true },
  });
  if (opts.publish !== false) {
    await prisma.evidence.update({ where: { id: evidenceId }, data: { publicVerifyState: "PUBLISHED" } });
  }
  const minted = await prisma.$transaction((tx) =>
    mintVerificationShareTokenTx(tx, {
      evidenceId: record.id,
      teamId: record.teamId,
      purpose: "OWNER_SHARE",
      projection: opts.projection ?? "STANDARD",
      audience: "test recipient",
    }),
  );
  return minted.token;
}

const issued = new Map<string, string>();

/**
 * The share link for a record, created (and the record published) on first
 * use and reused afterwards — so a test that requests the same record several
 * times holds ONE link, as a recipient would.
 */
export async function shareLinkFor(prisma: Db, evidenceId: string): Promise<string> {
  let token = issued.get(evidenceId);
  if (!token) {
    token = await publishWithShareLink(prisma, evidenceId);
    issued.set(evidenceId, token);
  }
  return token;
}
