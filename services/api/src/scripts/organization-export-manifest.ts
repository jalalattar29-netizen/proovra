/**
 * ORGANIZATION EXPORT MANIFEST — READ-ONLY (GOV-015).
 *
 * Writes the manifest of everything an organization holds to a local file, then
 * checks storage still holds those objects. It changes no row and no object. The
 * procedure around it is docs/operations/runbooks/32-organization-data-return.md.
 *
 *   pnpm --filter proovra-api ops:organization-export-manifest -- --organization=<id> --out=<file>
 */
import { writeFileSync } from "node:fs";

import { prisma } from "../db.js";
import {
  buildOrganizationExportManifest,
  checkManifestAgainstStorage,
} from "../services/organization/organization-export-manifest.service.js";
import { apiEvidenceDestructionStorage } from "../services/evidence/destruction-storage-port.js";

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

async function main() {
  const organizationId = arg("organization");
  const out = arg("out");
  if (!organizationId || !out) {
    throw new Error("usage: --organization=<id> --out=<file>");
  }
  const manifest = await buildOrganizationExportManifest({ organizationId }, prisma);
  writeFileSync(out, JSON.stringify(manifest, null, 2), "utf8");
  const check = await checkManifestAgainstStorage(manifest, apiEvidenceDestructionStorage);
  console.log(
    JSON.stringify({
      organizationId,
      manifestSha256: manifest.manifestSha256,
      recordCount: manifest.recordCount,
      objectCount: manifest.objectCount,
      byteCount: manifest.byteCount,
      heldRecordCount: manifest.heldRecordCount,
      destroyedRecordCount: manifest.destroyedRecordCount,
      checkedObjects: check.checkedObjects,
      missingObjects: check.missing.length,
    }),
  );
  await prisma.$disconnect();
  if (check.missing.length > 0) process.exitCode = 2;
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : String(err));
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
