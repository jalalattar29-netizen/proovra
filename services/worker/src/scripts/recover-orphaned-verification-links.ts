/**
 * Recover REPORT verification links that immutable reports printed but whose
 * token rows were never stored (see verification-link-recovery.ts).
 *
 *   node dist/scripts/recover-orphaned-verification-links.js            # dry run (default)
 *   node dist/scripts/recover-orphaned-verification-links.js --apply    # write
 *
 * Reads only PROOVRA's own stored report objects; prints counts and a bounded
 * review list (record id prefix + report version). Never prints a token or a
 * hash. Exit 4 when any recovery failed.
 */
import { prisma } from "../db.js";
import { getObjectStream } from "../storage.js";
import {
  DEFAULT_REPORT_VERIFY_BASE_URL,
  recoverOrphanedReportLinks,
  redactVerificationTokens,
} from "../verification-link-recovery.js";

async function readObject(bucket: string, key: string): Promise<Buffer> {
  const body = (await getObjectStream({ bucket, key, versionId: null })) as AsyncIterable<Uint8Array>;
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

async function main(): Promise<number> {
  const apply = process.argv.slice(2).includes("--apply");
  const summary = await recoverOrphanedReportLinks({
    prisma,
    readObject,
    apply,
    verifyBaseUrl: process.env.REPORT_VERIFY_BASE_URL?.trim() || DEFAULT_REPORT_VERIFY_BASE_URL,
  });
  console.log(`[verification-link-recovery] SUMMARY ${redactVerificationTokens(JSON.stringify(summary))}`);
  return summary.failed > 0 ? 4 : 0;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(redactVerificationTokens(err instanceof Error ? (err.stack ?? err.message) : String(err)));
    await prisma.$disconnect();
    process.exit(1);
  });
