/**
 * THE CANONICAL TRUST-SIGNAL STATE CONTRACT.
 *
 * Every state, every projection: only PASSED is passed or reads VERIFIED; a
 * stored snapshot re-read through `resolveSnapshotSignalState` never claims
 * more than it was written with; and the TSA/OTS combinations present exactly
 * what was checked — with no score anywhere.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  TRUST_SIGNAL_STATES,
  TRUST_SIGNAL_STATE_PRESENTATION,
  buildEvidenceTrustDecision,
  getTrustSignalPresentationLabel,
  resolveOtsTrustState,
  resolveSnapshotSignalState,
  resolveTsaTrustState,
  toVerificationStatus,
  trustSignalStateIsPassed,
} from "../dist/index.js";

import { REAL, chainColumnsFor, chainRecordFor, upgradedProof } from "./helpers/ots-fixtures.mjs";

/**
 * (2026-10-13) The OTS signal is the canonical anchoring state resolved from
 * real proof bytes: the `ots stamp` proof is PENDING; ANCHORED only from an
 * upgraded proof (tests/helpers/ots-fixtures.mjs). An ANCHORED proof only
 * NAMES a block: PRESENT_NOT_INDEPENDENTLY_VERIFIED; only a chain fact bound
 * to the proof (VERIFIED) makes it PASSED. PENDING→PENDING, FAILED→FAILED, NOT_REQUESTED→NOT_APPLICABLE,
 * UNAVAILABLE→UNAVAILABLE.
 */
const FP = REAL.boundFingerprintHash;
const ANCHORED_PROOF = upgradedProof();

test("every state has one presentation, and only PASSED is a passed signal", () => {
  assert.deepEqual([...TRUST_SIGNAL_STATES].sort(), [
    "FAILED",
    "NOT_APPLICABLE",
    "NOT_CHECKED",
    "PASSED",
    "PENDING",
    "PRESENT_NOT_INDEPENDENTLY_VERIFIED",
    "STALE",
    "UNAVAILABLE",
  ]);
  for (const state of TRUST_SIGNAL_STATES) {
    const p = TRUST_SIGNAL_STATE_PRESENTATION[state];
    assert.ok(p, state);
    assert.equal(p.countsAsPassed, state === "PASSED", state);
    assert.equal(trustSignalStateIsPassed(state), state === "PASSED", state);
    assert.equal(p.legacyStatus === "passed", state === "PASSED", state);
    assert.equal(p.label === "Verified", state === "PASSED", state);
    assert.equal(p.tone === "success", state === "PASSED", state);
    // Neither passed nor degraded is reserved for the informational state.
    assert.equal(!p.countsAsPassed && !p.countsAsDegraded, state === "NOT_APPLICABLE", state);
    // An explicit state survives a snapshot round trip unchanged.
    assert.equal(resolveSnapshotSignalState({ key: "trusted_timestamp", state, status: p.legacyStatus }), state);
    assert.equal(getTrustSignalPresentationLabel({ state, status: p.legacyStatus, tone: "neutral" }), p.label);
    // The customer-facing status: VERIFIED for PASSED, and only PASSED.
    assert.equal(toVerificationStatus(state) === "VERIFIED", state === "PASSED", state);
  }
  assert.equal(toVerificationStatus("PRESENT_NOT_INDEPENDENTLY_VERIFIED"), "NOT_CHECKED");
  assert.equal(toVerificationStatus("PENDING"), "NOT_CHECKED");
  assert.equal(toVerificationStatus("STALE"), "NOT_CHECKED");
});

