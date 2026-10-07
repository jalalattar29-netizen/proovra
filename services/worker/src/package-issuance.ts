/**
 * PACKAGE ISSUANCE — reserve, publish and commit the verification-package
 * artifacts of one report-generation request (2026-10-07).
 *
 * One issuance issues one ROW PER DISCLOSURE PROFILE (FULL_FORENSIC,
 * EXTERNAL_DISCLOSURE), grouped by the request id. The canonical rules live in
 * @proovra/shared-runtime (reports/verification-package-artifacts); this module
 * is the worker's use of them:
 *
 *   1. RESERVE (claim-fenced, under the record's advisory lock) — BEFORE any
 *      byte is built. Every retry, redelivery or recovery of the same
 *      (evidence, version, profile) reuses the same row and package id.
 *   2. BUILD (caller) — each reserved profile, carrying its reserved id.
 *   3. PUBLISH — each ZIP to its own single-use immutable key, verified by
 *      VersionId. A crash here leaves an unreferenced object: the row is still
 *      RESERVED, so nothing claims it as a package.
 *   4. COMMIT (one transaction, claim-fenced) — every built row RESERVED ->
 *      PUBLISHED, only while still reserved by THIS issuance; the record's
 *      pointers; one custody event per published artifact; the request's
 *      PACKAGE_PUBLISHED stage.
 *   5. FAIL — a failed run marks its still-reserved rows FAILED (time and
 *      bounded reason); the next attempt re-reserves the same ids.
 */
import * as prismaPkg from "@prisma/client";
import type { Prisma } from "@prisma/client";
import {
  commitPublishedPackage,
  markPackageIssuanceFailed,
  owedProfiles,
  PRIMARY_PACKAGE_PROFILE_WHERE,
  publishedProfilePackageWhere,
  reservePackageIssuance,
  type ReservedPackage,
  type VerificationPackageProfile,
} from "@proovra/shared-runtime/reports";

import { appendCustodyEventTx } from "./custody-events.js";
import { prisma } from "./db.js";
import { env } from "./config.js";
import {
  buildPublicationKey,
  publishImmutableArtifact,
  type PublishedArtifact,
} from "./immutable-publication.js";
import { cleanupStagedTemp, type StagedPackage } from "./verification-package-staging.js";
import type { PackageSealResult } from "./verification-package.js";
import {
  claimFenceWhere,
  ReportClaimLost,
  type ResolvedReportCommand,
} from "./report-generation-authority.js";

export const PACKAGE_REPORT_BASELINE_CHANGED = "PACKAGE_REPORT_BASELINE_CHANGED";

/** Every artifact this issuance owed is already published (a concurrent run). */
export class PackageAlreadyCommittedError extends Error {
  constructor(readonly reportVersion: number) {
    super("VERIFICATION_PACKAGE_ALREADY_COMMITTED");
    this.name = "PackageAlreadyCommittedError";
  }
}

type Fence = Pick<ResolvedReportCommand, "requestId" | "claimedAtUtc">;

/**
 * RESERVE this request's package rows for one report version. Returns every
 * owed profile with its package id; only RESERVED ones are to be built.
 * Throws PackageAlreadyCommittedError when every owed profile is published.
 */
