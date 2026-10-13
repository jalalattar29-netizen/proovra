/**
 * ET-RPT-09, re-stated 2026-10-13 — the executive conclusion and Bitcoin
 * anchoring. Anchoring is stated in its own words ("Bitcoin anchoring:
 * Anchored." / "Pending." …) from the canonical state, never as "verified" and
 * never as a reason the other layers fail. Driven through the real builder on
 * real OpenTimestamps bytes.
 */
import { describe, expect, it } from "vitest";

import { buildEvidenceTrustDecision, findForbiddenCustomerClaims } from "@proovra/shared";

import { REAL, upgradedProof } from "../../../packages/shared/tests/helpers/ots-fixtures.mjs";
import { buildExecutiveConclusion } from "../src/report-v2/truth-model.js";

const forensic = Array.from({ length: 6 }, (_, i) => ({
  eventType: `FORENSIC_${i}`,
  category: "forensic" as const,
  prevEventHash: i ? `h${i - 1}` : null,
  eventHash: `h${i}`,
}));

function conclude(otsProofBase64: string | null, otsStatus = "ANCHORED") {
  const decision = buildEvidenceTrustDecision({
    evidence: {
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
      recordedIntegrityVerifiedAtUtc: "2026-10-01T00:00:00.000Z",
      fileSha256: "a".repeat(64),
      fingerprintHash: REAL.boundFingerprintHash,
      signatureBase64: "c2ln",
      signingKeyId: "k1",
      publicKeyPem: "pem",
      signatureVerified: true,
      custodyChainValid: true,
      tsaStatus: "STAMPED",
      tsaValidatedAtUtc: "2026-10-01T00:00:01.000Z",
      otsStatus,
      otsHash: REAL.boundFingerprintHash,
      otsAnchoredAtUtc: "2026-10-01T02:00:00.000Z",
      otsProofBase64,
      storageImmutable: true,
      storageObjectLockMode: "COMPLIANCE",
      storageObjectLockRetainUntilUtc: "2036-01-01T00:00:00.000Z",
      identityLevelSnapshot: "VERIFIED_EMAIL",
    },
    custodyEvents: forensic,
  });
  return buildExecutiveConclusion(decision);
}

describe("executive conclusion and Bitcoin anchoring", () => {
  it("an anchored proof: 'Bitcoin anchoring: Anchored.', never in the verified list, success tone", () => {
    const c = conclude(upgradedProof().base64);
    expect(c.body).toMatch(/^Verified for this evidence record: core integrity, /);
    expect(c.body).toContain("Bitcoin anchoring: Anchored.");
    expect(c.body).not.toMatch(/Verified for this evidence record: [^.]*Bitcoin anchoring/);
    expect(c.body).not.toMatch(/Not verified: [^.]*Bitcoin anchoring/);
    expect(c.tone).toBe("success");
    expect(findForbiddenCustomerClaims(c.body)).toEqual([]);
  });

  it("a stored ANCHORED label over a pending proof: 'Bitcoin anchoring: Pending.' — the proof decides", () => {
    const c = conclude(REAL.boundProofBase64);
    expect(c.body).toContain("Bitcoin anchoring: Pending.");
    expect(c.body).not.toContain("Anchored");
    // Pending anchoring is not a defect of the other layers.
    expect(c.body).not.toMatch(/Failed:|Not verified:/);
  });

  it("no proof bytes: 'Bitcoin anchoring: Unavailable.'", () => {
    expect(conclude(null).body).toContain("Bitcoin anchoring: Unavailable.");
  });

  it("states the evidence's verification layers — never a product boundary or a verdict", () => {
    const c = conclude(upgradedProof().base64);
    expect(c.body).not.toMatch(/PROOVRA|admissib|authorship|Not checked|Attestation recorded|independently verified/);
    expect(findForbiddenCustomerClaims(c.body)).toEqual([]);
  });
});