test("legacy snapshots without a state are re-read conservatively", () => {
  // A legacy anchoring "passed" was awarded for a txid on the row, not for a
  // proof executed to a Bitcoin attestation: it reads UNAVAILABLE, never anchored.
  assert.equal(
    resolveSnapshotSignalState({
      key: "bitcoin_anchoring",
      status: "passed",
      summary: "OpenTimestamps proof anchored to a Bitcoin block; not checked against the Bitcoin chain",
    }),
    "UNAVAILABLE",
  );
  assert.equal(resolveSnapshotSignalState({ key: "bitcoin_anchoring", status: "passed", summary: "Anchored in Bitcoin" }), "UNAVAILABLE");
  // An explicit PASSED stored before independent chain verification existed
  // is an attestation the proof named — present, never verified. Only a
  // snapshot that marks the chain verification keeps PASSED.
  assert.equal(resolveSnapshotSignalState({ key: "bitcoin_anchoring", state: "PASSED", status: "passed" }), "PRESENT_NOT_INDEPENDENTLY_VERIFIED");
  assert.equal(
    resolveSnapshotSignalState({ key: "bitcoin_anchoring", state: "PASSED", status: "passed", otsVerification: "ATTESTATION_RECORDED" }),
    "PRESENT_NOT_INDEPENDENTLY_VERIFIED",
  );
  assert.equal(resolveSnapshotSignalState({ key: "bitcoin_anchoring", state: "PASSED", status: "passed", otsVerification: "CHAIN_VERIFIED" }), "PASSED");
  assert.equal(resolveSnapshotSignalState({ key: "bitcoin_anchoring", status: "pending" }), "PENDING");
  assert.equal(resolveSnapshotSignalState({ key: "bitcoin_anchoring", status: "failed" }), "FAILED");
  assert.equal(resolveSnapshotSignalState({ key: "verification_package", status: "passed" }), "NOT_APPLICABLE");
  assert.equal(resolveSnapshotSignalState({ key: "trusted_timestamp", status: "passed" }), "PRESENT_NOT_INDEPENDENTLY_VERIFIED");
  assert.equal(resolveSnapshotSignalState({ key: "trusted_timestamp", status: "partial" }), "PRESENT_NOT_INDEPENDENTLY_VERIFIED");
  assert.equal(resolveSnapshotSignalState({ key: "identity", status: "missing" }), "UNAVAILABLE");
  assert.notEqual(
    getTrustSignalPresentationLabel({ key: "bitcoin_anchoring", status: "passed", tone: "success", summary: "anchored; not checked against the Bitcoin chain" }),
    "Verified",
  );
});

test("TSA: only a validated token is PASSED; a kept token without an anchor is present", () => {
  assert.equal(resolveTsaTrustState({ presentedStatus: "STAMPED", validatedAtUtc: "2026-10-07T00:00:00Z" }).state, "PASSED");
  assert.equal(resolveTsaTrustState({ presentedStatus: "STAMPED", validatedAtUtc: "2026-10-07T00:00:00Z" }).measuredAtUtc, "2026-10-07T00:00:00.000Z");
  assert.equal(resolveTsaTrustState({ presentedStatus: "RECORDED_NOT_VALIDATED" }).state, "PRESENT_NOT_INDEPENDENTLY_VERIFIED");
  const kept = resolveTsaTrustState({ presentedStatus: "FAILED", tokenPresent: true, failureCode: "tsa_trust_anchor_not_configured" });
  assert.equal(kept.state, "PRESENT_NOT_INDEPENDENTLY_VERIFIED");
  assert.doesNotMatch(kept.label, /not obtained/i);
  for (const code of ["tsa_token_untrusted", "tsa_token_signature_invalid", "tsa_nonce_mismatch", "tsa_message_imprint_mismatch", "tsa_policy_not_accepted"]) {
    assert.equal(resolveTsaTrustState({ presentedStatus: "FAILED", tokenPresent: true, failureCode: code }).state, "FAILED", code);
  }
  assert.equal(resolveTsaTrustState({ presentedStatus: "FAILED", tokenPresent: false, failureCode: "tsa_provider_unreachable" }).state, "UNAVAILABLE");
  assert.equal(resolveTsaTrustState({ presentedStatus: "PENDING" }).state, "PENDING");
  assert.equal(resolveTsaTrustState({ presentedStatus: null }).state, "UNAVAILABLE");
});

