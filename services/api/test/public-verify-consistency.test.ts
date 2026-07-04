import { describe, expect, it } from "vitest";
import type { TrustDecision } from "@proovra/shared";
import {
  buildPublicVerifyConsistencySections,
  deriveSnapshotOtsStatus,
} from "../src/services/public-verify-consistency.service.js";

function buildTrustDecision(status: "passed" | "partial" | "failed"): TrustDecision {
  const finalized = status === "passed";
  const pending = status === "partial";

  return {
    verdict: "VERIFIED",
    level: finalized ? "standard" : pending ? "partial" : "review",
    verdictLabel: "Verified",
    shortLabel: "Verified",
    title: "Verification snapshot",
    confidenceLabel: "Moderate confidence",
    score: 82,
    maxScore: 100,
    scoreLabel: "82/100",
    tone: "success",
    presentationState: finalized
      ? "VERIFIED_FINALIZED"
      : pending
        ? "VERIFIED_PENDING_ANCHORING"
        : "FAILED_VERIFICATION",
    presentationTone: finalized ? "success" : pending ? "warning" : "danger",
    anchoringState: finalized ? "finalized" : pending ? "pending" : "failed",
    anchoringStatusLabel: finalized ? "Finalized" : pending ? "Pending" : "Failed",
    relianceLevel: "medium",
    degradedButUsable: false,
    summary: "Snapshot trust decision",
    primaryReason: "Snapshot integrity recorded",
    reviewerAction: "Review the fixed snapshot.",
    passedSignals: status === "passed" ? 1 : 0,
    degradedSignals: status === "partial" ? 1 : 0,
    failedSignals: status === "failed" ? 1 : 0,
    signals: [
      {
        key: "bitcoin_anchoring",
        label: "Bitcoin anchoring",
        status,
        tone: status === "failed" ? "danger" : status === "passed" ? "success" : "warning",
        points: status === "passed" ? 10 : status === "partial" ? 5 : 0,
        maxPoints: 10,
        summary: "Anchoring snapshot",
        detail: "Anchoring status recorded at generation time.",
      },
    ],
  };
}

describe("public verify consistency helpers", () => {
  it("derives OTS snapshot state from the trust-decision bitcoin_anchoring signal", () => {
    expect(deriveSnapshotOtsStatus(buildTrustDecision("passed"))).toBe("ANCHORED");
    expect(deriveSnapshotOtsStatus(buildTrustDecision("partial"))).toBe("PENDING");
    expect(deriveSnapshotOtsStatus(buildTrustDecision("failed"))).toBe("FAILED");
    expect(deriveSnapshotOtsStatus(null)).toBeNull();
  });

  it("flags anchoring advancement when the live row outruns the fixed snapshot", () => {
    const { verificationSnapshot, liveAnchoring } =
      buildPublicVerifyConsistencySections({
        source: "REPORT_SNAPSHOT",
        trustDecisionSnapshot: buildTrustDecision("partial"),
        latestReport: {
          version: 1,
          generatedAtUtc: new Date("2026-06-08T10:00:00Z"),
          pdfSignatureStatus: "SIGNED",
          pdfSignedAtUtc: new Date("2026-06-08T10:01:00Z"),
        },
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
        currentOtsStatus: "ANCHORED",
        otsAnchoredAtUtc: "2026-06-08T11:30:00Z",
        otsBitcoinTxid: "a".repeat(64),
        otsUpgradedAtUtc: "2026-06-08T11:30:00Z",
      });

    expect(verificationSnapshot.otsStatusAtGeneration).toBe("PENDING");
    expect(liveAnchoring.currentOtsStatus).toBe("ANCHORED");
    expect(liveAnchoring.hasAdvancedSinceSnapshot).toBe(true);
    expect(liveAnchoring.newerPackageAvailable).toBe(true);
    expect(liveAnchoring.newerReportAvailable).toBe(false);
  });

  it("does not mutate the fixed trust-decision snapshot when live OTS changes", () => {
    const snapshot = buildTrustDecision("partial");
    const { verificationSnapshot } = buildPublicVerifyConsistencySections({
      source: "REPORT_SNAPSHOT",
      trustDecisionSnapshot: snapshot,
      latestReport: {
        version: 3,
        generatedAtUtc: new Date("2026-06-08T10:00:00Z"),
        pdfSignatureStatus: null,
        pdfSignedAtUtc: null,
      },
      latestVerificationPackage: null,
      verificationPackageIntegrity: null,
      currentOtsStatus: "ANCHORED",
      otsAnchoredAtUtc: "2026-06-08T11:30:00Z",
      otsBitcoinTxid: "b".repeat(64),
      otsUpgradedAtUtc: "2026-06-08T11:30:00Z",
    });

    expect(verificationSnapshot.trustDecisionSnapshot).toEqual(snapshot);
    expect(verificationSnapshot.otsStatusAtGeneration).toBe("PENDING");
  });
});
