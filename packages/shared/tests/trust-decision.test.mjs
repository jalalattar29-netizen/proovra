import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEvidenceTrustDecision,
  evaluateRecordedIntegrityPromotion,
  getTrustDecisionConfidenceLabel,
  getTrustDecisionPresentationTone,
  serializeTrustDecisionForReviewerPackage,
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
  assert.equal(custodySignal.points, 6);
  assert.equal(custodySignal.summary, "3 forensic events recorded");
});

test("anchored with valid ots bitcoin txid passes public anchoring", () => {
  const trustDecision = buildEvidenceTrustDecision({
    evidence: buildBaseEvidence({
      otsStatus: "ANCHORED",
      otsBitcoinTxid: "c".repeat(64),
    }),
    custodyEvents: [buildForensicEvent(1), buildForensicEvent(2), buildForensicEvent(3)],
  });

  const anchoring = trustDecision.signals.find(
    (signal) => signal.key === "public_anchoring"
  );

  assert.equal(anchoring?.status, "passed");
  assert.equal(anchoring?.points, 10);
});

test("anchored without defensible public material stays partial", () => {
  const trustDecision = buildEvidenceTrustDecision({
    evidence: buildBaseEvidence({
      otsStatus: "ANCHORED",
      otsBitcoinTxid: null,
      anchor: null,
    }),
    custodyEvents: [buildForensicEvent(1), buildForensicEvent(2), buildForensicEvent(3)],
  });

  const anchoring = trustDecision.signals.find(
    (signal) => signal.key === "public_anchoring"
  );

  assert.equal(anchoring?.status, "partial");
  assert.equal(anchoring?.points, 6);
});

test("pending ots yields pending anchoring signal", () => {
  const trustDecision = buildEvidenceTrustDecision({
    evidence: buildBaseEvidence({
      otsStatus: "PENDING",
    }),
    custodyEvents: [buildForensicEvent(1), buildForensicEvent(2), buildForensicEvent(3)],
  });

  const anchoring = trustDecision.signals.find(
    (signal) => signal.key === "public_anchoring"
  );

  assert.equal(anchoring?.status, "pending");
  assert.equal(anchoring?.points, 4);
});

test("pending publication degrades presentation tone and confidence label", () => {
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

  assert.equal(trustDecision.presentationState, "VERIFIED_PENDING_PUBLICATION");
  assert.equal(getTrustDecisionPresentationTone(trustDecision), "warning");
  assert.equal(getTrustDecisionConfidenceLabel(trustDecision), "High (Pending publication)");
  assert.match(trustDecision.verdictLabel, /publication pending/i);
});

test("finalized publication can retain a success presentation tone", () => {
  const trustDecision = buildEvidenceTrustDecision({
    evidence: buildBaseEvidence({
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
      recordedIntegrityVerifiedAtUtc: "2026-05-02T10:00:00.000Z",
      otsStatus: "ANCHORED",
      otsBitcoinTxid: "c".repeat(64),
      anchor: {
        transactionId: "c".repeat(64),
      },
    }),
    custodyEvents: [
      buildForensicEvent(1),
      buildForensicEvent(2),
      buildForensicEvent(3),
      buildForensicEvent(4),
      buildForensicEvent(5),
    ],
  });

  assert.equal(trustDecision.presentationState, "VERIFIED_FINALIZED");
  assert.equal(getTrustDecisionPresentationTone(trustDecision), "success");
  assert.equal(getTrustDecisionConfidenceLabel(trustDecision), "High");
  assert.equal(trustDecision.verdictLabel, "Recorded integrity verified");
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
    (signal) => signal.key === "public_anchoring"
  );

  assert.equal(anchoring?.status, "failed");
  assert.equal(anchoring?.points, 2);
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
    (signal) => signal.key === "public_anchoring"
  );

  assert.equal(anchoring?.status, "failed");
  assert.equal(anchoring?.points, 2);
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
    (signal) => signal.key === "public_anchoring"
  );

  assert.equal(anchoring?.status, "failed");
  assert.equal(anchoring?.points, 2);
});

test("valid txid with matching ots hash passes anchoring", () => {
  const trustDecision = buildEvidenceTrustDecision({
    evidence: buildBaseEvidence({
      otsStatus: "ANCHORED",
      otsHash: "b".repeat(64),
      otsBitcoinTxid: "c".repeat(64),
    }),
    custodyEvents: [buildForensicEvent(1), buildForensicEvent(2), buildForensicEvent(3)],
  });

  const anchoring = trustDecision.signals.find(
    (signal) => signal.key === "public_anchoring"
  );

  assert.equal(anchoring?.status, "passed");
  assert.equal(anchoring?.points, 10);
});

test("valid txid with missing ots hash can still pass anchoring", () => {
  const trustDecision = buildEvidenceTrustDecision({
    evidence: buildBaseEvidence({
      otsStatus: "ANCHORED",
      otsHash: null,
      otsBitcoinTxid: "c".repeat(64),
    }),
    custodyEvents: [buildForensicEvent(1), buildForensicEvent(2), buildForensicEvent(3)],
  });

  const anchoring = trustDecision.signals.find(
    (signal) => signal.key === "public_anchoring"
  );

  assert.equal(anchoring?.status, "passed");
  assert.equal(anchoring?.points, 10);
});

test("reviewer package trust serialization omits numeric score fields by default", () => {
  const trustDecision = buildEvidenceTrustDecision({
    evidence: buildBaseEvidence({
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
      recordedIntegrityVerifiedAtUtc: "2026-05-02T10:00:00.000Z",
    }),
    custodyEvents: [
      buildForensicEvent(1),
      buildForensicEvent(2),
      buildForensicEvent(3),
      buildForensicEvent(4),
      buildForensicEvent(5),
    ],
  });

  const serialized = serializeTrustDecisionForReviewerPackage(trustDecision);

  assert.equal("score" in serialized, false);
  assert.equal("scoreLabel" in serialized, false);
  assert.equal("maxScore" in serialized, false);
  assert.equal("internalDebug" in serialized, false);
  assert.ok(Array.isArray(serialized.signals));
  assert.equal("points" in serialized.signals[0], false);
  assert.equal("maxPoints" in serialized.signals[0], false);
});

test("reviewer package trust serialization includes internal debug only when enabled", () => {
  const trustDecision = buildEvidenceTrustDecision({
    evidence: buildBaseEvidence(),
    custodyEvents: [buildForensicEvent(1), buildForensicEvent(2), buildForensicEvent(3)],
  });

  const serialized = serializeTrustDecisionForReviewerPackage(trustDecision, {
    includeInternalDebug: true,
  });

  assert.ok(serialized.internalDebug);
  assert.equal(serialized.internalDebug.scoreLabel, trustDecision.scoreLabel);
  assert.equal(
    serialized.internalDebug.signals[0].points,
    trustDecision.signals[0].points
  );
});
