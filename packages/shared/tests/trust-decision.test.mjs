import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEvidenceTrustDecision,
  evaluateRecordedIntegrityPromotion,
  getTrustDecisionPresentationTone,
  toVerificationStatus,
} from "../dist/index.js";

import { REAL, chainColumnsFor, upgradedProof } from "./helpers/ots-fixtures.mjs";

/**
 * (2026-10-13) The anchoring signal is the canonical OTS state resolved from
 * the stored proof bytes: the base record carries the real `ots stamp` proof
 * (PENDING) bound to its fingerprint digest; ANCHORED comes only from a real
 * upgraded proof (tests/helpers/ots-fixtures.mjs).
 */
const FP = REAL.boundFingerprintHash;
const ANCHORED_PROOF = upgradedProof();

function buildForensicEvent(index) {
  return {
    eventType: `FORENSIC_EVENT_${index}`,
    category: "forensic",
    prevEventHash: index > 1 ? `prev-${index - 1}` : null,
    eventHash: `hash-${index}`,
  };
}

function buildAccessEvent(index) {
  return {
    eventType: `VERIFY_VIEWED_${index}`,
    category: "access",
    prevEventHash: null,
    eventHash: null,
  };
}

function buildBaseEvidence(overrides = {}) {
  return {
    verificationStatus: "MATERIALS_AVAILABLE",
    recordedIntegrityVerifiedAtUtc: null,
    fileSha256: "a".repeat(64),
    fingerprintHash: FP,
    signatureBase64: Buffer.from("signature-material").toString("base64"),
    signingKeyId: "sig-key-1",
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\nMIIBfake\n-----END PUBLIC KEY-----",
    tsaStatus: "STAMPED",
    tsaFailureReason: null,
    otsStatus: "PENDING",
    otsFailureReason: null,
    otsProofBase64: REAL.boundProofBase64,
    storageImmutable: true,
    storageObjectLockMode: "COMPLIANCE",
    storageObjectLockRetainUntilUtc: "2030-01-01T00:00:00.000Z",
    identityLevelSnapshot: "VERIFIED_EMAIL",
    submittedByEmail: "reviewer@example.com",
    submittedByAuthProvider: "EMAIL_PASSWORD",
    verificationPackageVersion: 1,
    verificationPackageGeneratedAtUtc: "2026-05-02T10:00:00.000Z",
    anchor: null,
    ...overrides,
  };
}

test("promotes single evidence when core materials and checks are all present", () => {
  const decision = evaluateRecordedIntegrityPromotion({
    evidence: buildBaseEvidence(),
    itemCount: 1,
    multipartItemHashesPresent: true,
    canonicalHashMatches: true,
    signatureValid: true,
    custodyChainValid: true,
    forensicCustodyEventCount: 5,
    forensicCustodyHasHashChain: true,
    timestampDigestMatches: true,
    otsHashMatches: true,
  });

  assert.equal(decision.qualifies, true);
  assert.equal(decision.shouldPromote, true);
  assert.deepEqual(decision.blockers, []);
});

test("promotes multipart evidence only when multipart item hashes are complete", () => {
  const decision = evaluateRecordedIntegrityPromotion({
    evidence: buildBaseEvidence(),
    itemCount: 3,
    multipartItemHashesPresent: true,
    canonicalHashMatches: true,
    signatureValid: true,
    custodyChainValid: true,
    forensicCustodyEventCount: 6,
    forensicCustodyHasHashChain: true,
    timestampDigestMatches: null,
    otsHashMatches: null,
  });

  assert.equal(decision.qualifies, true);
  assert.equal(decision.shouldPromote, true);
});

test("does not promote when the trusted timestamp digest mismatches", () => {
  const decision = evaluateRecordedIntegrityPromotion({
    evidence: buildBaseEvidence(),
    itemCount: 1,
    multipartItemHashesPresent: true,
    canonicalHashMatches: true,
    signatureValid: true,
    custodyChainValid: true,
    forensicCustodyEventCount: 5,
    forensicCustodyHasHashChain: true,
    timestampDigestMatches: false,
    otsHashMatches: true,
  });

  assert.equal(decision.qualifies, false);
  assert.equal(decision.shouldPromote, false);
  assert.ok(decision.blockers.includes("timestamp_digest_mismatch"));
});