test("OTS: the state comes from the proof bytes; only a valid upgraded proof is PASSED", () => {
  const ots = (over) => resolveOtsTrustState({ status: "ANCHORED", fingerprintHash: FP, ...over });
  // A valid upgraded proof with no chain check: ANCHORED, an attestation
  // recorded — present, NOT independently verified, measured at PROOVRA's recording time.
  const anchored = ots({ proofBase64: ANCHORED_PROOF.base64, anchoredAtUtc: "2026-10-02T00:00:00Z" });
  assert.equal(anchored.state, "PRESENT_NOT_INDEPENDENTLY_VERIFIED");
  assert.equal(anchored.otsState, "ANCHORED");
  assert.equal(anchored.otsVerification, "ATTESTATION_RECORDED");
  assert.equal(anchored.label, `The proof names Bitcoin block ${ANCHORED_PROOF.blockHeight}; PROOVRA has not checked it against the Bitcoin main chain.`);
  assert.equal(anchored.measuredAtUtc, "2026-10-02T00:00:00.000Z");
  // The same proof WITH a chain verification bound to it: the only PASSED.
  const verified = ots({ proofBase64: ANCHORED_PROOF.base64, anchoredAtUtc: "2026-10-02T00:00:00Z", chain: chainRecordFor(ANCHORED_PROOF) });
  assert.equal(verified.state, "PASSED");
  assert.equal(verified.otsVerification, "CHAIN_VERIFIED");
  assert.equal(verified.measuredAtUtc, "2026-10-15T08:00:00.000Z");
  // A chain record about ANOTHER proof is ignored — never borrowed.
  const borrowed = ots({ proofBase64: ANCHORED_PROOF.base64, chain: chainRecordFor(ANCHORED_PROOF, { proofSha256: "f".repeat(64) }) });
  assert.equal(borrowed.state, "PRESENT_NOT_INDEPENDENTLY_VERIFIED");
  // Pending confirmations, verifier unavailable and a chain contradiction are never PASSED.
  assert.equal(ots({ proofBase64: ANCHORED_PROOF.base64, chain: chainRecordFor(ANCHORED_PROOF, { status: "INSUFFICIENT_CONFIRMATIONS" }) }).state, "PENDING");
  assert.equal(ots({ proofBase64: ANCHORED_PROOF.base64, chain: chainRecordFor(ANCHORED_PROOF, { status: "UNAVAILABLE" }) }).state, "UNAVAILABLE");
  assert.equal(ots({ proofBase64: ANCHORED_PROOF.base64, chain: chainRecordFor(ANCHORED_PROOF, { status: "FAILED" }) }).state, "FAILED");
  // Status ANCHORED + anchored-at over the real pending proof: PENDING, no measured time.
  const claimed = ots({ proofBase64: REAL.boundProofBase64, anchoredAtUtc: "2026-10-01T00:00:00Z" });
  assert.equal(claimed.state, "PENDING");
  assert.equal(claimed.otsState, "PENDING");
  assert.equal(claimed.measuredAtUtc, null);
  // A long-pending proof is still PENDING: there is no STALE for OTS.
  assert.equal(
    resolveOtsTrustState({ status: "PENDING", proofBase64: REAL.boundProofBase64, fingerprintHash: FP, submittedAtUtc: "2020-01-01T00:00:00Z" }).state,
    "PENDING",
  );
  // FAILED from a proof defect or a recorded failure; UNAVAILABLE without proof material; NOT_APPLICABLE when not requested.
  assert.equal(ots({ proofBase64: REAL.otherProofBase64 }).state, "FAILED");
  assert.equal(resolveOtsTrustState({ status: "FAILED", proofBase64: null, fingerprintHash: FP }).state, "FAILED");
  assert.equal(ots({ proofBase64: null }).state, "UNAVAILABLE");
  assert.equal(ots({ proofBase64: ANCHORED_PROOF.base64, fingerprintHash: null }).state, "UNAVAILABLE");
  assert.equal(resolveOtsTrustState({ status: null, proofBase64: null, fingerprintHash: FP }).state, "NOT_APPLICABLE");
  assert.equal(resolveOtsTrustState({ status: "DISABLED", proofBase64: null, fingerprintHash: FP }).state, "NOT_APPLICABLE");
});

// ---------------------------------------------------------------------------
// Mixed combinations through the ONE decision builder.
// ---------------------------------------------------------------------------

const forensic = Array.from({ length: 6 }, (_, i) => ({
  eventType: `FORENSIC_${i}`,
  category: "forensic",
  prevEventHash: i ? `h${i - 1}` : null,
  eventHash: `h${i}`,
}));

function decide(overrides) {
  return buildEvidenceTrustDecision({
    evidence: {
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
      recordedIntegrityVerifiedAtUtc: "2026-10-01T00:00:00.000Z",
      fileSha256: "a".repeat(64),
      fingerprintHash: FP,
      signatureBase64: "c2ln",
      signingKeyId: "k1",
      publicKeyPem: "-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----",
      signatureVerified: true,
      custodyChainValid: true,
      tsaStatus: "STAMPED",
      tsaValidatedAtUtc: "2026-10-01T00:00:01.000Z",
      storageImmutable: true,
      storageObjectLockMode: "COMPLIANCE",
      storageObjectLockRetainUntilUtc: "2036-01-01T00:00:00.000Z",
      identityLevelSnapshot: "VERIFIED_EMAIL",
      submittedByAuthProvider: "EMAIL",
      otsStatus: "PENDING",
      otsProofBase64: REAL.boundProofBase64,
      ...overrides,
    },
    custodyEvents: forensic,
  });
}

