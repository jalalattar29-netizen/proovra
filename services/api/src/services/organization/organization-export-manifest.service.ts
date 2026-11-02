/**
 * GOV-015 — WHAT AN ORGANIZATION HOLDS, FOR THE RETURN OF ITS DATA AT OFFBOARDING.
 *
 * DPA Appendix E lets a customer ask for its data back. Case exports only reach
 * records linked to a case, the account export excludes evidence, and termination
 * has no export step, so records outside a case had no way out and nothing could
 * prove a hand-over was complete.
 *
 * This is the read half: a manifest of every stored object of every record in every
 * workspace of the organization, with the digests a hand-over reconciles against,
 * and a check that storage still holds exactly those versions. It writes nothing.
 * The copy itself is an operator procedure, run under
 * docs/operations/runbooks/32-organization-data-return.md: there is no customer
 * facing export job yet.
 *
 * A record under legal hold is listed and flagged. Whether its bytes may leave is
 * undecided (GOV-012), so the manifest never decides that by leaving it out.
 */

import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import { canonicalJsonValue } from "@proovra/shared/custody-hash";
import {
  resolveWorkspaceLegalHoldCoverage,
  workspaceEvidenceWhere,
  type EvidenceDestructionStoragePort,
} from "@proovra/shared-runtime";

import { prisma as defaultPrisma } from "../../db.js";

export type ManifestObject = {
  kind: "ORIGINAL" | "PART" | "REPORT" | "PACKAGE";
  bucket: string;
  key: string;
  versionId: string | null;
  sha256: string | null;
  sizeBytes: string | null;
};

export type ManifestRecord = {
  evidenceId: string;
  workspaceId: string;
  lifecycleState: string;
  fingerprintHash: string | null;
  legalHold: boolean;
  objects: ManifestObject[];
};

export type OrganizationExportManifest = {
  manifestVersion: "PROOVRA_ORG_EXPORT_MANIFEST_V1";
  organizationId: string;
  workspaceIds: string[];
  generatedAtUtc: string;
  recordCount: number;
  objectCount: number;
  byteCount: string;
  heldRecordCount: number;
  /** Destroyed records have no bytes to return. Counted so the sum is explained. */
  destroyedRecordCount: number;
  records: ManifestRecord[];
  manifestSha256: string;
};

const PAGE_SIZE = 500;