test("does not promote when the OTS hash mismatches the fingerprint", () => {
  const decision = evaluateRecordedIntegrityPromotion({
    evidence: buildBaseEvidence(),
    itemCount: 1,
    multipartItemHashesPresent: true,
    canonicalHashMatches: true,
    signatureValid: true,
    custodyChainValid: true,
    forensicCustodyEventCount: 5,
    forensicCustodyHasHashChain: true,
    timestampDigestMatches: true,
    otsHashMatches: false,
  });

  assert.equal(decision.qualifies, false);
  assert.equal(decision.shouldPromote, false);
  assert.ok(decision.blockers.includes("ots_hash_mismatch"));
});

test("does not promote when signature material is missing", () => {
  const decision = evaluateRecordedIntegrityPromotion({
    evidence: buildBaseEvidence({ signatureBase64: null }),
    itemCount: 1,
    multipartItemHashesPresent: true,
    canonicalHashMatches: true,
    signatureValid: false,
    custodyChainValid: true,
    forensicCustodyEventCount: 5,
    forensicCustodyHasHashChain: true,
    timestampDigestMatches: true,
    otsHashMatches: true,
  });

  assert.equal(decision.qualifies, false);
  assert.equal(decision.shouldPromote, false);
  assert.ok(decision.blockers.includes("core_crypto_material_missing"));
  assert.ok(decision.blockers.includes("signature_validation_failed"));
});

test("custody-chain scoring counts forensic events only", () => {
  const trustDecision = buildEvidenceTrustDecision({
    evidence: buildBaseEvidence({
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
      recordedIntegrityVerifiedAtUtc: "2026-05-02T10:00:00.000Z",
    }),
    custodyEvents: [
      buildForensicEvent(1),
      buildForensicEvent(2),
      buildForensicEvent(3),
      ...Array.from({ length: 12 }, (_, index) => buildAccessEvent(index + 1)),
    ],
  });

  const custodySignal = trustDecision.signals.find(
    (signal) => signal.key === "custody_chain"
  );

  assert.ok(custodySignal);
  assert.equal(custodySignal.status, "partial");
  assert.equal(toVerificationStatus(custodySignal.state), "NOT_CHECKED");
  assert.equal(custodySignal.summary, "3 forensic events recorded");
});

const anchoringOf = (overrides) =>
  buildEvidenceTrustDecision({
    evidence: buildBaseEvidence(overrides),
    custodyEvents: [buildForensicEvent(1), buildForensicEvent(2), buildForensicEvent(3)],
  }).signals.find((signal) => signal.key === "bitcoin_anchoring");

test("a stored ANCHORED status with an anchor time over a pending proof is PENDING, not passed", () => {
  const claimed = anchoringOf({
    otsStatus: "ANCHORED",
    otsAnchoredAtUtc: "2026-05-02T11:00:00.000Z",
    otsUpgradedAtUtc: "2026-05-02T11:00:00.000Z",
    otsProofBase64: REAL.boundProofBase64,
    anchor: { configured: true, provider: "opentimestamps", anchoredAtUtc: "2026-05-02T11:00:00.000Z", transactionId: "c".repeat(64) },
  });
  assert.equal(claimed.state, "PENDING");
  assert.equal(claimed.status, "pending");
  assert.equal(toVerificationStatus(claimed.state), "NOT_CHECKED");
  // The same record with a real upgraded proof is ANCHORED: an attestation
  // the proof names — present, never passed, until a chain check verifies it.
  const anchored = anchoringOf({ otsStatus: "ANCHORED", otsAnchoredAtUtc: "2026-05-02T11:00:00.000Z", otsProofBase64: ANCHORED_PROOF.base64 });
  assert.equal(anchored.state, "PRESENT_NOT_INDEPENDENTLY_VERIFIED");
  assert.notEqual(anchored.status, "passed");
  assert.equal(anchored.summary, "Attestation recorded");
  assert.equal(toVerificationStatus(anchored.state), "NOT_CHECKED");
  const verified = anchoringOf({ otsStatus: "ANCHORED", otsAnchoredAtUtc: "2026-05-02T11:00:00.000Z", otsProofBase64: ANCHORED_PROOF.base64, ...chainColumnsFor(ANCHORED_PROOF) });
  assert.equal(verified.state, "PASSED");
  assert.equal(verified.status, "passed");
  assert.equal(verified.summary, "Independently verified");
  assert.equal(toVerificationStatus(verified.state), "VERIFIED");
});