function anchoring(d) {
  return d.signals.find((s) => s.key === "bitcoin_anchoring");
}

function assertNoOverclaim(d) {
  for (const s of d.signals) {
    if (s.state !== "PASSED") {
      assert.notEqual(s.status, "passed", s.key);
      assert.notEqual(getTrustSignalPresentationLabel(s), "Verified", s.key);
      assert.notEqual(toVerificationStatus(s.state), "VERIFIED", s.key);
    }
    assert.equal("points" in s, false, s.key);
  }
  for (const field of ["verdict", "score", "relianceLevel", "primaryReason", "passedSignals"]) {
    assert.equal(field in d, false, field);
  }
  assert.doesNotMatch(d.summary, /STRONGLY|score|Passed signals|No degraded signals/i);
}

test("TSA valid + OTS pending → anchoring PENDING (NOT_CHECKED), never finalized", () => {
  const d = decide({ otsStatus: "PENDING", otsProofBase64: REAL.boundProofBase64, otsUpgradedAtUtc: "2026-10-01T01:00:00Z" });
  assert.equal(anchoring(d).state, "PENDING");
  assert.equal(d.anchoringState, "pending");
  assert.equal(d.presentationState, "VERIFIED_PENDING_ANCHORING");
  assert.equal(toVerificationStatus(anchoring(d).state), "NOT_CHECKED");
  assertNoOverclaim(d);
});

test("TSA valid + stored ANCHORED status over a pending proof → PENDING, no anchored claim", () => {
  const d = decide({ otsStatus: "ANCHORED", otsAnchoredAtUtc: "2026-10-01T02:00:00Z", otsProofBase64: REAL.boundProofBase64 });
  assert.equal(anchoring(d).state, "PENDING");
  assert.equal(d.anchoringState, "pending");
  assert.equal(toVerificationStatus(anchoring(d).state), "NOT_CHECKED");
  assert.notEqual(d.presentationState, "VERIFIED_FINALIZED");
  assert.equal(d.anchoringStatusLabel, "Pending");
  assert.match(d.summary, /Any signal marked “Not checked” was not independently verified\./);
  // The OTS card says it once; the reviewer action does not repeat it.
  assert.doesNotMatch(d.reviewerAction, /Bitcoin|OpenTimestamps/);
  assertNoOverclaim(d);
});

test("TSA valid + OTS attestation recorded but NOT chain-checked → not verified, not passed, never finalized", () => {
  const d = decide({ otsStatus: "ANCHORED", otsAnchoredAtUtc: "2026-10-01T02:00:00Z", otsProofBase64: ANCHORED_PROOF.base64 });
  assert.equal(anchoring(d).state, "PRESENT_NOT_INDEPENDENTLY_VERIFIED");
  assert.equal(anchoring(d).otsVerification, "ATTESTATION_RECORDED");
  assert.equal(toVerificationStatus(anchoring(d).state), "NOT_CHECKED");
  assert.notEqual(getTrustSignalPresentationLabel(anchoring(d)), "Verified");
  assert.equal(d.anchoringState, "recorded");
  assert.equal(d.anchoringStatusLabel, "Attestation recorded");
  assert.notEqual(d.presentationState, "VERIFIED_FINALIZED");
  assert.notEqual(d.tone, "success");
  assertNoOverclaim(d);
});

test("TSA valid + OTS independently verified against the Bitcoin main chain → every time layer VERIFIED and finalized", () => {
  const d = decide({
    otsStatus: "ANCHORED",
    otsAnchoredAtUtc: "2026-10-01T02:00:00Z",
    otsProofBase64: ANCHORED_PROOF.base64,
    ...chainColumnsFor(ANCHORED_PROOF),
  });
  assert.equal(anchoring(d).state, "PASSED");
  assert.equal(anchoring(d).otsVerification, "CHAIN_VERIFIED");
  assert.equal(anchoring(d).measuredAtUtc, "2026-10-15T08:00:00.000Z");
  assert.equal(toVerificationStatus(anchoring(d).state), "VERIFIED");
  assert.equal(d.anchoringState, "verified");
  assert.equal(d.anchoringStatusLabel, "Independently verified");
  assert.equal(d.presentationState, "VERIFIED_FINALIZED");
  assertNoOverclaim(d);
});

