/**
 * ET-RPT-09 — the executive conclusion's anchoring claim follows the check.
 *
 * On a40ca76f an OpenTimestamps proof anchored to a Bitcoin block but NOT
 * checked against the chain scored "passed" (10/10) with anchoringState
 * "finalized", so the conclusion said the record had "finalized supporting
 * publication materials" while the OTS callout in the same PDF said
 * "Anchored — chain not checked". Since 2026-10-07 the decision itself can no
 * longer be finalized over an unchecked anchor, so the conclusion is driven
 * through the real builder here, not a hand-made finalized stub.
 */
import { describe, expect, it } from "vitest";

import { buildEvidenceTrustDecision } from "@proovra/shared";

import { buildExecutiveConclusion } from "../src/report-v2/truth-model.js";

const forensic = Array.from({ length: 6 }, (_, i) => ({
  eventType: `FORENSIC_${i}`,
  category: "forensic" as const,
  prevEventHash: i ? `h${i - 1}` : null,
  eventHash: `h${i}`,
}));

function decide(otsAnchorCheck: "PROOF_STRUCTURE" | "BITCOIN_VERIFIED") {
  return buildEvidenceTrustDecision({
    evidence: {
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
      recordedIntegrityVerifiedAtUtc: "2026-10-01T00:00:00.000Z",
      fileSha256: "a".repeat(64),
      fingerprintHash: "b".repeat(64),
      signatureBase64: "c2ln",
      signingKeyId: "k1",
      publicKeyPem: "pem",
      signatureVerified: true,
      custodyChainValid: true,
      tsaStatus: "STAMPED",
      tsaValidatedAtUtc: "2026-10-01T00:00:01.000Z",
      otsStatus: "ANCHORED",
      otsAnchoredAtUtc: "2026-10-01T02:00:00.000Z",
      otsBitcoinTxid: "c".repeat(64),
      otsAnchorCheck,
      storageImmutable: true,
      storageObjectLockMode: "COMPLIANCE",
      storageObjectLockRetainUntilUtc: "2036-01-01T00:00:00.000Z",
      identityLevelSnapshot: "VERIFIED_EMAIL",
    },
    custodyEvents: forensic,
  });
}

describe("executive conclusion vs the OTS chain check (ET-RPT-09)", () => {
  it("anchored but not chain-checked: no 'finalized' claim and no success tone", () => {
    const c = buildExecutiveConclusion(decide("PROOF_STRUCTURE"));
    expect(c.body).not.toMatch(/finalized supporting/i);
    expect(c.body).toContain("not been independently checked against the Bitcoin chain");
    expect(c.body).toContain("does not claim verified Bitcoin anchoring");
    expect(c.tone).not.toBe("success");
  });

  it("chain-verified keeps the finalized conclusion", () => {
    const c = buildExecutiveConclusion(decide("BITCOIN_VERIFIED"));
    expect(c.body).toContain("finalized supporting publication materials");
    expect(c.tone).toBe("success");
  });
});