export async function reserveIssuanceForRun(input: {
  command: Fence;
  evidenceId: string;
  version: number;
  now: Date;
}): Promise<{ reportId: string; reserved: ReservedPackage[]; toBuild: ReservedPackage[] }> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.evidenceId}))`;
    const report = await tx.report.findUnique({
      where: { evidenceId_version: { evidenceId: input.evidenceId, version: input.version } },
      select: { id: true },
    });
    if (!report) throw Object.assign(new Error(PACKAGE_REPORT_BASELINE_CHANGED), { code: PACKAGE_REPORT_BASELINE_CHANGED, retriable: false });
    const primary = await tx.verificationPackage.findFirst({
      where: { AND: [{ evidenceId: input.evidenceId, version: input.version }, PRIMARY_PACKAGE_PROFILE_WHERE] },
      select: { disclosureProfile: true, state: true },
    });
    const reserved = await reservePackageIssuance(tx, {
      evidenceId: input.evidenceId,
      version: input.version,
      reportId: report.id,
      issuanceId: input.command.requestId,
      profiles: owedProfiles(primary),
      now: input.now,
    });
    // The reservation is this run's only while its claim stands.
    const fenced = await tx.reportGenerationRequest.updateMany({
      where: claimFenceWhere(input.command),
      data: { progressAtUtc: input.now },
    });
    if (fenced.count !== 1) throw new ReportClaimLost(input.command.requestId);
    const toBuild = reserved.filter((r) => r.state === "RESERVED");
    if (toBuild.length === 0) throw new PackageAlreadyCommittedError(input.version);
    return { reportId: report.id, reserved, toBuild };
  });
}

/** The previous PUBLISHED package of the same profile (what this one supersedes). */
export async function previousPublishedPackage(input: {
  evidenceId: string;
  version: number;
  profile: VerificationPackageProfile;
}): Promise<{ packageId: string; reportVersion: number } | null> {
  const row = await prisma.verificationPackage.findFirst({
    where: publishedProfilePackageWhere(input.profile, {
      evidenceId: input.evidenceId,
      version: { lt: input.version },
    }),
    orderBy: { version: "desc" },
    select: { id: true, version: true, reportVersion: true },
  });
  return row ? { packageId: row.id, reportVersion: row.reportVersion ?? row.version } : null;
}

export type BuiltProfile = {
  profile: VerificationPackageProfile;
  packageId: string;
  supersedesPackageId: string | null;
  staged: StagedPackage;
  seal: PackageSealResult | null;
};

export type PublishedProfile = BuiltProfile & { head: PublishedArtifact };

/**
 * PUBLISH each built profile to its own single-use immutable key. The key's
 * nonce is per attempt (an attempt never shares a key with another), and the
 * object's metadata names the package id it was built for.
 */
export async function publishBuiltProfiles(input: {
  built: readonly BuiltProfile[];
  evidenceId: string;
  version: number;
  requestId: string;
}): Promise<PublishedProfile[]> {
  const out: PublishedProfile[] = [];
  for (const b of input.built) {
    const head = await publishImmutableArtifact({
      bucket: env.S3_BUCKET,
      key: buildPublicationKey({
        family: "verification",
        evidenceId: input.evidenceId,
        version: input.version,
        requestId: input.requestId,
        extension: "zip",
      }),
      body: { kind: "file", filePath: b.staged.tempPath, sizeBytes: b.staged.sizeBytes },
      sha256Base64: b.staged.sha256Base64,
      contentType: "application/zip",
      metadata: {
        evidence_id: input.evidenceId,
        report_version: String(input.version),
        artifact_type:
          b.profile === "EXTERNAL_DISCLOSURE"
            ? "verification_package_external_disclosure"
            : "verification_package",
        package_id: b.packageId,
        disclosure_profile: b.profile,
        package_format_version: b.seal ? String(b.seal.packageFormatVersion) : "4",
      },
      tags: { artifact: "verification-package", evidenceId: input.evidenceId, immutable: "true" },
    });
    // The local temp is no longer the only copy — bound worker disk.
    await cleanupStagedTemp(b.staged);
    out.push({ ...b, head });
  }
  return out;
}

export type IssuanceCommitInput = {
  command: Fence;
  evidenceId: string;
  version: number;
  reportId: string;
  now: Date;
  /** The report digest this run verified; the committed report must still have it. */
  reportSha256: string;
  reportIssuedAtUtc: Date | null;
  custodyThroughSequence: number | null;
  trustDecisionSnapshot: Prisma.InputJsonValue;
  /** True when the report was rendered by this run (else a package recovery). */
  reportCreated: boolean;
  published: readonly PublishedProfile[];
  /** The primary package's presence flags, recorded on the record. */
  primaryArtifactPresence: Record<string, boolean> | null;
};

/**
 * COMMIT the issuance in one claim-fenced transaction under the record's
 * advisory lock: the report baseline is re-checked; each published row moves
 * RESERVED -> PUBLISHED only while still reserved by this issuance; the
 * record's pointers advance; one custody event per artifact; the request
 * records PACKAGE_PUBLISHED.
 */
export async function commitIssuance(input: IssuanceCommitInput): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.evidenceId}))`;
    const baseline = await tx.report.findUnique({
      where: { evidenceId_version: { evidenceId: input.evidenceId, version: input.version } },
      select: { id: true, pdfSha256: true },
    });
    if (
      !baseline ||
      baseline.id !== input.reportId ||
      (baseline.pdfSha256 && baseline.pdfSha256.toLowerCase() !== input.reportSha256.toLowerCase())
    ) {
      throw Object.assign(new Error(PACKAGE_REPORT_BASELINE_CHANGED), {
        code: PACKAGE_REPORT_BASELINE_CHANGED,
        retriable: false,
      });
    }

    for (const p of input.published) {
      await commitPublishedPackage(tx, {
        packageId: p.packageId,
        issuanceId: input.command.requestId,
        facts: {
          storageBucket: p.head.bucket,
          storageKey: p.head.key,
          storageRegion: process.env.S3_REGION?.trim() || null,
          storageObjectLockMode: p.head.objectLockMode,
          storageObjectLockRetainUntilUtc: p.head.objectLockRetainUntilUtc,
          storageObjectLockLegalHoldStatus: p.head.objectLockLegalHoldStatus,
          generatedAtUtc: input.now,
          completedAtUtc: new Date(),
          sizeBytes: BigInt(p.staged.sizeBytes),
          packageType:
            p.profile === "EXTERNAL_DISCLOSURE" ? "external_disclosure_package" : "full_evidence_package",
          trustDecisionSnapshot: input.trustDecisionSnapshot,
          reportVersion: input.version,
          reportId: input.reportId,
          // The full package embeds the report bytes; the external package
          // withholds them and commits to this digest instead.
          reportSha256: input.reportSha256,
          packageSha256: p.staged.sha256Hex,
          s3VersionId: p.head.versionId,
          packageFormatVersion: p.seal?.packageFormatVersion ?? null,
          sealSha256: p.seal?.sealSha256 ?? null,
          sealSigningKeySha256: p.seal?.signingKeyFingerprint ?? null,
          sealSigningKeyId: p.seal?.signingKeyId ?? null,
          sealSigningKeyVersion: p.seal?.signingKeyVersion ?? null,
          supersedesPackageId: p.supersedesPackageId,
          reportIssuedAtUtc: input.reportIssuedAtUtc,
          custodyThroughSequence: input.custodyThroughSequence,
        },
      });
    }

    const primary = input.published.find((p) => p.profile === "FULL_FORENSIC") ?? null;
    if (primary) {
      // The record's "latest package" pointer only ADVANCES (ET-SEC-29).
      await tx.evidence.updateMany({
        where: {
          id: input.evidenceId,
          OR: [
            { verificationPackageVersion: null },
            { verificationPackageVersion: { lte: input.version } },
          ],
        },
        data: {
          verificationPackageGeneratedAtUtc: input.now,
          verificationPackageVersion: input.version,
          verificationPackageMetadata: {
            ...(input.primaryArtifactPresence ?? {}),
            packageVersion: "v1",
            generatedAtUtc: input.now.toISOString(),
            source: "GENERATION",
          },
        },
      });
      await tx.report.updateMany({
        where: { evidenceId: input.evidenceId, version: input.version },
        data: { verificationPackageVersion: input.version },
      });
    }

    for (const p of input.published) {
      await appendCustodyEventTx(tx, {
        evidenceId: input.evidenceId,
        eventType: prismaPkg.CustodyEventType.VERIFICATION_PACKAGE_GENERATED,
        atUtc: input.now,
        payload: {
          version: input.version,
          packageId: p.packageId,
          disclosureProfile: p.profile,
          packageType:
            p.profile === "EXTERNAL_DISCLOSURE" ? "external_disclosure_package" : "full_evidence_package",
          reportVersion: input.version,
          reportSha256: input.reportSha256,
          packageSha256: p.staged.sha256Hex,
          ...(input.reportCreated ? {} : { recovery: true }),
        } as Prisma.InputJsonValue,
      });
    }

    const fencedPublish = await tx.reportGenerationRequest.updateMany({
      where: claimFenceWhere(input.command),
      data: { reportVersion: input.version, stage: "PACKAGE_PUBLISHED" },
    });
    if (fencedPublish.count !== 1) throw new ReportClaimLost(input.command.requestId);
  });
}

/** FAIL: this issuance's still-reserved rows record the failure. Best-effort. */
export async function failIssuance(input: { requestId: string; reason: string }): Promise<void> {
  try {
    await markPackageIssuanceFailed(prisma, {
      issuanceId: input.requestId,
      reason: input.reason,
      now: new Date(),
    });
  } catch {
    /* the reservation stays RESERVED; the next attempt re-reserves it */
  }
}
