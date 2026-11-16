/**
 * B5B-F-302 — OPERATOR CLI: release accounts a domain-only SCIM / SSO link
 * converted to managed identities. The rules live in
 * src/commands/remediate-domain-only-managed-links.ts.
 *
 *   pnpm --filter proovra-api ops:remediate-domain-only-managed-links
 *   pnpm --filter proovra-api ops:remediate-domain-only-managed-links --apply
 *   (in the API image: node dist/scripts/remediate-domain-only-managed-links.js [--apply])
 *
 * DRY RUN BY DEFAULT: without --apply it lists every affected account (ids,
 * sources and counts — no addresses, no names) and writes nothing. With
 * --apply, per account: release the Organization's managed binding, soft-unlink
 * its identity mappings, keep memberships, revoke sessions, audit. Idempotent.
 */
import { pathToFileURL } from "node:url";

import {
  formatDomainOnlyRemediationReport,
  remediateDomainOnlyManagedLinks,
} from "../commands/remediate-domain-only-managed-links.js";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const { prisma } = await import("../db.js");
  try {
    const report = await remediateDomainOnlyManagedLinks(prisma, { apply });
    for (const line of formatDomainOnlyRemediationReport(report)) console.log(line);
    if (!apply && report.affected.length > 0) {
      console.log("DRY-RUN: nothing was written. Re-run with --apply to remediate the accounts listed above.");
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
