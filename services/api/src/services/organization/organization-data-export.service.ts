/**
 * GOV-015 — THE CUSTOMER-FACING ORGANIZATION EXPORT FOR OFFBOARDING.
 *
 * DPA Appendix E lets a customer ask for its data back. Until now the return was
 * an operator procedure (docs/operations/runbooks/32-organization-data-return.md)
 * over `buildOrganizationExportManifest`. This is the same machinery as a job the
 * organization OWNER runs, built the way the personal account export is
 * (identity/account-data-export.service.ts): one active request, built by the
 * lifecycle tick under an atomic claim, step-up on request and download, a
 * bounded lifetime after which the manifest is removed (the request row and its
 * audit trail remain).
 *
 * What the owner receives:
 *   - the manifest: every stored object of every record in every workspace of
 *     the organization (key, sealed version, SHA-256, size), its manifestSha256,
 *     and the storage check (objects storage no longer holds are counted);
 *   - short-lived download links, a page at a time, each bound to the exact
 *     sealed version, so the copy reconciles to the sealed bytes.
 *
 * GOV-012: a record under legal hold is always listed and flagged. Under the
 * default (BLOCK) its bytes are withheld: it appears in `withheldByLegalHold`
 * and gets no link. Only when its workspace owner opted in
 * (ALLOW_AUTHENTICATED_RECORDED) are its links issued. Every record whose links
 * are issued gets a custody event, so the chain shows what left and to whom.
 */
import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import { canonicalJsonValue } from "@proovra/shared/custody-hash";

import { prisma as defaultPrisma } from "../../db.js";
import { presignGetObject } from "../../storage.js";
import { emitPlatformAudit } from "../audit/tenant-audit.service.js";
import { apiEvidenceDestructionStorage } from "../evidence/destruction-storage-port.js";
import { recordOriginalRelease } from "../evidence/artifact-download-gate.service.js";
import {
  buildOrganizationExportManifest,
  checkManifestAgainstStorage,
  type ManifestStorageCheck,
  type OrganizationExportManifest,
} from "./organization-export-manifest.service.js";

/** The manifest and its links stay available this long after the build. */
export const ORG_EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Download links are short-lived; the owner pages through them. */
export const ORG_EXPORT_LINK_TTL_SECONDS = 15 * 60;
export const ORG_EXPORT_LINK_PAGE = 100;
const PROCESS_BATCH = 2;

export type OrganizationExportPackage = {
  schema: "PROOVRA_ORG_DATA_EXPORT_V1";
  manifest: OrganizationExportManifest;
  storageCheck: ManifestStorageCheck;
  /**
   * GOV-012 — records under legal hold whose workspace keeps the default
   * (BLOCK): listed here, with no download links. Not dropped: the owner sees
   * what was withheld and why.
   */
  withheldByLegalHold: Array<{ evidenceId: string; workspaceId: string; reason: "WITHHELD_BY_LEGAL_HOLD" }>;
};

/** Workspaces whose owner opted in to releasing held records (GOV-012). */
async function workspacesReleasingHeldRecords(client: PrismaClient, workspaceIds: string[]): Promise<Set<string>> {
  if (workspaceIds.length === 0) return new Set();
  const rows = await client.workspaceGovernancePolicy.findMany({
    where: { teamId: { in: [...new Set(workspaceIds)] }, legalHoldDisclosure: "ALLOW_AUTHENTICATED_RECORDED" },
    select: { teamId: true },
  });
  return new Set(rows.map((r) => r.teamId));
}

async function withheldRecords(client: PrismaClient, manifest: OrganizationExportManifest) {
  const held = manifest.records.filter((r) => r.legalHold);
  const releasing = await workspacesReleasingHeldRecords(client, held.map((r) => r.workspaceId));
  return held
    .filter((r) => !releasing.has(r.workspaceId))
    .map((r) => ({ evidenceId: r.evidenceId, workspaceId: r.workspaceId, reason: "WITHHELD_BY_LEGAL_HOLD" as const }));
}

type StoragePort = Parameters<typeof checkManifestAgainstStorage>[1];

/** Build the manifest, check it against storage, and return the package JSON. */
export async function buildOrganizationExportPackage(
  organizationId: string,
  deps: { client?: PrismaClient; storage?: StoragePort } = {},
): Promise<{ json: string; sha256: string; pkg: OrganizationExportPackage }> {
  const client = deps.client ?? defaultPrisma;
  const manifest = await buildOrganizationExportManifest({ organizationId }, client);
  const storageCheck = await checkManifestAgainstStorage(manifest, deps.storage ?? apiEvidenceDestructionStorage);
  const pkg: OrganizationExportPackage = {
    schema: "PROOVRA_ORG_DATA_EXPORT_V1",
    manifest,
    storageCheck,
    withheldByLegalHold: await withheldRecords(client, manifest),
  };
  const json = JSON.stringify(pkg);
  return { json, sha256: createHash("sha256").update(canonicalJsonValue(pkg), "utf8").digest("hex"), pkg };
}