export async function buildOrganizationExportManifest(
  input: { organizationId: string; now?: Date },
  client: PrismaClient = defaultPrisma,
): Promise<OrganizationExportManifest> {
  const teams = await client.team.findMany({
    where: { organizationId: input.organizationId },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const records: ManifestRecord[] = [];
  let destroyedRecordCount = 0;
  let byteCount = 0n;

  for (const team of teams) {
    const coverage = await resolveWorkspaceLegalHoldCoverage(client, team.id);
    const evidenceScope = await workspaceEvidenceWhere(team.id, client);
    let cursor: string | null = null;
    for (;;) {
      const page: Array<{
        id: string;
        lifecycleState: string;
        fingerprintHash: string | null;
        fileSha256: string | null;
        sizeBytes: bigint | null;
        storageBucket: string | null;
        storageKey: string | null;
        storageVersionId: string | null;
        destroyedAtUtc: Date | null;
      }> = await client.evidence.findMany({
        where: evidenceScope,
        orderBy: { id: "asc" },
        take: PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          lifecycleState: true,
          fingerprintHash: true,
          fileSha256: true,
          sizeBytes: true,
          storageBucket: true,
          storageKey: true,
          storageVersionId: true,
          destroyedAtUtc: true,
        },
      });
      if (page.length === 0) break;
      cursor = page[page.length - 1]?.id ?? null;
      const ids = page.map((p) => p.id);
      const [parts, reports, packages] = await Promise.all([
        client.evidencePart.findMany({
          where: { evidenceId: { in: ids } },
          orderBy: { partIndex: "asc" },
          select: {
            evidenceId: true,
            storageBucket: true,
            storageKey: true,
            storageVersionId: true,
            sha256: true,
            sizeBytes: true,
          },
        }),
        client.report.findMany({
          where: { evidenceId: { in: ids } },
          orderBy: { version: "asc" },
          select: { evidenceId: true, storageBucket: true, storageKey: true, pdfSha256: true, sizeBytes: true },
        }),
        client.verificationPackage.findMany({
          where: { evidenceId: { in: ids } },
          orderBy: { version: "asc" },
          select: {
            evidenceId: true,
            storageBucket: true,
            storageKey: true,
            packageSha256: true,
            sizeBytes: true,
          },
        }),
      ]);

      for (const row of page) {
        if (row.destroyedAtUtc !== null || row.lifecycleState === "DESTROYED") {
          destroyedRecordCount += 1;
          continue;
        }
        const objects: ManifestObject[] = [];
        const add = (object: ManifestObject, size: bigint | null) => {
          objects.push(object);
          byteCount += size ?? 0n;
        };
        if (row.storageBucket && row.storageKey) {
          add(
            {
              kind: "ORIGINAL",
              bucket: row.storageBucket,
              key: row.storageKey,
              versionId: row.storageVersionId,
              sha256: row.fileSha256,
              sizeBytes: row.sizeBytes?.toString() ?? null,
            },
            row.sizeBytes,
          );
        }
        for (const part of parts.filter((p) => p.evidenceId === row.id)) {
          add(
            {
              kind: "PART",
              bucket: part.storageBucket,
              key: part.storageKey,
              versionId: part.storageVersionId,
              sha256: part.sha256,
              sizeBytes: part.sizeBytes?.toString() ?? null,
            },
            part.sizeBytes,
          );
        }
        for (const report of reports.filter((r) => r.evidenceId === row.id)) {
          add(
            {
              kind: "REPORT",
              bucket: report.storageBucket,
              key: report.storageKey,
              versionId: null,
              sha256: report.pdfSha256 ?? null,
              sizeBytes: report.sizeBytes?.toString() ?? null,
            },
            report.sizeBytes,
          );
        }
        for (const pkg of packages.filter((p) => p.evidenceId === row.id)) {
          if (!pkg.storageBucket || !pkg.storageKey) continue;
          add(
            {
              kind: "PACKAGE",
              bucket: pkg.storageBucket,
              key: pkg.storageKey,
              versionId: null,
              sha256: pkg.packageSha256,
              sizeBytes: pkg.sizeBytes?.toString() ?? null,
            },
            pkg.sizeBytes,
          );
        }
        records.push({
          evidenceId: row.id,
          workspaceId: team.id,
          lifecycleState: row.lifecycleState,
          fingerprintHash: row.fingerprintHash,
          legalHold: coverage.wholeWorkspace || coverage.evidenceIds.has(row.id),
          objects,
        });
      }
      if (page.length < PAGE_SIZE) break;
    }
  }

  const body = {
    manifestVersion: "PROOVRA_ORG_EXPORT_MANIFEST_V1" as const,
    organizationId: input.organizationId,
    workspaceIds: teams.map((t) => t.id),
    generatedAtUtc: (input.now ?? new Date()).toISOString(),
    recordCount: records.length,
    objectCount: records.reduce((n, r) => n + r.objects.length, 0),
    byteCount: byteCount.toString(),
    heldRecordCount: records.filter((r) => r.legalHold).length,
    destroyedRecordCount,
    records,
  };
  return {
    ...body,
    manifestSha256: createHash("sha256").update(canonicalJsonValue(body), "utf8").digest("hex"),
  };
}

export type ManifestStorageCheck = {
  checkedObjects: number;
  missing: Array<{ evidenceId: string; key: string; reason: "NO_SUCH_OBJECT" | "NO_SUCH_VERSION" }>;
};

/** Does storage still hold what the manifest names? A listing failure throws. */
export async function checkManifestAgainstStorage(
  manifest: OrganizationExportManifest,
  storage: Pick<EvidenceDestructionStoragePort, "listObjectVersions">,
): Promise<ManifestStorageCheck> {
  const missing: ManifestStorageCheck["missing"] = [];
  let checkedObjects = 0;
  for (const record of manifest.records) {
    for (const object of record.objects) {
      checkedObjects += 1;
      const versions = (await storage.listObjectVersions({ bucket: object.bucket, key: object.key })).filter(
        (v) => !v.isDeleteMarker,
      );
      if (versions.length === 0) {
        missing.push({ evidenceId: record.evidenceId, key: object.key, reason: "NO_SUCH_OBJECT" });
      } else if (object.versionId && !versions.some((v) => v.versionId === object.versionId)) {
        missing.push({ evidenceId: record.evidenceId, key: object.key, reason: "NO_SUCH_VERSION" });
      }
    }
  }
  return { checkedObjects, missing };
}