test("an upgraded proof with NO transaction step is chain-verifiable; the txid is never what decides", () => {
  const p = upgradedProof({ withTransaction: false });
  const unchecked = decide({ otsStatus: "ANCHORED", otsAnchoredAtUtc: "2026-10-01T02:00:00Z", otsProofBase64: p.base64 });
  assert.equal(anchoring(unchecked).state, "PRESENT_NOT_INDEPENDENTLY_VERIFIED");
  const d = decide({ otsStatus: "ANCHORED", otsAnchoredAtUtc: "2026-10-01T02:00:00Z", otsProofBase64: p.base64, ...chainColumnsFor(p) });
  assert.equal(anchoring(d).state, "PASSED");
  assert.equal(d.presentationState, "VERIFIED_FINALIZED");
  assertNoOverclaim(d);
});

test("OTS unavailable / failed / not requested never read as verified", () => {
  for (const [overrides, state] of [
    [{ otsStatus: null, otsProofBase64: null }, "NOT_APPLICABLE"],
    [{ otsStatus: "DISABLED", otsProofBase64: null }, "NOT_APPLICABLE"],
    [{ otsStatus: "ANCHORED", otsProofBase64: null }, "UNAVAILABLE"],
    [{ otsStatus: "FAILED", otsProofBase64: null }, "FAILED"],
    [{ otsStatus: "ANCHORED", otsProofBase64: REAL.otherProofBase64 }, "FAILED"],
    [{ otsStatus: "ANCHORED", otsProofBase64: upgradedProof({ trailingPayload: Buffer.from([1]) }).base64 }, "FAILED"],
    [{ otsStatus: "PENDING", otsProofBase64: REAL.boundProofBase64 }, "PENDING"],
  ]) {
    const d = decide(overrides);
    assert.equal(anchoring(d).state, state, JSON.stringify(overrides).slice(0, 80));
    assert.notEqual(d.presentationState, "VERIFIED_FINALIZED");
    assertNoOverclaim(d);
  }
});

test("a validated timestamp with an unvalidated token elsewhere: kept token never passes", () => {
  const d = decide({ tsaStatus: "STAMPED", tsaValidatedAtUtc: null });
  const tsa = d.signals.find((s) => s.key === "trusted_timestamp");
  assert.equal(tsa.state, "PRESENT_NOT_INDEPENDENTLY_VERIFIED");
  assertNoOverclaim(d);
  const kept = decide({ tsaStatus: "FAILED", tsaValidatedAtUtc: null, tsaTokenPresent: true, tsaFailureCode: "tsa_trust_anchor_not_configured" });
  assert.equal(kept.signals.find((s) => s.key === "trusted_timestamp").state, "PRESENT_NOT_INDEPENDENTLY_VERIFIED");
  assertNoOverclaim(kept);
});

test("signature and custody are PASSED only when checked in the evaluation", () => {
  const unchecked = decide({ signatureVerified: undefined, custodyChainValid: undefined });
  assert.equal(unchecked.signals.find((s) => s.key === "signature").state, "NOT_CHECKED");
  assert.equal(unchecked.signals.find((s) => s.key === "custody_chain").state, "NOT_CHECKED");
  assertNoOverclaim(unchecked);
  const bad = decide({ signatureVerified: false });
  assert.equal(bad.signals.find((s) => s.key === "signature").state, "FAILED");
  assert.equal(bad.integrityReviewRequired, true);
  assert.match(bad.summary, /^Failed: Record signature./);
});

test("identity wording names the real sign-in method, never OAuth for an email account", () => {
  const email = decide({ submittedByAuthProvider: "EMAIL" }).signals.find((s) => s.key === "identity");
  assert.doesNotMatch(email.detail, /oauth/i);
  assert.match(email.detail, /email-and-password account/);
  const google = decide({ submittedByAuthProvider: "GOOGLE" }).signals.find((s) => s.key === "identity");
  assert.match(google.detail, /Google sign-in/);
  // Only a verified organization at capture is PASSED.
  assert.equal(decide({ identityLevelSnapshot: "ORGANIZATION_ACCOUNT" }).signals.find((s) => s.key === "identity").state, "PRESENT_NOT_INDEPENDENTLY_VERIFIED");
  assert.equal(decide({ identityLevelSnapshot: "VERIFIED_ORGANIZATION" }).signals.find((s) => s.key === "identity").state, "PASSED");
});
