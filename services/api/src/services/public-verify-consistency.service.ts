import type { OtsAdvanceSinceIssue, OtsAnchoring, OtsState, OtsVerificationKey, TrustDecision } from "@proovra/shared";
import { otsAdvanceSinceIssue, snapshotAnchoringAtIssue } from "@proovra/shared";

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
   * The OTS state the latest report stated at issue: its anchorSnapshot.otsState;
   * for a report issued before otsState was recorded, the report's own Bitcoin
   * signal (snapshotAnchoringAtIssue). UNAVAILABLE only when neither exists.
   */
  otsStatusAtGeneration: OtsState;
  /** The OTS verification the report stated at issue (ATTESTATION_RECORDED for a legacy anchored report). */
  otsVerificationAtGeneration: OtsVerificationKey;
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
  /**
   * HOW anchoring advanced since the report was issued; NONE when the report
   * already stated what is true now (an attestation recorded before issue did
   * not "advance" since).
   */
  advance: OtsAdvanceSinceIssue | null;
  /**
   * AUD-48 (2026-10-20) — a report / package NEWER than the one this page was
   * opened for: the report version the link was issued for (a REPORT or
   * PACKAGE link), or the snapshot the page states. (autoRefreshRecommended
   * was always false and fed a poller that could never run; it is retired.)
   */
  newerReportAvailable: boolean;
  newerPackageAvailable: boolean;
};

/**
 * The OTS state a report stated at issue — from the report's OWN snapshot
 * (snapshotAnchoringAtIssue): its recorded otsState, else its Bitcoin signal,
 * else its stored status word. Never the record's current state.
 */
export function reportOtsStateOf(anchorSnapshot: unknown, trustDecisionSnapshot: unknown = null): OtsState {
  return snapshotAnchoringAtIssue(anchorSnapshot, trustDecisionSnapshot).otsState;
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
    /** The report's own trust snapshot (its Bitcoin signal, for a legacy report). */
    trustDecisionSnapshot?: unknown;
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
  /** AUD-48 — the report version a REPORT / PACKAGE link was issued for; null otherwise. */
  linkReportVersion?: number | null;
  /** AUD-48 — the report version the latest published package certifies. */
  latestPackageReportVersion?: number | null;
  otsUpgradedAtUtc: string | null;
}): {
  verificationSnapshot: PublicVerifySnapshotSection;
  liveAnchoring: PublicVerifyLiveAnchoringSection;
} {
  const atIssue = params.latestReport
    ? snapshotAnchoringAtIssue(params.latestReport.anchorSnapshot ?? null, params.latestReport.trustDecisionSnapshot ?? null)
    : { otsState: "UNAVAILABLE" as OtsState, otsVerification: "UNAVAILABLE" as OtsVerificationKey };
  const otsStatusAtGeneration = atIssue.otsState;

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
    otsVerificationAtGeneration: atIssue.otsVerification,
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
      params.latestReport != null && otsAdvanceSinceIssue(atIssue.otsVerification, current.verification) !== "NONE",
    advance: params.latestReport ? otsAdvanceSinceIssue(atIssue.otsVerification, current.verification) : null,
    newerReportAvailable:
      params.linkReportVersion != null
        ? (params.latestReport?.version ?? 0) > params.linkReportVersion
        : isLaterThan(params.latestReport?.generatedAtUtc ?? null, generatedAtUtc),
    newerPackageAvailable:
      params.linkReportVersion != null
        ? (params.latestPackageReportVersion ?? 0) > params.linkReportVersion
        : isLaterThan(params.latestVerificationPackage?.generatedAtUtc ?? null, generatedAtUtc),
  };

  return {
    verificationSnapshot,
    liveAnchoring,
  };
}
