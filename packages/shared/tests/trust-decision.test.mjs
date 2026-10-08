import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEvidenceTrustDecision,
  evaluateRecordedIntegrityPromotion,
  getTrustDecisionPresentationTone,
  toVerificationStatus,
} from "../dist/index.js";

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
    fingerprintHash: "b".repeat(64),
    signatureBase64: Buffer.from("signature-material").toString("base64"),
    signingKeyId: "sig-key-1",
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\nMIIBfake\n-----END PUBLIC KEY-----",
    tsaStatus: "STAMPED",
    tsaFailureReason: null,
    otsStatus: "PENDING",
    otsFailureReason: null,
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

test("an attested proof with a txid is present, not passed, until the chain check is recorded", () => {
  const decide = (otsAnchorCheck) =>
    buildEvidenceTrustDecision({
      evidence: buildBaseEvidence({
        otsStatus: "ANCHORED",
        otsBitcoinTxid: "c".repeat(64),
        otsAnchoredAtUtc: "2026-05-02T11:00:00.000Z",
        otsAnchorCheck,
      }),
      custodyEvents: [buildForensicEvent(1), buildForensicEvent(2), buildForensicEvent(3)],
    }).signals.find((signal) => signal.key === "bitcoin_anchoring");

  const unchecked = decide("PROOF_STRUCTURE");
  assert.equal(unchecked.state, "PRESENT_NOT_INDEPENDENTLY_VERIFIED");
  assert.equal(unchecked.status, "partial");
  assert.equal(toVerificationStatus(unchecked.state), "NOT_CHECKED");
  const verified = decide("BITCOIN_VERIFIED");
  assert.equal(verified.state, "PASSED");
  assert.equal(verified.status, "passed");
  assert.equal(toVerificationStatus(verified.state), "VERIFIED");
});

test("anchored without an anchor time is pending (the shared effective status)", () => {
  const trustDecision = buildEvidenceTrustDecision({
    evidence: buildBaseEvidence({
      otsStatus: "ANCHORED",
      otsBitcoinTxid: null,
      anchor: null,
    }),
    custodyEvents: [buildForensicEvent(1), buildForensicEvent(2), buildForensicEvent(3)],
  });

  const anchoring = trustDecision.signals.find(
    (signal) => signal.key === "bitcoin_anchoring"
  );

  assert.equal(anchoring?.state, "PENDING");
  assert.equal(toVerificationStatus(anchoring.state), "NOT_CHECKED");
});

test("pending ots yields pending anchoring signal", () => {
  const trustDecision = buildEvidenceTrustDecision({
    evidence: buildBaseEvidence({
      otsStatus: "PENDING",
    }),
    custodyEvents: [buildForensicEvent(1), buildForensicEvent(2), buildForensicEvent(3)],
  });

  const anchoring = trustDecision.signals.find(
    (signal) => signal.key === "bitcoin_anchoring"
  );

  assert.equal(anchoring?.status, "pending");
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
  assert.match(trustDecision.summary, /Any signal marked NOT_CHECKED was not independently verified\./);
  assert.match(trustDecision.reviewerAction, /Bitcoin anchoring has not completed/);
});

test("finalized publication requires a validated timestamp and a chain-verified anchor", () => {
  const decide = (otsAnchorCheck) =>
    buildEvidenceTrustDecision({
      evidence: buildBaseEvidence({
        verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
        recordedIntegrityVerifiedAtUtc: "2026-05-02T10:00:00.000Z",
        otsStatus: "ANCHORED",
        otsBitcoinTxid: "c".repeat(64),
        otsAnchoredAtUtc: "2026-05-02T11:00:00.000Z",
        otsAnchorCheck,
        signatureVerified: true,
        custodyChainValid: true,
      }),
      custodyEvents: [
        buildForensicEvent(1),
        buildForensicEvent(2),
        buildForensicEvent(3),
        buildForensicEvent(4),
        buildForensicEvent(5),
      ],
    });

  const finalized = decide("BITCOIN_VERIFIED");
  assert.equal(finalized.presentationState, "VERIFIED_FINALIZED");
  assert.equal(getTrustDecisionPresentationTone(finalized), "success");
  // No overall verdict, no score, no reliance level — the bounded summary only.
  for (const field of ["verdict", "verdictLabel", "score", "scoreLabel", "relianceLevel", "confidenceLabel", "primaryReason"]) {
    assert.equal(field in finalized, false, field);
  }
  assert.equal(
    finalized.summary,
    "Cryptographic integrity and PROOVRA custody checks passed for the preserved bytes. This record does not by itself establish authorship, factual truth, pre-PROOVRA history or legal admissibility.",
  );

  // The same record with a structure-only anchor is NOT finalized.
  const unchecked = decide("PROOF_STRUCTURE");
  assert.notEqual(unchecked.presentationState, "VERIFIED_FINALIZED");
  assert.match(unchecked.anchoringStatusLabel, /not independently chain-verified/);
  assert.match(unchecked.summary, /Any signal marked NOT_CHECKED was not independently verified\./);
  assert.match(unchecked.reviewerAction, /verify the OpenTimestamps proof against the Bitcoin chain yourself/);
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

test("ots hash mismatch blocks anchoring from passing even with a txid", () => {
  const trustDecision = buildEvidenceTrustDecision({
    evidence: buildBaseEvidence({
      otsStatus: "ANCHORED",
      otsHash: "d".repeat(64),
      otsBitcoinTxid: "c".repeat(64),
    }),
    custodyEvents: [buildForensicEvent(1), buildForensicEvent(2), buildForensicEvent(3)],
  });

  const anchoring = trustDecision.signals.find(
    (signal) => signal.key === "bitcoin_anchoring"
  );

  assert.equal(anchoring?.status, "failed");
  assert.equal(toVerificationStatus(anchoring.state), "FAILED");
});

test("malformed txid alone does not pass anchoring", () => {
  const trustDecision = buildEvidenceTrustDecision({
    evidence: buildBaseEvidence({
      otsStatus: "ANCHORED",
      otsBitcoinTxid: "not-a-valid-txid",
    }),
    custodyEvents: [buildForensicEvent(1), buildForensicEvent(2), buildForensicEvent(3)],
  });

  const anchoring = trustDecision.signals.find(
    (signal) => signal.key === "bitcoin_anchoring"
  );

  assert.equal(anchoring?.status, "failed");
  assert.equal(toVerificationStatus(anchoring.state), "FAILED");
});

test("valid txid with matching ots hash passes anchoring only with a recorded chain check", () => {
  for (const otsHash of ["b".repeat(64), null]) {
    const anchoring = buildEvidenceTrustDecision({
      evidence: buildBaseEvidence({
        otsStatus: "ANCHORED",
        otsHash,
        otsBitcoinTxid: "c".repeat(64),
        otsAnchoredAtUtc: "2026-05-02T11:00:00.000Z",
        otsAnchorCheck: "BITCOIN_VERIFIED",
      }),
      custodyEvents: [buildForensicEvent(1), buildForensicEvent(2), buildForensicEvent(3)],
    }).signals.find((signal) => signal.key === "bitcoin_anchoring");
    assert.equal(anchoring?.state, "PASSED");
    assert.equal(toVerificationStatus(anchoring.state), "VERIFIED");
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
