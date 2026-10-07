/**
 * THE EXTERNAL REVIEWER'S VERIFICATION PACKAGE (2026-10-07).
 *
 * A reviewer outside the workspace receives the EXTERNAL_DISCLOSURE package
 * of the record's latest report version — every cryptographic commitment, no
 * original bytes, no report, no identifiers or infrastructure — and never the
 * FULL_FORENSIC package. Only for an EVIDENCE-scope grant that allows package
 * download, while the record still belongs to the grant's workspace and passes
 * export eligibility (legal hold, lifecycle, destruction review). Every release
 * is a custody event. The route only maps the outcome to HTTP.
 */
import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";
import { headObject, presignGetObject } from "../../storage.js";
import { appendCustodyEvent } from "../custody-events.service.js";
import { noteCustodyFailure } from "../custody-events-observability.js";
import { readExternalDisclosureArtifact } from "../reports/external-disclosure-artifact.js";
import type { ExternalReviewGrantRow } from "./external-review-grant.service.js";

export type ExternalReviewPackageOutcome =
  | {
      ok: true;
      packageId: string;
      reportVersion: number;
      packageSha256: string | null;
      downloadUrl: string;
    }
  | { ok: false; status: 401 | 403 | 404 | 410; code: string };

export async function releaseExternalDisclosurePackage(input: {
  grant: Pick<ExternalReviewGrantRow, "id" | "teamId" | "scopeKind" | "evidenceId" | "allowPackageDownload" | "invitedByUserId">;
  ip: string | null;
  userAgent: string | null;
}): Promise<ExternalReviewPackageOutcome> {
  const { grant } = input;
  if (grant.scopeKind !== "EVIDENCE" || !grant.evidenceId || !grant.allowPackageDownload) {
    return { ok: false, status: 403, code: "package_download_not_granted" };
  }
  const evidence = await prisma.evidence.findUnique({
    where: { id: grant.evidenceId },
    select: { id: true, teamId: true },
  });
  // A record that left the grant's workspace answers as an inactive grant.
  if (!evidence || evidence.teamId !== grant.teamId) {
    return { ok: false, status: 401, code: "grant_not_active" };
  }
  const { checkExportEligibility } = await import("../governance-lifecycle/export-governance.service.js");
  const eligibility = await checkExportEligibility({
    teamId: grant.teamId,
    evidenceId: evidence.id,
    actorUserId: grant.invitedByUserId,
  });
  if (eligibility.outcome !== "ALLOWED") {
    return { ok: false, status: 403, code: "export_not_eligible" };
  }
  const latestReport = await prisma.report.findFirst({
    where: { evidenceId: evidence.id },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const row = latestReport
    ? await prisma.verificationPackage.findFirst({
        where: { evidenceId: evidence.id, version: latestReport.version },
        select: { version: true, storageBucket: true, externalDisclosureArtifact: true },
      })
    : null;
  const ext = row ? readExternalDisclosureArtifact(row.externalDisclosureArtifact) : null;
  if (!row || !ext) return { ok: false, status: 404, code: "external_disclosure_not_issued" };
  try {
    const meta = await headObject({ bucket: row.storageBucket, key: ext.storageKey });
    if (!meta.sizeBytes || meta.sizeBytes <= 0) throw new Error("empty");
  } catch {
    return { ok: false, status: 410, code: "package_file_unavailable" };
  }
  await appendCustodyEvent({
    evidenceId: evidence.id,
    eventType: prismaPkg.CustodyEventType.VERIFICATION_PACKAGE_DOWNLOADED,
    payload: {
      version: row.version,
      packageId: ext.packageId,
      disclosureProfile: "EXTERNAL_DISCLOSURE",
      externalReviewGrantId: grant.id,
    },
    ip: input.ip ?? undefined,
    userAgent: input.userAgent ?? undefined,
  }).catch(noteCustodyFailure);
  const downloadUrl = await presignGetObject({
    bucket: row.storageBucket,
    key: ext.storageKey,
    versionId: ext.s3VersionId,
    expiresInSeconds: 600,
  });
  return { ok: true, packageId: ext.packageId, reportVersion: row.version, packageSha256: ext.packageSha256, downloadUrl };
}
