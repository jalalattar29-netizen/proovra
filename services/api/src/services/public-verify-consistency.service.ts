import type { TrustDecision } from "@proovra/shared";

export type PublicVerifySnapshotSource =
  | "REPORT_SNAPSHOT"
  | "VERIFICATION_PACKAGE_SNAPSHOT"
  | "LIVE_SHARED_FALLBACK"
  | "UNAVAILABLE";

export type PublicVerifySnapshotSection = {
  source: PublicVerifySnapshotSource;
  generatedAtUtc: string | null;
  reportVersion: number | null;
  packageVersion: number | null;
  trustDecisionSnapshot: TrustDecision | null;
  otsStatusAtGeneration: string | null;
  reportSignature: {
    status: string | null;
    signedAtUtc: string | null;
  } | null;
  verificationPackageSignature: {
    manifestPresent: boolean;
    manifestSigned: boolean;
    packageType: string | null;
  } | null;
};

export type PublicVerifyLiveAnchoringSection = {
  currentOtsStatus: string | null;
  otsAnchoredAtUtc: string | null;
  otsBitcoinTxid: string | null;
  lastUpdatedAtUtc: string | null;
  hasAdvancedSinceSnapshot: boolean;
  newerReportAvailable: boolean;
  newerPackageAvailable: boolean;
  autoRefreshRecommended: boolean;
};

function mapSignalStatusToOtsStatus(status: string | null | undefined): string | null {
  const normalized = typeof status === "string" ? status.trim().toLowerCase() : "";

  switch (normalized) {
    case "passed":
      return "ANCHORED";
    case "partial":
    case "pending":
      return "PENDING";
    case "failed":
      return "FAILED";
    default:
      return null;
  }
}

function rankOtsStatus(status: string | null | undefined): number {
  const normalized = typeof status === "string" ? status.trim().toUpperCase() : "";

  switch (normalized) {
    case "ANCHORED":
      return 3;
    case "PENDING":
      return 2;
    case "FAILED":
      return 1;
    default:
      return 0;
  }
}

function isLaterThan(
  left: Date | null | undefined,
  rightIso: string | null | undefined,
): boolean {
  if (!left || !rightIso) return false;
  const right = new Date(rightIso);
  if (Number.isNaN(right.getTime())) return false;
  return left.getTime() > right.getTime();
}

export function deriveSnapshotOtsStatus(
  trustDecisionSnapshot: TrustDecision | null,
): string | null {
  const publicAnchoringSignal = trustDecisionSnapshot?.signals?.find(
    (signal) => signal.key === "bitcoin_anchoring",
  );

  return mapSignalStatusToOtsStatus(publicAnchoringSignal?.status);
}

export function buildPublicVerifyConsistencySections(params: {
  source: PublicVerifySnapshotSource;
  trustDecisionSnapshot: TrustDecision | null;
  latestReport: {
    version: number;
    generatedAtUtc: Date;
    pdfSignatureStatus: string | null;
    pdfSignedAtUtc: Date | null;
  } | null;
  latestVerificationPackage: {
    version: number;
    generatedAtUtc: Date;
    packageType: string | null;
  } | null;
  verificationPackageIntegrity: {
    manifestPresent: boolean;
    signedManifestPresent: boolean;
    packageType: string | null;
  } | null;
  currentOtsStatus: string | null;
  otsAnchoredAtUtc: string | null;
  otsBitcoinTxid: string | null;
  otsUpgradedAtUtc: string | null;
}): {
  verificationSnapshot: PublicVerifySnapshotSection;
  liveAnchoring: PublicVerifyLiveAnchoringSection;
} {
  const otsStatusAtGeneration = deriveSnapshotOtsStatus(
    params.trustDecisionSnapshot,
  );

  const generatedAtUtc =
    params.source === "REPORT_SNAPSHOT"
      ? params.latestReport?.generatedAtUtc.toISOString() ?? null
      : params.source === "VERIFICATION_PACKAGE_SNAPSHOT"
        ? params.latestVerificationPackage?.generatedAtUtc.toISOString() ?? null
        : null;

  const verificationSnapshot: PublicVerifySnapshotSection = {
    source: params.source,
    generatedAtUtc,
    reportVersion: params.latestReport?.version ?? null,
    packageVersion: params.latestVerificationPackage?.version ?? null,
    trustDecisionSnapshot: params.trustDecisionSnapshot,
    otsStatusAtGeneration,
    reportSignature: params.latestReport
      ? {
          status: params.latestReport.pdfSignatureStatus ?? "SIGNING_UNAVAILABLE",
          signedAtUtc: params.latestReport.pdfSignedAtUtc
            ? params.latestReport.pdfSignedAtUtc.toISOString()
            : null,
        }
      : null,
    verificationPackageSignature: params.latestVerificationPackage
      ? {
          manifestPresent:
            params.verificationPackageIntegrity?.manifestPresent === true,
          manifestSigned:
            params.verificationPackageIntegrity?.signedManifestPresent === true,
          packageType:
            params.latestVerificationPackage.packageType ??
            params.verificationPackageIntegrity?.packageType ??
            null,
        }
      : null,
  };

  const liveAnchoring: PublicVerifyLiveAnchoringSection = {
    currentOtsStatus: params.currentOtsStatus,
    otsAnchoredAtUtc: params.otsAnchoredAtUtc,
    otsBitcoinTxid: params.otsBitcoinTxid,
    lastUpdatedAtUtc: params.otsUpgradedAtUtc ?? params.otsAnchoredAtUtc ?? null,
    hasAdvancedSinceSnapshot:
      rankOtsStatus(params.currentOtsStatus) > rankOtsStatus(otsStatusAtGeneration),
    newerReportAvailable: isLaterThan(
      params.latestReport?.generatedAtUtc ?? null,
      generatedAtUtc,
    ),
    newerPackageAvailable: isLaterThan(
      params.latestVerificationPackage?.generatedAtUtc ?? null,
      generatedAtUtc,
    ),
    autoRefreshRecommended: false,
  };

  return {
    verificationSnapshot,
    liveAnchoring,
  };
}
