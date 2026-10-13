/**
 * ET-RPT-09 — the executive conclusion's anchoring claim follows the check.
 *
 * On a40ca76f an OpenTimestamps proof anchored to a Bitcoin block but NOT
 * checked against the chain scored "passed" (10/10) with anchoringState
 * "finalized", so the conclusion said the record had "finalized supporting
 * publication materials" while the OTS callout in the same PDF said
 * "Anchored — chain not checked". Since 2026-10-07 the decision itself can no
 * longer be finalized over an unchecked anchor, so the conclusion is driven
 * through the real builder here, not a hand-made finalized stub. Since
 * 2026-10-08 the conclusion IS the verification matrix's bounded summary and
 * the reviewer action: no overall verdict, confidence or score.
 */
import { describe, expect, it } from "vitest";

import { buildEvidenceTrustDecision, buildVerificationMatrix, findForbiddenCustomerClaims } from "@proovra/shared";

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

function conclude(otsAnchorCheck: "PROOF_STRUCTURE" | "BITCOIN_VERIFIED", acquisitionMode = "DIRECT_SCREEN_CAPTURE_IOS") {
  const decision = decide(otsAnchorCheck);
  const matrix = buildVerificationMatrix({
    signals: decision.signals,
    identity: null,
    acquisitionMode,
    packageSeal: { kind: "SELF" },
    publication: { kind: "DOCUMENT" },
  });
  void matrix;
  return buildExecutiveConclusion(decision);
}

describe("executive conclusion vs the OTS chain check (ET-RPT-09)", () => {
  it("anchored but not chain-checked: anchoring is named as not verified, never verified; no success tone", () => {
    const c = conclude("PROOF_STRUCTURE");
    expect(c.body).not.toMatch(/finalized supporting/i);
    expect(c.body).toMatch(/Not verified: [^.]*Bitcoin anchoring/);
    expect(c.body).not.toMatch(/Verified for this evidence record: [^.]*Bitcoin anchoring/);
    // The OTS card states its status and sentence once; the conclusion does not repeat them.
    expect(c.body).not.toMatch(/OpenTimestamps|Attestation recorded|Independent Bitcoin verification/);
    expect(findForbiddenCustomerClaims(c.body)).toEqual([]);
    expect(c.tone).not.toBe("success");
  });

  it("states the evidence's verification layers — never a product boundary or a verdict", () => {
    const c = conclude("PROOF_STRUCTURE");
    expect(c.body).toMatch(/^Verified for this evidence record: core integrity, /);
    expect(c.body).not.toMatch(/PROOVRA|admissib|authorship|Not checked/);
    expect(findForbiddenCustomerClaims(c.body)).toEqual([]);
  });
});
