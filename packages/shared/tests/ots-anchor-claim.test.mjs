/**
 * THE ONE OTS CLAIM (2026-09-29).
 *
 * `resolveOtsAnchorClaim` decides what any surface may say about Bitcoin
 * anchoring. "Verified" requires an anchor verified against the Bitcoin chain
 * (ots_anchor_check = BITCOIN_VERIFIED); a status string, a txid, an anchored-at
 * time, a pending operation or a proof merely being present never suffices.
 * Public Verify's basic tier, anchor semantics (package manifest) and the trust
 * decision all read it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildBasicVerification,
  buildEvidenceTrustDecision,
  deriveAnchorSemantics,
  isPublicAnchoringVerified,
  OTS_ANCHOR_CLAIM_LABELS,
  resolveOtsAnchorClaim,
} from "../dist/index.js";

const TXID = "a".repeat(64);
const AT = "2026-09-20T10:00:00.000Z";

test("VERIFIED only for an anchored record whose anchor was verified against the chain", () => {
  assert.equal(resolveOtsAnchorClaim({ status: "ANCHORED", anchoredAtUtc: AT, anchorCheck: "BITCOIN_VERIFIED" }), "VERIFIED");
  assert.equal(
    resolveOtsAnchorClaim({ status: "ANCHORED", anchoredAtUtc: AT, anchorCheck: "PROOF_STRUCTURE" }),
    "ANCHORED_NOT_CHECKED",
  );
  // Historical rows: anchored, check never recorded.
  assert.equal(resolveOtsAnchorClaim({ status: "ANCHORED", anchoredAtUtc: AT, anchorCheck: null }), "ANCHORED_NOT_CHECKED");
  // An ANCHORED label without an anchor time is not an anchor at all.
  assert.equal(resolveOtsAnchorClaim({ status: "ANCHORED", anchoredAtUtc: null, anchorCheck: "BITCOIN_VERIFIED" }), "PENDING");
  assert.equal(resolveOtsAnchorClaim({ status: "PENDING", anchoredAtUtc: null, anchorCheck: null }), "PENDING");
  assert.equal(resolveOtsAnchorClaim({ status: "FAILED", anchoredAtUtc: null, anchorCheck: null, proofPresent: true }), "FAILED");
  assert.equal(resolveOtsAnchorClaim({ status: null, anchoredAtUtc: null, anchorCheck: null, proofPresent: true }), "PENDING");
  assert.equal(resolveOtsAnchorClaim({ status: "DISABLED", anchoredAtUtc: null, anchorCheck: null }), "UNAVAILABLE");
  // An unknown check string is not a check.
  assert.equal(resolveOtsAnchorClaim({ status: "ANCHORED", anchoredAtUtc: AT, anchorCheck: "YES" }), "ANCHORED_NOT_CHECKED");
  assert.equal(isPublicAnchoringVerified({ status: "ANCHORED", anchoredAtUtc: AT, anchorCheck: "PROOF_STRUCTURE" }), false);
});

test("anchor semantics (the package manifest source) follow the claim, not the txid", () => {
  const base = { transactionId: TXID, anchoredAtUtc: AT };
  assert.equal(deriveAnchorSemantics({ ...base, otsStatus: "ANCHORED", otsAnchorCheck: "BITCOIN_VERIFIED" }).publicAnchoringVerified, true);
  for (const otsAnchorCheck of [null, "PROOF_STRUCTURE"]) {
    const s = deriveAnchorSemantics({ ...base, otsStatus: "ANCHORED", otsAnchorCheck });
    assert.equal(s.publicAnchoringVerified, false);
    assert.equal(s.anchoringStatus, "anchored_not_checked");
    assert.equal(s.anchorMode, "anchored");
    assert.equal(s.anchoringLabel, OTS_ANCHOR_CLAIM_LABELS.ANCHORED_NOT_CHECKED);
  }
  // Legacy anchor material with no OTS state: recorded, never checked.
  assert.equal(deriveAnchorSemantics({ ...base }).anchoringStatus, "anchored_not_checked");
  assert.equal(deriveAnchorSemantics({ transactionId: TXID, otsStatus: "PENDING" }).publicAnchoringVerified, false);
  assert.equal(deriveAnchorSemantics({ otsStatus: "FAILED" }).anchoringStatus, "failed");
});

function basic(ots) {
  return buildBasicVerification({
    now: new Date(AT),
    integrity: { fingerprintMatches: true, signatureValid: true, custodyChainValid: true },
    fileSha256: "f".repeat(64),
    fingerprintHash: "e".repeat(64),
    capturedAtUtc: null,
    signedAtUtc: null,
    tsaStatus: null,
    tsaImprintMatches: null,
    tsaGenTimeUtc: null,
    otsStatus: null,
    otsBitcoinTxid: null,
    otsAnchoredAtUtc: null,
    latestReport: null,
    pairedPackage: null,
    ...ots,
  }).anchoring;
}

test("public Verify (basic tier): verified only with the chain check; otherwise not_checked / pending / failed", () => {
  assert.deepEqual(basic({ otsStatus: "ANCHORED", otsBitcoinTxid: TXID, otsAnchoredAtUtc: AT, otsAnchorCheck: "BITCOIN_VERIFIED" }), {
    state: "verified",
    basis: "BITCOIN_BLOCK_CONFIRMED_BY_OTS_VERIFY",
    anchoredAtUtc: AT,
    bitcoinTxid: TXID,
    // UC-TRUST-002 — the canonical OTS proof status travels with the claim.
    status: "VERIFIED",
  });
  // (2026-09-29) A historical anchor with NO recorded check does not claim a
  // proof-structure check that never ran; one checked offline does.
  const historical = basic({ otsStatus: "ANCHORED", otsBitcoinTxid: TXID, otsAnchoredAtUtc: AT });
  assert.equal(historical.state, "not_checked");
  assert.equal(historical.basis, "ANCHOR_RECORDED_CHECK_NOT_RECORDED");
  const structure = basic({ otsStatus: "ANCHORED", otsBitcoinTxid: TXID, otsAnchoredAtUtc: AT, otsAnchorCheck: "PROOF_STRUCTURE" });
  assert.equal(structure.state, "not_checked");
  assert.equal(structure.basis, "PROOF_COMMITS_TO_RECORD_CHAIN_NOT_CHECKED");
  // The txid precondition for a chain-checked claim: none → not verified.
  const verifiedNoTxid = basic({ otsStatus: "ANCHORED", otsAnchoredAtUtc: AT, otsAnchorCheck: "BITCOIN_VERIFIED" });
  assert.equal(verifiedNoTxid.state, "not_checked");
  assert.equal(basic({ otsStatus: "ANCHORED", otsBitcoinTxid: TXID }).state, "pending");
  assert.equal(basic({ otsStatus: "PENDING" }).state, "pending");
  assert.equal(basic({ otsStatus: "FAILED" }).state, "failed");
  assert.equal(basic({}).state, "not_issued");
});

test("trust decision: a txid or anchor time reads anchored-not-checked; only a chain check reads verified", () => {
  const decide = (otsAnchorCheck) =>
    buildEvidenceTrustDecision({
      evidence: {
        otsStatus: "ANCHORED",
        otsBitcoinTxid: TXID,
        otsAnchoredAtUtc: AT,
        otsAnchorCheck,
      },
      custodyEvents: [],
    });
  const verified = decide("BITCOIN_VERIFIED");
  assert.equal(verified.anchoringStatusLabel, "Anchored in Bitcoin; verified against the Bitcoin chain");
  assert.equal(verified.signals.find((s) => s.key === "bitcoin_anchoring").state, "PASSED");
  for (const check of [null, "PROOF_STRUCTURE"]) {
    const d = decide(check);
    const anchoring = d.signals.find((s) => s.key === "bitcoin_anchoring");
    // An attested proof is PRESENT, never passed, and carries no score at all.
    assert.equal(d.anchoringStatusLabel, "Anchoring proof present; not independently chain-verified");
    assert.equal(anchoring.state, "PRESENT_NOT_INDEPENDENTLY_VERIFIED");
    assert.notEqual(anchoring.status, "passed");
    assert.equal("points" in anchoring, false);
    assert.equal("score" in d, false);
    assert.notEqual(d.anchoringState, "finalized");
  }
});
