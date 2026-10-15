/**
 * ET-RPT-09, re-stated 2026-10-13 — the executive conclusion and Bitcoin
 * anchoring. Anchoring is stated in its own words ("Bitcoin anchoring:
 * Attestation recorded." / "Independently verified." / "Pending." …) from the canonical verification (2026-10-15), never as "verified" and
 * never as a reason the other layers fail. Driven through the real builder on
 * real OpenTimestamps bytes.
 */
import { describe, expect, it } from "vitest";

import { buildEvidenceTrustDecision, findForbiddenCustomerClaims } from "@proovra/shared";

import { REAL, upgradedProof } from "../../../packages/shared/tests/helpers/ots-fixtures.mjs";
import { chainColumnsFor } from "./fixtures/ots-chain-fixtures.js";
import { buildExecutiveConclusion } from "../src/report-v2/truth-model.js";

const forensic = Array.from({ length: 6 }, (_, i) => ({
  eventType: `FORENSIC_${i}`,
  category: "forensic" as const,
  prevEventHash: i ? `h${i - 1}` : null,
  eventHash: `h${i}`,
}));

function conclude(otsProofBase64: string | null, otsStatus = "ANCHORED", chain: Record<string, unknown> = {}) {
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
      // AUD-014 — this run read the stored object and confirmed the lock.
      storageProtectionVerification: "STORAGE_CONFIRMED",
      identityLevelSnapshot: "VERIFIED_EMAIL",
      ...chain,
    },
    custodyEvents: forensic,
  });
  return buildExecutiveConclusion(decision);
}

describe("executive conclusion and Bitcoin anchoring", () => {
  // 2026-10-15: ANCHORED only NAMES a block; its word is "Attestation recorded".
  it("an anchored proof (unchecked attestation): 'Bitcoin anchoring: Attestation recorded.', never in the verified list, success tone", () => {
    const c = conclude(upgradedProof().base64);
    expect(c.body).toMatch(/^Verified for this evidence record: core integrity, /);
    expect(c.body).toContain("Bitcoin anchoring: Attestation recorded.");
    expect(c.body).not.toContain("Anchored");
    expect(c.body).not.toMatch(/Verified for this evidence record: [^.]*Bitcoin anchoring/);
    expect(c.body).not.toMatch(/Not verified: [^.]*Bitcoin anchoring/);
    expect(c.tone).toBe("success");
    expect(findForbiddenCustomerClaims(c.body)).toEqual([]);
  });

  it("a proof independently verified against the Bitcoin main chain: 'Bitcoin anchoring: Independently verified.'", () => {
    const up = upgradedProof();
    const c = conclude(up.base64, "ANCHORED", chainColumnsFor(up));
    expect(c.body).toContain("Bitcoin anchoring: Independently verified.");
    expect(c.body).not.toMatch(/Not verified: [^.]*Bitcoin anchoring/);
    expect(c.tone).toBe("success");
    expect(findForbiddenCustomerClaims(c.body)).toEqual([]);
  });

  it("a chain check still pending confirmations is not verified", () => {
    const up = upgradedProof();
    const c = conclude(up.base64, "ANCHORED", chainColumnsFor(up, { status: "INSUFFICIENT_CONFIRMATIONS" }));
    expect(c.body).toContain("Bitcoin anchoring: Verification pending.");
    expect(c.body).not.toContain("Independently verified");
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
    // 2026-10-15: "Attestation recorded" is now THE word for an unchecked
    // attestation; a verified claim is still never made for it.
    expect(c.body).not.toMatch(/PROOVRA|admissib|authorship|Not checked|independently verified|Independently verified/);
    expect(findForbiddenCustomerClaims(c.body)).toEqual([]);
  });
});
