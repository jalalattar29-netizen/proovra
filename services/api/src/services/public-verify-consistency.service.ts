import type { OtsAnchoring, OtsState, TrustDecision } from "@proovra/shared";
import { OTS_STATES } from "@proovra/shared";

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
  /**
   * The OTS state the latest report stated (its anchorSnapshot.otsState).
   * A legacy report without one, or no report, reads UNAVAILABLE.
   */
  otsStatusAtGeneration: OtsState;
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

/**
 * The record's live anchoring freshness (2026-10-13): operational fields only.
 * The OTS state itself (state, txid, block height, time) is stated once, by
 * `storageAndTimestamping.ots` (the shared OtsAnchoringView).
 */
export type PublicVerifyLiveAnchoringSection = {
  lastUpdatedAtUtc: string | null;
  hasAdvancedSinceSnapshot: boolean;
  newerReportAvailable: boolean;
  newerPackageAvailable: boolean;
  autoRefreshRecommended: boolean;
};

/**
 * The OTS state a report stated: its `anchorSnapshot.otsState`, written by the
 * worker. A legacy report without it (or no report) reads UNAVAILABLE — never
 * re-derived from a status word or a trust-signal reading.
 */
export function reportOtsStateOf(anchorSnapshot: unknown): OtsState {
  const raw =
    anchorSnapshot && typeof anchorSnapshot === "object" && !Array.isArray(anchorSnapshot)
      ? (anchorSnapshot as Record<string, unknown>).otsState
      : null;
  return typeof raw === "string" && (OTS_STATES as readonly string[]).includes(raw) ? (raw as OtsState) : "UNAVAILABLE";
}

/** Progress order: only a move toward ANCHORED is an advance. */
function rankOtsState(state: OtsState | null | undefined): number {
  switch (state) {
    case "ANCHORED":
      return 2;
    case "PENDING":
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

export function buildPublicVerifyConsistencySections(params: {
  source: PublicVerifySnapshotSource;
  trustDecisionSnapshot: TrustDecision | null;
  latestReport: {
    version: number;
    generatedAtUtc: Date;
    pdfSignatureStatus: string | null;
    pdfSignedAtUtc: Date | null;
    /** The report's anchor snapshot; its `otsState` is the state the report stated. */
    anchorSnapshot?: unknown;
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
  /** The record's live anchoring, resolved once by the caller (resolveRecordOtsAnchoring). */
  currentOts: OtsAnchoring;
  otsUpgradedAtUtc: string | null;
}): {
  verificationSnapshot: PublicVerifySnapshotSection;
  liveAnchoring: PublicVerifyLiveAnchoringSection;
} {
  const otsStatusAtGeneration = reportOtsStateOf(params.latestReport?.anchorSnapshot ?? null);

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

  const current = params.currentOts;
  const liveAnchoring: PublicVerifyLiveAnchoringSection = {
    lastUpdatedAtUtc:
      params.otsUpgradedAtUtc ?? (current.state === "ANCHORED" ? current.anchoredAtUtc : null) ?? null,
    hasAdvancedSinceSnapshot:
      params.latestReport != null && rankOtsState(current.state) > rankOtsState(otsStatusAtGeneration),
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