test("anchored without proof bytes is unavailable, never inferred anchored", () => {
  for (const overrides of [
    { otsStatus: "ANCHORED", otsProofBase64: null },
    {
      otsStatus: "ANCHORED",
      otsProofBase64: null,
      otsAnchoredAtUtc: "2026-05-02T11:00:00.000Z",
      anchor: { configured: true, provider: "opentimestamps", anchoredAtUtc: "2026-05-02T11:00:00.000Z", transactionId: "c".repeat(64) },
    },
  ]) {
    const anchoring = anchoringOf(overrides);
    assert.equal(anchoring.state, "UNAVAILABLE");
    assert.equal(toVerificationStatus(anchoring.state), "UNAVAILABLE");
  }
  // An upgraded proof without a recorded anchor time is still ANCHORED (the proof
  // decides) — an attestation recorded, not a verification.
  assert.equal(anchoringOf({ otsStatus: "ANCHORED", otsAnchoredAtUtc: null, otsProofBase64: ANCHORED_PROOF.base64 }).state, "PRESENT_NOT_INDEPENDENTLY_VERIFIED");
  // Nothing requested: not applicable.
  assert.equal(anchoringOf({ otsStatus: null, otsProofBase64: null }).state, "NOT_APPLICABLE");
  assert.equal(anchoringOf({ otsStatus: "DISABLED", otsProofBase64: null }).state, "NOT_APPLICABLE");
});

test("pending ots yields pending anchoring signal", () => {
  const anchoring = anchoringOf({ otsStatus: "PENDING" });
  assert.equal(anchoring?.state, "PENDING");
  assert.equal(anchoring?.status, "pending");
  assert.equal(anchoring?.summary, "Pending");
  assert.equal(toVerificationStatus(anchoring.state), "NOT_CHECKED");
});

test("pending Bitcoin anchoring degrades presentation tone; the summary names it NOT_CHECKED", () => {
  const trustDecision = buildEvidenceTrustDecision({
    evidence: buildBaseEvidence({
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
      recordedIntegrityVerifiedAtUtc: "2026-05-02T10:00:00.000Z",
      otsStatus: "PENDING",
    }),
    custodyEvents: [
      buildForensicEvent(1),
      buildForensicEvent(2),
      buildForensicEvent(3),
      buildForensicEvent(4),
      buildForensicEvent(5),
    ],
  });

  assert.equal(trustDecision.presentationState, "VERIFIED_PENDING_ANCHORING");
  assert.equal(getTrustDecisionPresentationTone(trustDecision), "warning");
  assert.match(trustDecision.summary, /Any signal marked “Not checked” was not independently verified\./);
  // The OTS card says it once; the reviewer action does not repeat it.
  assert.doesNotMatch(trustDecision.reviewerAction, /Bitcoin|OpenTimestamps/);
});

