/**
 * THE CANONICAL TRUST-SIGNAL STATE CONTRACT.
 *
 * Every state, every projection: only PASSED is passed, gets full points or
 * reads "Verified"; a stored snapshot re-read through
 * `resolveSnapshotSignalState` keeps the meaning it was written with; and the
 * TSA/OTS combinations score and present exactly what was checked.
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
  serializeTrustDecisionForReviewerPackage,
  trustSignalStateIsPassed,
} from "../dist/index.js";

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
  }
});

test("legacy snapshots without a state are re-read conservatively", () => {
  assert.equal(
    resolveSnapshotSignalState({
      key: "bitcoin_anchoring",
      status: "passed",
      summary: "OpenTimestamps proof anchored to a Bitcoin block; not checked against the Bitcoin chain",
    }),
    "PRESENT_NOT_INDEPENDENTLY_VERIFIED",
  );
  assert.equal(resolveSnapshotSignalState({ key: "verification_package", status: "passed" }), "NOT_APPLICABLE");
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

test("OTS: an attestation is present; only a recorded chain check is PASSED; long pending is STALE", () => {
  const base = { status: "ANCHORED", anchoredAtUtc: "2026-10-01T00:00:00Z", bitcoinTxid: "c".repeat(64) };
  assert.equal(resolveOtsTrustState({ ...base, anchorCheck: "PROOF_STRUCTURE" }).state, "PRESENT_NOT_INDEPENDENTLY_VERIFIED");
  assert.equal(resolveOtsTrustState({ ...base, anchorCheck: null }).state, "PRESENT_NOT_INDEPENDENTLY_VERIFIED");
  const verified = resolveOtsTrustState({ ...base, anchorCheck: "BITCOIN_VERIFIED", anchorCheckedAtUtc: "2026-10-02T00:00:00Z" });
  assert.equal(verified.state, "PASSED");
  assert.equal(verified.measuredAtUtc, "2026-10-02T00:00:00.000Z");
  const now = new Date("2026-10-20T00:00:00Z");
  assert.equal(resolveOtsTrustState({ status: "PENDING", anchoredAtUtc: null, anchorCheck: null, submittedAtUtc: "2026-10-19T00:00:00Z", now }).state, "PENDING");
  assert.equal(resolveOtsTrustState({ status: "PENDING", anchoredAtUtc: null, anchorCheck: null, submittedAtUtc: "2026-10-01T00:00:00Z", now }).state, "STALE");
  assert.equal(resolveOtsTrustState({ status: "FAILED", anchoredAtUtc: null, anchorCheck: null }).state, "FAILED");
  assert.equal(resolveOtsTrustState({ status: null, anchoredAtUtc: null, anchorCheck: null }).state, "UNAVAILABLE");
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
      fingerprintHash: "b".repeat(64),
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
      if (s.maxPoints > 0) assert.ok(s.points < s.maxPoints, `${s.key} ${s.state} ${s.points}/${s.maxPoints}`);
    }
  }
  const passed = d.signals.filter((s) => s.state === "PASSED").map((s) => s.label);
  for (const s of d.signals.filter((x) => x.state !== "PASSED" && x.state !== "NOT_APPLICABLE")) {
    assert.ok(!d.primaryReason.split("Degraded signals:")[0].includes(s.label), `${s.label} listed as passed`);
  }
  assert.equal(d.passedSignals, passed.length);
  if (d.signals.some((s) => TRUST_SIGNAL_STATE_PRESENTATION[s.state].countsAsDegraded)) {
    assert.doesNotMatch(d.primaryReason, /No degraded signals/);
  }
  // The reviewer package carries the same states.
  const pkg = serializeTrustDecisionForReviewerPackage(d);
  assert.deepEqual(pkg.signals.map((s) => s.state), d.signals.map((s) => s.state));
}

test("TSA valid + OTS pending → VERIFIED, anchoring pending, never finalized", () => {
  const d = decide({ otsStatus: "PENDING", otsProofPresent: true, otsUpgradedAtUtc: "2026-10-01T01:00:00Z", otsSubmittedAtUtc: new Date().toISOString() });
  assert.equal(anchoring(d).state, "PENDING");
  assert.equal(d.presentationState, "VERIFIED_PENDING_ANCHORING");
  assert.equal(d.verdict, "VERIFIED");
  assertNoOverclaim(d);
});

test("TSA valid + OTS proof present, not checked → no verified claim, no full points", () => {
  const d = decide({ otsStatus: "ANCHORED", otsAnchoredAtUtc: "2026-10-01T02:00:00Z", otsBitcoinTxid: "c".repeat(64), otsAnchorCheck: "PROOF_STRUCTURE" });
  assert.equal(anchoring(d).state, "PRESENT_NOT_INDEPENDENTLY_VERIFIED");
  assert.equal(d.anchoringState, "present_not_verified");
  assert.notEqual(d.verdict, "STRONGLY_VERIFIED");
  assert.notEqual(d.presentationState, "VERIFIED_FINALIZED");
  assert.equal(d.anchoringStatusLabel, "Anchoring proof present; not independently chain-verified");
  assert.match(d.summary, /not been independently checked against the Bitcoin chain/);
  assertNoOverclaim(d);
});

test("TSA valid + OTS independently verified → STRONGLY_VERIFIED and finalized", () => {
  const d = decide({
    otsStatus: "ANCHORED",
    otsAnchoredAtUtc: "2026-10-01T02:00:00Z",
    otsBitcoinTxid: "c".repeat(64),
    otsAnchorCheck: "BITCOIN_VERIFIED",
    otsAnchorCheckedAtUtc: "2026-10-01T03:00:00Z",
  });
  assert.equal(anchoring(d).state, "PASSED");
  assert.equal(anchoring(d).measuredAtUtc, "2026-10-01T03:00:00.000Z");
  assert.equal(d.verdict, "STRONGLY_VERIFIED");
  assert.equal(d.presentationState, "VERIFIED_FINALIZED");
  assert.ok(d.score >= 90 && d.score < 100, String(d.score)); // identity is present, not passed
  assertNoOverclaim(d);
});

test("OTS unavailable / failed / stale never read as verified", () => {
  for (const [overrides, state] of [
    [{ otsStatus: null }, "UNAVAILABLE"],
    [{ otsStatus: "DISABLED" }, "UNAVAILABLE"],
    [{ otsStatus: "FAILED" }, "FAILED"],
    [{ otsStatus: "PENDING", otsProofPresent: true, otsSubmittedAtUtc: "2020-01-01T00:00:00Z" }, "STALE"],
  ]) {
    const d = decide(overrides);
    assert.equal(anchoring(d).state, state, JSON.stringify(overrides));
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
  assert.equal(bad.verdict, "REVIEW_REQUIRED");
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
