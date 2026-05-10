/**
 * Phase C #12 — Extracted artifact-status helper.
 *
 * Side-effect-free reader for "are the post-finalization artifacts ready?".
 * Does NOT touch any custody, audit, view, or download counters. Carries
 * the same contract as the previous inline implementation in
 * services/api/src/routes/evidence.routes.ts so behavior is identical;
 * the goal is to shrink the routes monolith without changing semantics.
 */
import * as prismaPkg from "@prisma/client";
import { prisma } from "../db.js";

export interface EvidenceArtifactStatus {
  evidenceId: string;
  status: prismaPkg.EvidenceStatus | null;
  finalized: boolean;
  report:
    | {
        available: true;
        version: number;
        generatedAtUtc: string;
        reviewerSummaryVersion: number | null;
        verificationPackageVersion: number | null;
        pending: false;
      }
    | {
        available: false;
        version: null;
        generatedAtUtc: null;
        reviewerSummaryVersion: null;
        verificationPackageVersion: null;
        pending: boolean;
      };
  verificationPackage:
    | {
        available: true;
        version: number;
        generatedAtUtc: string;
        packageType: string | null;
        pending: false;
      }
    | {
        available: false;
        version: null;
        generatedAtUtc: null;
        packageType: null;
        pending: boolean;
      };
}

export async function buildEvidenceArtifactStatus(params: {
  evidenceId: string;
  evidenceStatus: prismaPkg.EvidenceStatus | null;
}): Promise<EvidenceArtifactStatus> {
  const { evidenceId } = params;
  const [latestReport, latestPackage] = await Promise.all([
    prisma.report.findFirst({
      where: { evidenceId },
      orderBy: { version: "desc" },
      select: {
        version: true,
        generatedAtUtc: true,
        verificationPackageVersion: true,
        reviewerSummaryVersion: true,
      },
    }),
    prisma.verificationPackage.findFirst({
      where: { evidenceId },
      orderBy: { version: "desc" },
      select: {
        version: true,
        generatedAtUtc: true,
        packageType: true,
      },
    }),
  ]);

  const finalized =
    params.evidenceStatus === prismaPkg.EvidenceStatus.SIGNED ||
    params.evidenceStatus === prismaPkg.EvidenceStatus.REPORTED;

  const reportPending = finalized && !latestReport;
  const packagePending = finalized && !latestPackage;

  return {
    evidenceId,
    status: params.evidenceStatus,
    finalized,
    report: latestReport
      ? {
          available: true,
          version: latestReport.version,
          generatedAtUtc: latestReport.generatedAtUtc.toISOString(),
          reviewerSummaryVersion: latestReport.reviewerSummaryVersion ?? null,
          verificationPackageVersion:
            latestReport.verificationPackageVersion ?? null,
          pending: false,
        }
      : {
          available: false,
          version: null,
          generatedAtUtc: null,
          reviewerSummaryVersion: null,
          verificationPackageVersion: null,
          pending: reportPending,
        },
    verificationPackage: latestPackage
      ? {
          available: true,
          version: latestPackage.version,
          generatedAtUtc: latestPackage.generatedAtUtc.toISOString(),
          packageType: latestPackage.packageType ?? null,
          pending: false,
        }
      : {
          available: false,
          version: null,
          generatedAtUtc: null,
          packageType: null,
          pending: packagePending,
        },
  };
}