test("finalized presentation requires a validated timestamp and a proof independently verified against the Bitcoin main chain", () => {
  const decide = (otsProofBase64, extra = {}) =>
    buildEvidenceTrustDecision({
      evidence: buildBaseEvidence({
        verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
        recordedIntegrityVerifiedAtUtc: "2026-05-02T10:00:00.000Z",
        tsaValidatedAtUtc: "2026-05-02T10:00:05.000Z",
        tsaTokenPresent: true,
        otsStatus: "ANCHORED",
        otsAnchoredAtUtc: "2026-05-02T11:00:00.000Z",
        otsProofBase64,
        signatureVerified: true,
        custodyChainValid: true,
        ...extra,
      }),
      custodyEvents: [
        buildForensicEvent(1),
        buildForensicEvent(2),
        buildForensicEvent(3),
        buildForensicEvent(4),
        buildForensicEvent(5),
      ],
    });

  const finalized = decide(ANCHORED_PROOF.base64, chainColumnsFor(ANCHORED_PROOF));
  assert.equal(finalized.presentationState, "VERIFIED_FINALIZED");
  assert.equal(finalized.anchoringState, "verified");
  assert.equal(finalized.anchoringStatusLabel, "Independently verified");
  assert.equal(getTrustDecisionPresentationTone(finalized), "success");
  // No overall verdict, no score, no reliance level — the bounded summary only.
  for (const field of ["verdict", "verdictLabel", "score", "scoreLabel", "relianceLevel", "confidenceLabel", "primaryReason"]) {
    assert.equal(field in finalized, false, field);
  }
  assert.equal(
    finalized.summary,
    "Cryptographic integrity and PROOVRA custody checks passed for the preserved bytes. This record does not by itself establish authorship, factual truth, pre-PROOVRA history or legal admissibility.",
  );

  // The same record whose stored proof is still the pending one is NOT finalized.
  const pending = decide(REAL.boundProofBase64);
  assert.equal(pending.presentationState, "VERIFIED_PENDING_ANCHORING");
  assert.equal(pending.anchoringStatusLabel, "Pending");
  assert.match(pending.summary, /Any signal marked “Not checked” was not independently verified\./);
  assert.doesNotMatch(pending.reviewerAction, /Bitcoin|OpenTimestamps/);
  // A chain-verified proof with an unvalidated timestamp is not finalized either.
  const unvalidated = decide(ANCHORED_PROOF.base64, { tsaValidatedAtUtc: null, ...chainColumnsFor(ANCHORED_PROOF) });
  assert.notEqual(unvalidated.presentationState, "VERIFIED_FINALIZED");
  // An attestation the proof only NAMES (no chain check) is never finalized and never success.
  const unchecked = decide(ANCHORED_PROOF.base64);
  assert.notEqual(unchecked.presentationState, "VERIFIED_FINALIZED");
  assert.equal(unchecked.anchoringState, "recorded");
  assert.equal(unchecked.anchoringStatusLabel, "Attestation recorded");
  assert.notEqual(getTrustDecisionPresentationTone(unchecked), "success");
  // Only the chain-verified decision states the chain-verified key.
  for (const d of [pending, unchecked]) assert.doesNotMatch(JSON.stringify(d), /CHAIN_VERIFIED/);
  assert.match(JSON.stringify(finalized), /CHAIN_VERIFIED/);
});

test("failed ots yields failed anchoring signal", () => {
  const trustDecision = buildEvidenceTrustDecision({
    evidence: buildBaseEvidence({
      otsStatus: "FAILED",
      otsFailureReason: "calendar unreachable",
    }),
    custodyEvents: [buildForensicEvent(1), buildForensicEvent(2), buildForensicEvent(3)],
  });

  const anchoring = trustDecision.signals.find(
    (signal) => signal.key === "bitcoin_anchoring"
  );

  assert.equal(anchoring?.status, "failed");
  assert.equal(toVerificationStatus(anchoring.state), "FAILED");
});

test("ots hash mismatch blocks anchoring from passing even with an upgraded proof", () => {
  // The record's ots_hash names another digest.
  const otsHash = anchoringOf({ otsStatus: "ANCHORED", otsHash: "d".repeat(64), otsProofBase64: ANCHORED_PROOF.base64 });
  assert.equal(otsHash?.status, "failed");
  assert.equal(toVerificationStatus(otsHash.state), "FAILED");
  // The proof itself commits to another digest — a Bitcoin-attested one included.
  for (const otsProofBase64 of [REAL.otherProofBase64, upgradedProof({ base64: REAL.otherProofBase64 }).base64]) {
    const other = anchoringOf({ otsStatus: "ANCHORED", otsProofBase64 });
    assert.equal(other.state, "FAILED");
    assert.equal(toVerificationStatus(other.state), "FAILED");
  }
});

test("malformed proof bytes do not pass anchoring", () => {
  const b = Buffer.from(ANCHORED_PROOF.base64, "base64");
  for (const otsProofBase64 of [b.subarray(0, b.length - 5).toString("base64"), "bm90IGEgcHJvb2Y=", upgradedProof({ unexecutedOp: 0x02 }).base64]) {
    const anchoring = anchoringOf({ otsStatus: "ANCHORED", otsProofBase64 });
    assert.equal(anchoring?.status, "failed");
    assert.equal(toVerificationStatus(anchoring.state), "FAILED");
  }
});