/**
 * Lifecycle-tick processor: expire stale packages, then build pending
 * requests. The REQUESTED → PROCESSING flip is a guarded update, so two ticks
 * never build the same request.
 */
export async function processOrganizationDataExports(
  now: Date,
  deps: { client?: PrismaClient; storage?: StoragePort } = {},
): Promise<{ generated: number; failed: number; expired: number }> {
  const client = deps.client ?? defaultPrisma;
  const summary = { generated: 0, failed: 0, expired: 0 };
  const expired = await client.organizationDataExportRequest.updateMany({
    where: { status: "READY", expiresAtUtc: { lt: now } },
    data: { status: "EXPIRED", manifestJson: null },
  });
  summary.expired = expired.count;

  const pending = await client.organizationDataExportRequest.findMany({
    where: { status: "REQUESTED" },
    select: { id: true, organizationId: true, requestedByUserId: true },
    orderBy: { requestedAtUtc: "asc" },
    take: PROCESS_BATCH,
  });
  for (const req of pending) {
    const claimed = await client.organizationDataExportRequest.updateMany({
      where: { id: req.id, status: "REQUESTED" },
      data: { status: "PROCESSING", startedAtUtc: now },
    });
    if (claimed.count === 0) continue;
    try {
      const { json, sha256, pkg } = await buildOrganizationExportPackage(req.organizationId, deps);
      await client.organizationDataExportRequest.update({
        where: { id: req.id },
        data: {
          status: "READY",
          completedAtUtc: new Date(),
          expiresAtUtc: new Date(Date.now() + ORG_EXPORT_TTL_MS),
          manifestJson: json,
          manifestSha256: sha256,
          recordCount: pkg.manifest.recordCount,
          objectCount: pkg.manifest.objectCount,
          heldRecordCount: pkg.manifest.heldRecordCount,
          missingObjectCount: pkg.storageCheck.missing.length,
        },
      });
      summary.generated += 1;
      await emitPlatformAudit({
        action: "organization.data_export_ready",
        outcome: "success",
        sourceApp: "API",
        actorUserId: req.requestedByUserId,
        serviceActor: "organization_data_export_tick",
        resourceType: "organization_data_export_request",
        resourceId: req.id,
        metadata: { organizationId: req.organizationId, sha256, missingObjects: pkg.storageCheck.missing.length },
      }).catch(() => null);
    } catch {
      await client.organizationDataExportRequest
        .update({ where: { id: req.id }, data: { status: "FAILED", failureCode: "generation_failed" } })
        .catch(() => null);
      summary.failed += 1;
    }
  }
  return summary;
}

export type OrgExportLink = {
  evidenceId: string;
  kind: string;
  key: string;
  versionId: string | null;
  sha256: string | null;
  sizeBytes: string | null;
  url: string;
};

/**
 * One page of download links for a READY export. Each link names the sealed
 * version. Every record on the page gets a custody event (DOWNLOAD_AUTHORIZED,
 * channel `original`), so a held record's release is on its chain too.
 */
export async function issueOrganizationExportLinks(input: {
  manifest: OrganizationExportManifest;
  exportId: string;
  actorUserId: string;
  offset: number;
  limit?: number;
  client?: PrismaClient;
}): Promise<{
  links: OrgExportLink[];
  nextOffset: number | null;
  total: number;
  withheldByLegalHold: OrganizationExportPackage["withheldByLegalHold"];
}> {
  // GOV-012 — decided NOW, not at build time: a hold placed or a setting
  // changed since the manifest was built is honoured.
  const withheld = await withheldRecords(input.client ?? defaultPrisma, input.manifest);
  const withheldIds = new Set(withheld.map((w) => w.evidenceId));
  const flat = input.manifest.records
    .filter((r) => !withheldIds.has(r.evidenceId))
    .flatMap((r) => r.objects.map((o) => ({ evidenceId: r.evidenceId, object: o })));
  const limit = Math.max(1, Math.min(input.limit ?? ORG_EXPORT_LINK_PAGE, ORG_EXPORT_LINK_PAGE));
  const page = flat.slice(input.offset, input.offset + limit);
  const links: OrgExportLink[] = [];
  const perRecord = new Map<string, number>();
  for (const { evidenceId, object } of page) {
    const url = await presignGetObject({
      bucket: object.bucket,
      key: object.key,
      versionId: object.versionId,
      expiresInSeconds: ORG_EXPORT_LINK_TTL_SECONDS,
      responseContentDisposition: "attachment",
    });
    links.push({ evidenceId, kind: object.kind, key: object.key, versionId: object.versionId, sha256: object.sha256, sizeBytes: object.sizeBytes, url: String(url) });
    perRecord.set(evidenceId, (perRecord.get(evidenceId) ?? 0) + 1);
  }
  for (const [evidenceId, count] of perRecord) {
    await recordOriginalRelease({ evidenceId, actorUserId: input.actorUserId, channel: "original", originalUrlsIssued: count });
  }
  const next = input.offset + page.length;
  return { links, nextOffset: next < flat.length ? next : null, total: flat.length, withheldByLegalHold: withheld };
}
