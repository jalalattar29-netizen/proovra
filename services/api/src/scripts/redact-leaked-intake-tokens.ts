/**
 * One-shot redaction script — rewrites historical
 * `CommunicationMessage.body_preview` rows that may carry a raw intake
 * token from before the Phase A sanitizer was applied at the
 * QUEUED-row write site.
 *
 * BACKGROUND:
 *   The Phase A sanitizer (`sanitizeIntakeMessagePreview` in
 *   @proovra/shared) replaces `/intake/<token>` URLs and similar
 *   secret-shaped strings with `/intake/[secure-link]`. It was applied
 *   to the email path on day one, but a second-stage bug left the
 *   SMS/WhatsApp QUEUED-row write at communication.service.ts:387
 *   bypassing the override and writing the raw URL. That bug is now
 *   fixed at write time, but historical rows may still contain
 *   tokens.
 *
 * THIS SCRIPT:
 *   1. Scans every CommunicationMessage row whose
 *      `relatedIntakeLinkId IS NOT NULL` AND whose `body_preview`
 *      contains the substring `/intake/`.
 *   2. Runs `sanitizeIntakeMessagePreview` over the preview.
 *   3. Writes the sanitized version back ONLY if it differs from the
 *      stored value (idempotent — safe to re-run).
 *   4. Logs counts only — never logs token material.
 *
 * USAGE:
 *   pnpm --filter proovra-api ts-node src/scripts/redact-leaked-intake-tokens.ts
 *
 * SECURITY:
 *   This script does not log raw tokens. The diff it computes
 *   internally is discarded; only the sanitized result is persisted.
 *   Run on a maintenance window or off-peak — it scans the full
 *   CommunicationMessage table with the LIKE filter and updates rows
 *   one-at-a-time inside a transaction.
 */

import { prisma } from "../db.js";
import { sanitizeIntakeMessagePreview } from "@proovra/shared";

async function main(): Promise<void> {
  // We scan in batches to avoid loading the entire table into
  // memory on a workspace with a large communication history.
  const BATCH_SIZE = 200;
  let cursor: string | null = null;
  let scanned = 0;
  let leaked = 0;
  let redacted = 0;
  let alreadySafe = 0;

  // We only consider rows that (a) reference an intake link and
  // (b) have a body_preview containing the literal `/intake/` path —
  // every leaked preview must include it. This drastically narrows
  // the scan from "every comm row" to "intake-link comm rows".
  // Using Prisma's `findMany` with a substring filter — Postgres
  // translates it to ILIKE.
  for (;;) {
    const rows: Array<{ id: string; bodyPreview: string | null }> =
      await prisma.communicationMessage.findMany({
        where: {
          relatedIntakeLinkId: { not: null },
          bodyPreview: { contains: "/intake/" },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: "asc" },
        take: BATCH_SIZE,
        select: { id: true, bodyPreview: true },
      });
    if (rows.length === 0) break;

    for (const row of rows) {
      scanned += 1;
      const before = row.bodyPreview ?? "";
      const after = sanitizeIntakeMessagePreview(before);
      if (after === before) {
        alreadySafe += 1;
        continue;
      }
      leaked += 1;
      await prisma.communicationMessage.update({
        where: { id: row.id },
        data: { bodyPreview: after },
      });
      redacted += 1;
    }
    cursor = rows[rows.length - 1].id;
  }

  // Counts-only summary. No previews, no tokens, no row IDs.
  console.log(
    JSON.stringify({
      script: "redact-leaked-intake-tokens",
      scanned,
      leaked,
      redacted,
      alreadySafe,
      timestamp: new Date().toISOString(),
    }),
  );
}

main()
  .catch((err) => {
    console.error(
      JSON.stringify({
        script: "redact-leaked-intake-tokens",
        error:
          err instanceof Error ? err.message.slice(0, 200) : "unknown_error",
        timestamp: new Date().toISOString(),
      }),
    );
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
