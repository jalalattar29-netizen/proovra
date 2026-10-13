/**
 * READINESS AND THE ONE OTS STATE (2026-10-13).
 *
 * The intelligence layer reads the record's OTS state from the ONE authority
 * (resolveRecordOtsAnchoring): the stored proof executed against the record's
 * fingerprint digest. ANCHORED only when the proof reaches a valid Bitcoin
 * block attestation — never from ots_status, a txid or an anchor time.
 *
 * Pinned here, over every state, on a Free (NOT_INCLUDED) and a paid (READY)
 * record:
 *   * ANCHORED, PENDING and NOT_REQUESTED are not review gaps;
 *   * a FAILED proof, or an unreadable one (UNAVAILABLE), IS one, with honest
 *     wording;
 *   * the retired chain-verifier vocabulary is never emitted;
 *   * "Public verification not configured" is never emitted.
 */
import { describe, expect, it, vi } from "vitest";

import { otsProofForDigest } from "./helpers/ots-proof-bytes.js";

vi.mock("../src/db.js", () => ({
  prisma: { custodyEvent: { findMany: async () => [] } },
}));

const { buildEvidenceIntelligence } = await import("../src/services/evidence-intelligence.service.js");

type Ots = {
  otsStatus: string | null;
  otsAnchoredAtUtc: string | null;
  otsProofBase64: string | null;
  otsFailureReason?: string | null;
};

const DIGEST = "b".repeat(64);

const OTS: Record<string, Ots> = {
  ANCHORED: {
    otsStatus: "ANCHORED",
    otsAnchoredAtUtc: "2026-09-01T00:00:00Z",
    otsProofBase64: otsProofForDigest(DIGEST, { bitcoinHeight: 860000 }),
  },
  // A row that SAYS anchored but carries a pending proof is pending.
  ANCHORED_STATUS_PENDING_PROOF: {
    otsStatus: "ANCHORED",
    otsAnchoredAtUtc: "2026-09-01T00:00:00Z",
    otsProofBase64: otsProofForDigest(DIGEST),
  },
  PENDING: { otsStatus: "PENDING", otsAnchoredAtUtc: null, otsProofBase64: otsProofForDigest(DIGEST) },
  FAILED: { otsStatus: "FAILED", otsAnchoredAtUtc: null, otsProofBase64: null, otsFailureReason: "OTS_GLOBAL_BUDGET_EXHAUSTED" },
  MISMATCH: {
    otsStatus: "ANCHORED",
    otsAnchoredAtUtc: "2026-09-01T00:00:00Z",
    otsProofBase64: otsProofForDigest("c".repeat(64), { bitcoinHeight: 860000 }),
  },
  MISSING_PROOF: { otsStatus: "ANCHORED", otsAnchoredAtUtc: "2026-09-01T00:00:00Z", otsProofBase64: null },
  NONE: { otsStatus: null, otsAnchoredAtUtc: null, otsProofBase64: null },
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
    fingerprintHash: DIGEST,
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
  it.each(["ANCHORED", "ANCHORED_STATUS_PENDING_PROOF", "PENDING", "NONE"] as const)(
    "%s OTS is ready for review with no anchoring issue or alert",
    async (otsKey) => {
      const i = await build(otsKey, outputs);
      expect(i.reviewerDecision.status).toBe("READY_FOR_EXTERNAL_REVIEW");
      expect(allText(i)).not.toMatch(/Public verification not configured/);
      expect(allText(i)).not.toMatch(/has not been confirmed/);
      expect(i.reviewerAlerts.map((a) => a.label)).not.toContain("Bitcoin anchoring failed");
      expect(i.reviewerAlerts.map((a) => a.label)).not.toContain("Bitcoin anchoring unavailable");
    },
  );

  it("never uses the retired chain-verifier vocabulary", async () => {
    for (const otsKey of Object.keys(OTS) as Array<keyof typeof OTS>) {
      const i = await build(otsKey, outputs);
      expect(allText(i), otsKey).not.toMatch(
        /independently verified|anchoring verified|attestation recorded|not checked|chain-verified|unverified/i,
      );
    }
  });

  it("an anchored proof says Bitcoin anchored", async () => {
    const i = await build("ANCHORED", outputs);
    expect(i.reviewerDecision.reasons).toContain(
      "Bitcoin anchoring: Bitcoin anchored. OpenTimestamps proof anchored in Bitcoin.",
    );
    expect(i.verificationProof.otsState).toBe("ANCHORED");
  });

  it("a row that says ANCHORED with a pending proof is never anchored", async () => {
    const i = await build("ANCHORED_STATUS_PENDING_PROOF", outputs);
    expect(i.verificationProof.otsState).toBe("PENDING");
    expect(JSON.stringify(i.reviewerDecision.reasons)).not.toMatch(/Bitcoin anchored/);
  });

  it("a FAILED proof is a review gap, worded as a failure of anchoring only", async () => {
    for (const otsKey of ["FAILED", "MISMATCH"] as const) {
      const i = await build(otsKey, outputs);
      expect(i.reviewerDecision.status, otsKey).toBe("NEEDS_ATTENTION");
      expect(i.reviewerDecision.reasons).toContain("Bitcoin anchoring failed for this record.");
      const alert = i.reviewerAlerts.find((a) => a.label === "Bitcoin anchoring failed");
      expect(alert?.detail).toMatch(/fingerprint, signature and custody chain are unaffected/);
    }
  });

  it("an unreadable proof (UNAVAILABLE) is a review gap and an alert", async () => {
    const i = await build("MISSING_PROOF", outputs);
    expect(i.reviewerDecision.status).toBe("NEEDS_ATTENTION");
    expect(i.reviewerAlerts.map((a) => a.label)).toContain("Bitcoin anchoring unavailable");
    expect(i.verificationProof.otsState).toBe("UNAVAILABLE");
  });
});

describe("readiness score", () => {
  it("anchoring that was not requested leaves the denominator; an anchored proof earns its point", async () => {
    const none = await build("NONE", FREE);
    const anchored = await build("ANCHORED", FREE);
    expect(none.librarySummary.score).toBe(anchored.librarySummary.score);
  });

  it("a failed proof scores lower than an anchored one", async () => {
    const failed = await build("FAILED", FREE);
    const anchored = await build("ANCHORED", FREE);
    expect(failed.librarySummary.score ?? 0).toBeLessThan(anchored.librarySummary.score ?? 0);
  });
});