test("a valid upgraded proof with a matching (or absent) ots hash passes anchoring ONLY with a chain verification bound to it", () => {
  for (const otsHash of [FP, null]) {
    for (const proof of [ANCHORED_PROOF, upgradedProof({ withTransaction: false })]) {
      const anchoring = anchoringOf({
        otsStatus: "ANCHORED",
        otsHash,
        otsAnchoredAtUtc: "2026-05-02T11:00:00.000Z",
        otsProofBase64: proof.base64,
      });
      assert.equal(anchoring?.state, "PRESENT_NOT_INDEPENDENTLY_VERIFIED");
      assert.equal(toVerificationStatus(anchoring.state), "NOT_CHECKED");
      const verified = anchoringOf({
        otsStatus: "ANCHORED",
        otsHash,
        otsAnchoredAtUtc: "2026-05-02T11:00:00.000Z",
        otsProofBase64: proof.base64,
        ...chainColumnsFor(proof),
      });
      assert.equal(verified?.state, "PASSED");
      assert.equal(toVerificationStatus(verified.state), "VERIFIED");
    }
  }
});

test("no signal and no decision carries a point, a weight or a score", () => {
  const trustDecision = buildEvidenceTrustDecision({
    evidence: buildBaseEvidence({
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
      recordedIntegrityVerifiedAtUtc: "2026-05-02T10:00:00.000Z",
    }),
    custodyEvents: [buildForensicEvent(1), buildForensicEvent(2), buildForensicEvent(3), buildForensicEvent(4), buildForensicEvent(5)],
  });
  const json = JSON.stringify(trustDecision);
  assert.doesNotMatch(json, /"(score|maxScore|scoreLabel|points|maxPoints|verdict|relianceLevel|confidenceLabel|passedSignals|degradedSignals)"/);
  assert.doesNotMatch(json, /STRONGLY_VERIFIED|Passed signals|No degraded signals/);
});

// ---------------------------------------------------------------------------
// Flow-aware identity signal (Capture vs Secure Intake).
// ---------------------------------------------------------------------------
function identitySignal(decision) {
  return decision.signals.find((s) => s.key === "identity");
}

test("identity signal: authenticated Capture wording by default (no intake)", () => {
  const decision = buildEvidenceTrustDecision({
    evidence: buildBaseEvidence({ identityLevelSnapshot: "ORGANIZATION_ACCOUNT" }),
    custodyEvents: [buildForensicEvent(1)],
    // isIntake omitted → defaults to authenticated Capture.
  });
  const sig = identitySignal(decision);
  assert.equal(sig.summary, "Authenticated workspace user identity recorded");
  assert.ok(/authenticated workspace user/i.test(sig.detail));
  // Intake-only wording must NEVER appear for authenticated Capture.
  assert.ok(!/link creator/i.test(sig.detail));
  assert.ok(!/not independently verified/i.test(sig.detail));
  assert.ok(!/remote contributor/i.test(sig.detail));
});

test("identity signal: Secure Intake wording only when isIntake=true", () => {
  const decision = buildEvidenceTrustDecision({
    evidence: buildBaseEvidence({ identityLevelSnapshot: "ORGANIZATION_ACCOUNT" }),
    custodyEvents: [buildForensicEvent(1)],
    isIntake: true,
  });
  const sig = identitySignal(decision);
  assert.equal(sig.summary, "Workspace/link creator identity recorded");
  assert.ok(/link creator/i.test(sig.detail));
  assert.ok(/not independently verified/i.test(sig.detail));
});

test("anchoring signal uses the bitcoin_anchoring key (never public_anchoring)", () => {
  const decision = buildEvidenceTrustDecision({
    evidence: buildBaseEvidence(),
    custodyEvents: [buildForensicEvent(1)],
  });
  assert.ok(decision.signals.some((s) => s.key === "bitcoin_anchoring"));
  assert.ok(!decision.signals.some((s) => s.key === "public_anchoring"));
});
