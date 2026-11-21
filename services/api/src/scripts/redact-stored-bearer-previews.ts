// Configuration is loaded EXPLICITLY (PHASE 12 POINT 7), never by side effect.
import "../src/env.js";

/**
 * PRO-N1-06 / PRO-I1Z-01 — one-off redaction of bearer links already stored in
 * message PREVIEWS.
 *
 *   Dry run (default — read-only; prints COUNTS only):
 *     pnpm --filter proovra-api exec tsx scripts/redact-stored-bearer-previews.ts
 *   Apply:
 *     pnpm --filter proovra-api exec tsx scripts/redact-stored-bearer-previews.ts --apply
 *
 * SCOPE
 *   - notification_deliveries.rendered_preview containing "/intake/" or "token="
 *     (evidence-request and intake-link mail stored "Secure upload link: <url>").
 *   - communication_messages.body_preview containing "/intake/" (evidence-request
 *     send and request-more SMS stored the full body), for EVERY row — the
 *     existing src/scripts/redact-leaked-intake-tokens.ts only covers rows tagged
 *     with relatedIntakeLinkId. A redacted SMS row is also marked
 *     body_resendable = false: its preview is no longer the message.
 *
 * NOT TOUCHED: notification_deliveries.template_context_json (server-private;
 * reminders and resends re-render from it), any provider-side copy, any
 * already-delivered message.
 *
 * RULES: idempotent (the sanitizer is idempotent; unchanged rows are skipped);
 * compare-and-swap on the value read; counts only — no preview, token or row
 * content is printed. ROLLBACK: not reversible by design (the removed value is a
 * live credential); a pre-run backup is the only way back.
 */

import { sanitizeIntakeMessagePreview } from "@proovra/shared";

import { prisma } from "../src/db.js";

const APPLY = process.argv.includes("--apply");
const BATCH = 200;

async function deliveries() {
  const t = { scanned: 0, wouldRedact: 0, redacted: 0, changedMeanwhile: 0 };
  let cursor: string | null = null;
  for (;;) {
    const rows: Array<{ id: string; renderedPreview: string | null }> = await prisma.notificationDelivery.findMany({
      where: {
        OR: [{ renderedPreview: { contains: "/intake/" } }, { renderedPreview: { contains: "token=" } }],
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: BATCH,
      select: { id: true, renderedPreview: true },
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      t.scanned++;
      const before = row.renderedPreview ?? "";
      const after = sanitizeIntakeMessagePreview(before).slice(0, 2000);
      if (after === before) continue;
      if (!APPLY) { t.wouldRedact++; continue; }
      const r = await prisma.notificationDelivery.updateMany({ where: { id: row.id, renderedPreview: before }, data: { renderedPreview: after } });
      if (r.count === 1) t.redacted++;
      else t.changedMeanwhile++;
    }
    cursor = rows[rows.length - 1]!.id;
  }
  return t;
}

async function messages() {
  const t = { scanned: 0, wouldRedact: 0, redacted: 0, changedMeanwhile: 0 };
  let cursor: string | null = null;
  for (;;) {
    const rows: Array<{ id: string; bodyPreview: string | null }> = await prisma.communicationMessage.findMany({
      where: { bodyPreview: { contains: "/intake/" }, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: "asc" },
      take: BATCH,
      select: { id: true, bodyPreview: true },
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      t.scanned++;
      const before = row.bodyPreview ?? "";
      const after = sanitizeIntakeMessagePreview(before).slice(0, 400);
      if (after === before) continue;
      if (!APPLY) { t.wouldRedact++; continue; }
      const r = await prisma.communicationMessage.updateMany({
        where: { id: row.id, bodyPreview: before },
        data: { bodyPreview: after, bodyResendable: false },
      });
      if (r.count === 1) t.redacted++;
      else t.changedMeanwhile++;
    }
    cursor = rows[rows.length - 1]!.id;
  }
  return t;
}

async function main(): Promise<void> {
  const result = { mode: APPLY ? "apply" : "dry-run", notificationDeliveries: await deliveries(), communicationMessages: await messages() };
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message.slice(0, 200) : "redact_failed");
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
