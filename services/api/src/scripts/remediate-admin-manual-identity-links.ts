/**
 * PRO-A2-02 — OPERATOR CLI: classify legacy Organization identity links on
 * self-serve accounts by evidence (rules in
 * src/commands/remediate-admin-manual-identity-links.ts).
 *
 *   pnpm --filter proovra-api exec tsx src/scripts/remediate-admin-manual-identity-links.ts
 *   pnpm --filter proovra-api exec tsx src/scripts/remediate-admin-manual-identity-links.ts --apply
 *   (in the API image: node dist/scripts/remediate-admin-manual-identity-links.js [--apply])
 *
 * ROLLOUT ORDER: migration 20281121010000_external_identity_link_source FIRST,
 * then the API image, then this script (it reads and writes link_source).
 *
 * DRY RUN BY DEFAULT: without --apply it lists ids, classes and counts and
 * writes nothing.
 */
import { pathToFileURL } from "node:url";

import {
  formatLegacyIdentityLinkReport,
  remediateAdminManualIdentityLinks,
} from "../commands/remediate-admin-manual-identity-links.js";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const { prisma } = await import("../db.js");
  try {
    const report = await remediateAdminManualIdentityLinks(prisma, { apply });
    for (const line of formatLegacyIdentityLinkReport(report)) console.log(line);
    if (!apply && report.affected.length > 0) {
      console.log("DRY-RUN: nothing was written. Re-run with --apply to act on the evidence-classified links above.");
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
