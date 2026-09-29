/**
 * READINESS IS NOT CHAIN VERIFICATION (2026-09-29).
 *
 * After 1a86485c the intelligence layer read "anchoring verified against the
 * Bitcoin chain" — which no production worker can establish (no Bitcoin node)
 * — as "the record is anchored". Every healthy record read "Bitcoin anchoring
 * has not been confirmed" / "Needs review", and the alert block said "Public
 * verification not configured" because an unrelated external-anchor provider
 * variable was empty.
 *
 * Pinned here, over every OTS claim, on a Free (NOT_INCLUDED) and a paid
 * (READY) record:
 *   * an anchor RECORDED (verified or not) is not a review gap;
 *   * a PENDING proof is not a review gap (every record's first hours);
 *   * a FAILED proof, or no proof at all, IS one, with honest wording;
 *   * nothing says "verified" unless the claim is VERIFIED;
 *   * "Public verification not configured" is never emitted.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({
  prisma: { custodyEvent: { findMany: async () => [] } },
}));

const { buildEvidenceIntelligence } = await import("../src/services/evidence-intelligence.service.js");

type Ots = {
  otsStatus: string | null;
  otsAnchoredAtUtc: string | null;
  otsAnchorCheck: string | null;
};

const OTS: Record<string, Ots> = {
  VERIFIED: { otsStatus: "ANCHORED", otsAnchoredAtUtc: "2026-09-01T00:00:00Z", otsAnchorCheck: "BITCOIN_VERIFIED" },
  PROOF_STRUCTURE: { otsStatus: "ANCHORED", otsAnchoredAtUtc: "2026-09-01T00:00:00Z", otsAnchorCheck: "PROOF_STRUCTURE" },
  HISTORICAL_NULL_CHECK: { otsStatus: "ANCHORED", otsAnchoredAtUtc: "2026-09-01T00:00:00Z", otsAnchorCheck: null },
  PENDING: { otsStatus: "PENDING", otsAnchoredAtUtc: null, otsAnchorCheck: null },
  FAILED: { otsStatus: "FAILED", otsAnchoredAtUtc: null, otsAnchorCheck: null },
  NONE: { otsStatus: null, otsAnchoredAtUtc: null, otsAnchorCheck: null },
};

function evidence(ots: Ots, status: "SIGNED" | "REPORTED" = "SIGNED") {
  return {
    id: "ev-1",
    status,
    verificationStatus: null,
    signedAtUtc: "2026-08-01T00:00:00Z",
    capturedAtUtc: null,
    uploadedAtUtc: null,
    lastAccessedAtUtc: null,
    lastVerifiedAtUtc: null,
    recordedIntegrityVerifiedAtUtc: null,
    captureMethod: null,
    identityLevelSnapshot: null,
    submittedByEmail: null,
    submittedByAuthProvider: null,
    uploadedByUserId: null,
    createdByUserId: null,
    workspaceNameSnapshot: null,
    organizationNameSnapshot: null,
    organizationVerifiedSnapshot: null,
    fileSha256: "a".repeat(64),
    fingerprintHash: "b".repeat(64),
    signatureBase64: "sig",
    signingKeyId: "k",
    signingKeyVersion: 1,
    tsaStatus: "STAMPED",
    ...ots,
    reportGeneratedAtUtc: null,
    verificationPackageGeneratedAtUtc: null,
    latestReportVersion: status === "REPORTED" ? 1 : null,
    verificationPackageVersion: status === "REPORTED" ? 1 : null,
    createdAt: "2026-08-01T00:00:00Z",
    deviceTimeIso: null,
    lat: null,
    lng: null,
    accuracyMeters: null,
    lockedAt: null,
    archivedAt: null,
    deletedAt: null,
    deleteScheduledForUtc: null,
    retentionUntilUtc: null,
    storageBucket: null,
    storageKey: null,
    storageRegion: null,
    storageObjectLockMode: null,
    storageObjectLockRetainUntilUtc: null,
    storageObjectLockLegalHoldStatus: null,
  };
}

// Production as declared: no external anchor provider configured.
const NO_PROVIDER_ANCHOR = {
  provider: null,
  mode: "ready",
  configured: false,
  anchorHash: null,
  anchoredAtUtc: null,
  transactionId: null,
};

const FREE = {
  report: { state: "NOT_INCLUDED", notApplicableReason: null },
  verificationPackage: { state: "NOT_INCLUDED", notApplicableReason: null },
} as const;
const PAID_READY = {
  report: { state: "READY", notApplicableReason: null },
  verificationPackage: { state: "READY", notApplicableReason: null },
} as const;

async function build(otsKey: keyof typeof OTS, outputs: typeof FREE | typeof PAID_READY) {
  return buildEvidenceIntelligence({
    evidenceId: "ev-1",
    evidence: evidence(OTS[otsKey], outputs === PAID_READY ? "REPORTED" : "SIGNED") as never,
    anchor: NO_PROVIDER_ANCHOR,
    storage: { immutable: true, mode: "COMPLIANCE", retainUntil: "2036-01-01T00:00:00Z", legalHold: null, region: "eu", verified: true },
    outputs: outputs as never,
  });
}

function allText(i: Awaited<ReturnType<typeof build>>): string {
  return JSON.stringify({ d: i.reviewerDecision, a: i.reviewerAlerts });
}

describe.each([
  ["Free record", FREE],
  ["paid record with its pair", PAID_READY],
] as const)("%s", (_label, outputs) => {
  it.each(["VERIFIED", "PROOF_STRUCTURE", "HISTORICAL_NULL_CHECK", "PENDING"] as const)(
    "%s OTS is ready for review with no anchoring issue or alert",
    async (otsKey) => {
      const i = await build(otsKey, outputs);
      expect(i.reviewerDecision.status).toBe("READY_FOR_EXTERNAL_REVIEW");
      expect(allText(i)).not.toMatch(/Public verification not configured/);
      expect(allText(i)).not.toMatch(/has not been confirmed/);
      expect(i.reviewerAlerts.map((a) => a.label)).not.toContain("No OpenTimestamps proof recorded");
      expect(i.reviewerAlerts.map((a) => a.label)).not.toContain("OpenTimestamps anchoring failed");
    },
  );

  it("never says 'verified' unless the anchor was checked against the chain", async () => {
    for (const otsKey of ["PROOF_STRUCTURE", "HISTORICAL_NULL_CHECK", "PENDING"] as const) {
      const i = await build(otsKey, outputs);
      expect(allText(i), otsKey).not.toMatch(/anchoring verified/i);
    }
    const verified = await build("VERIFIED", outputs);
    expect(verified.reviewerDecision.reasons).toContain("OpenTimestamps Bitcoin anchoring verified.");
  });

  it("an anchor recorded but not checked says so", async () => {
    const i = await build("PROOF_STRUCTURE", outputs);
    expect(i.reviewerDecision.reasons.join(" ")).toMatch(/not checked against the Bitcoin chain/);
  });

  it("a FAILED proof is a review gap, worded as a failure of anchoring only", async () => {
    const i = await build("FAILED", outputs);
    expect(i.reviewerDecision.status).toBe("NEEDS_ATTENTION");
    expect(i.reviewerDecision.reasons).toContain("OpenTimestamps anchoring failed for this record.");
    const alert = i.reviewerAlerts.find((a) => a.label === "OpenTimestamps anchoring failed");
    expect(alert?.detail).toMatch(/fingerprint, signature and custody chain are unaffected/);
  });

  it("no OTS state at all is a review gap and an alert", async () => {
    const i = await build("NONE", outputs);
    expect(i.reviewerDecision.status).toBe("NEEDS_ATTENTION");
    expect(i.reviewerAlerts.map((a) => a.label)).toContain("No OpenTimestamps proof recorded");
  });
});

describe("readiness score", () => {
  it("an anchor recorded but not chain-checked scores as prepared", async () => {
    const structure = await build("PROOF_STRUCTURE", FREE);
    const verified = await build("VERIFIED", FREE);
    expect(structure.librarySummary.score).toBe(verified.librarySummary.score);
  });

  it("a failed proof scores lower than a recorded one", async () => {
    const failed = await build("FAILED", FREE);
    const structure = await build("PROOF_STRUCTURE", FREE);
    expect(failed.librarySummary.score ?? 0).toBeLessThan(structure.librarySummary.score ?? 0);
  });
});
