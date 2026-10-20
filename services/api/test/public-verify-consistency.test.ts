import { describe, expect, it } from "vitest";
import { resolveOtsAnchoring, type TrustDecision } from "@proovra/shared";
import {
  buildPublicVerifyConsistencySections,
  reportOtsStateOf,
} from "../src/services/public-verify-consistency.service.js";
import { otsProofForDigest } from "./helpers/ots-proof-bytes.js";

const DIGEST = "d".repeat(64);

function buildTrustDecision(): TrustDecision {
  return {
    tone: "success",
    presentationState: "VERIFIED_PENDING_ANCHORING",
    presentationTone: "warning",
    anchoringState: "pending",
    anchoringStatusLabel: "Pending",
    summary: "Snapshot trust decision",
    reviewerAction: "Review the fixed snapshot.",
    integrityReviewRequired: false,
    signals: [
      {
        key: "bitcoin_anchoring",
        label: "Bitcoin anchoring",
        status: "partial",
        tone: "warning",
        summary: "Anchoring snapshot",
        state: "PENDING",
        measuredAtUtc: null,
        detail: "Anchoring status recorded at generation time.",
      },
    ],
  } as TrustDecision;
}

/** The record's live anchoring, resolved from a real proof — never from a status string. */
const anchoredNow = resolveOtsAnchoring({
  status: "ANCHORED",
  proofBase64: otsProofForDigest(DIGEST, { bitcoinHeight: 860123 }),
  fingerprintHash: DIGEST,
  anchoredAtUtc: "2026-06-08T11:30:00Z",
});

const report = (anchorSnapshot: unknown) => ({
  version: 1,
  generatedAtUtc: new Date("2026-06-08T10:00:00Z"),
  pdfSignatureStatus: "SIGNED",
  pdfSignedAtUtc: new Date("2026-06-08T10:01:00Z"),
  anchorSnapshot,
});

describe("public verify consistency helpers (2026-10-13)", () => {
  it("AUD-48: a REPORT link issued for v1 says a newer report exists once v2 is issued (never a dead flag)", () => {
    const base = {
      source: "REPORT_SNAPSHOT" as const,
      trustDecisionSnapshot: buildTrustDecision(),
      latestVerificationPackage: null,
      verificationPackageIntegrity: null,
      currentOts: anchoredNow,
      otsUpgradedAtUtc: null,
    };
    const v2 = { ...report({ otsState: "PENDING" }), version: 2 };
    expect(buildPublicVerifyConsistencySections({ ...base, latestReport: v2, linkReportVersion: 1 }).liveAnchoring.newerReportAvailable).toBe(true);
    expect(buildPublicVerifyConsistencySections({ ...base, latestReport: v2, linkReportVersion: 2 }).liveAnchoring.newerReportAvailable).toBe(false);
    expect(buildPublicVerifyConsistencySections({ ...base, latestReport: v2, linkReportVersion: 1, latestPackageReportVersion: 2 }).liveAnchoring.newerPackageAvailable).toBe(true);
    expect(buildPublicVerifyConsistencySections({ ...base, latestReport: v2 }).liveAnchoring).not.toHaveProperty("autoRefreshRecommended");
  });

  it("the state a report stated is its anchorSnapshot.otsState; a legacy report reads UNAVAILABLE", () => {
    expect(reportOtsStateOf({ otsState: "PENDING" })).toBe("PENDING");
    expect(reportOtsStateOf({ otsState: "ANCHORED" })).toBe("ANCHORED");
    expect(reportOtsStateOf({ otsState: "VERIFIED" })).toBe("UNAVAILABLE");
    expect(reportOtsStateOf({ mode: "anchored" })).toBe("UNAVAILABLE");
    expect(reportOtsStateOf(null)).toBe("UNAVAILABLE");
  });

  it("liveAnchoring carries only operational freshness fields and flags advancement past the report", () => {
    const { verificationSnapshot, liveAnchoring } =
      buildPublicVerifyConsistencySections({
        source: "REPORT_SNAPSHOT",
        trustDecisionSnapshot: buildTrustDecision(),
        latestReport: report({ otsState: "PENDING" }),
        latestVerificationPackage: {
          version: 2,
          generatedAtUtc: new Date("2026-06-08T12:00:00Z"),
          packageType: "FULL",
        },
        verificationPackageIntegrity: {
          manifestPresent: true,
          signedManifestPresent: true,
          packageType: "FULL",
        },
        currentOts: anchoredNow,
        otsUpgradedAtUtc: "2026-06-08T11:30:00Z",
      });

    expect(verificationSnapshot.otsStatusAtGeneration).toBe("PENDING");
    expect(liveAnchoring).toEqual({
      lastUpdatedAtUtc: "2026-06-08T11:30:00Z",
      hasAdvancedSinceSnapshot: true,
      // (2026-10-18) HOW it advanced, by canonical state (otsAdvanceSinceIssue):
      // the report stated PENDING; an attestation has been recorded since (the
      // chain itself is not verified, so not CHAIN_VERIFIED_SINCE_ISSUE).
      advance: "ATTESTATION_RECORDED_SINCE_ISSUE",
      newerReportAvailable: false,
      newerPackageAvailable: true,
    });
    // The OTS state lives in storageAndTimestamping.ots, not here.
    for (const key of ["state", "currentOtsStatus", "otsAnchoredAtUtc", "otsProofRecordedAtUtc", "otsBitcoinTxid"]) {
      expect(liveAnchoring).not.toHaveProperty(key);
    }
  });

  it("a stored ANCHORED status without a proof is not an advance", () => {
    const { liveAnchoring, verificationSnapshot } = buildPublicVerifyConsistencySections({
      source: "REPORT_SNAPSHOT",
      trustDecisionSnapshot: null,
      latestReport: report({ otsState: "PENDING" }),
      latestVerificationPackage: null,
      verificationPackageIntegrity: null,
      currentOts: resolveOtsAnchoring({ status: "ANCHORED", proofBase64: null, fingerprintHash: DIGEST }),
      otsUpgradedAtUtc: null,
    });
    expect(verificationSnapshot.otsStatusAtGeneration).toBe("PENDING");
    expect(liveAnchoring.hasAdvancedSinceSnapshot).toBe(false);
    expect(liveAnchoring.lastUpdatedAtUtc).toBeNull();
  });

  it("does not mutate the fixed trust-decision snapshot when live OTS changes", () => {
    const snapshot = buildTrustDecision();
    const { verificationSnapshot } = buildPublicVerifyConsistencySections({
      source: "REPORT_SNAPSHOT",
      trustDecisionSnapshot: snapshot,
      latestReport: report(null),
      latestVerificationPackage: null,
      verificationPackageIntegrity: null,
      currentOts: anchoredNow,
      otsUpgradedAtUtc: "2026-06-08T11:30:00Z",
    });

    expect(verificationSnapshot.trustDecisionSnapshot).toEqual(snapshot);
    // A legacy report (no anchorSnapshot.otsState) reads UNAVAILABLE.
    expect(verificationSnapshot.otsStatusAtGeneration).toBe("UNAVAILABLE");
  });
});
