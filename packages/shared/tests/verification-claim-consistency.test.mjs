/**
 * VERIFICATION CLAIM CONSISTENCY (2026-09-29) — D8, D9, D10 at the shared
 * authorities every surface reads.
 *
 *   D10  a STAMPED record with no stored imprint is an UNKNOWN comparison
 *        (null), never a mismatch (false); a real difference stays false.
 *   D8   one badge per claim (2026-10-13): green only for ANCHORED — a stored
 *        proof executed from the record's digest to a valid Bitcoin block
 *        attestation. A stored status, an anchored-at time or a txid never
 *        decides it.
 *   txid a txid is shown only when the executed proof path derives it, and
 *        only for ANCHORED.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  OTS_STATES,
  buildBasicVerification,
  compareTimestampDigest,
  parseOtsState,
  presentOtsAnchoring,
  presentedTsaStatus,
  readOtsAnchoringView,
  resolveOtsAnchoring,
  toOtsAnchoringView,
} from "../dist/index.js";
import { REAL, chainRecordFor, upgradedProof } from "./helpers/ots-fixtures.mjs";

const D = "a".repeat(64);
const OTHER = "b".repeat(64);
const TXID = "c".repeat(64);
const AT = "2026-09-01T00:00:00.000Z";

test("D10: the timestamp digest comparison is true / false / unknown — a missing value is never a mismatch", () => {
  const cmp = (over) =>
    compareTimestampDigest({ tsaStatus: "STAMPED", tsaMessageImprint: D, tsaInputDigestHex: D, fileSha256: D, ...over });
  assert.equal(cmp({}), true);
  assert.equal(cmp({ tsaMessageImprint: D.toUpperCase() }), true);
  assert.equal(cmp({ tsaMessageImprint: OTHER }), false, "a real difference is a mismatch");
  assert.equal(cmp({ tsaMessageImprint: null }), null, "no stored imprint → unknown, not false");
  assert.equal(cmp({ tsaMessageImprint: "" }), null);
  assert.equal(cmp({ tsaInputDigestHex: null }), true, "falls back to the file digest");
  assert.equal(cmp({ tsaInputDigestHex: null, fileSha256: null }), null);
  for (const status of ["FAILED", "PENDING", null, ""]) {
    assert.equal(cmp({ tsaStatus: status }), null, String(status));
  }
});

test("D10 → Basic Verify: an unknown imprint reads not_checked with its own basis; a mismatch reads failed", () => {
  const base = {
    now: new Date("2026-09-29T00:00:00Z"),
    integrity: { fingerprintMatches: true, signatureValid: true, custodyChainValid: true },
    fileSha256: D,
    fingerprintHash: D,
    capturedAtUtc: null,
    signedAtUtc: AT,
    tsaStatus: "STAMPED",
    tsaGenTimeUtc: AT,
    ots: { status: null, proofBase64: null, fingerprintHash: D },
    latestReport: null,
    pairedPackage: null,
  };
  const unknown = buildBasicVerification({ ...base, tsaImprintMatches: null });
  assert.equal(unknown.timestamp.state, "not_checked");
  assert.equal(unknown.timestamp.basis, "TOKEN_RECORDED_IMPRINT_NOT_COMPARED");
  assert.equal(unknown.original.state, "verified", "the original's own checks stand independently");
  const matches = buildBasicVerification({ ...base, tsaImprintMatches: true });
  // ET-TSA-01: presented STAMPED means the token was VALIDATED at issuance.
  assert.equal(matches.timestamp.state, "verified");
  assert.equal(matches.timestamp.basis, "TOKEN_VALIDATED");
  const mismatch = buildBasicVerification({ ...base, tsaImprintMatches: false });
  assert.equal(mismatch.timestamp.state, "failed");
});

test("ET-TSA-01: a kept token that was never validated is not_checked, never verified", () => {
  assert.equal(presentedTsaStatus({ tsaStatus: "STAMPED", tsaValidatedAtUtc: null }), "RECORDED_NOT_VALIDATED");
  assert.equal(presentedTsaStatus({ tsaStatus: "STAMPED", tsaValidatedAtUtc: AT }), "STAMPED");
  assert.equal(presentedTsaStatus({ tsaStatus: "FAILED", tsaValidatedAtUtc: null }), "FAILED");
  assert.equal(presentedTsaStatus({ tsaStatus: null }), null);
  const legacy = buildBasicVerification({
    now: new Date("2026-09-29T00:00:00Z"),
    integrity: { fingerprintMatches: true, signatureValid: true, custodyChainValid: true },
    fileSha256: D,
    fingerprintHash: D,
    capturedAtUtc: null,
    signedAtUtc: AT,
    tsaStatus: "RECORDED_NOT_VALIDATED",
    tsaImprintMatches: null,
    tsaGenTimeUtc: AT,
    ots: { status: null, proofBase64: null, fingerprintHash: D },
    latestReport: null,
    pairedPackage: null,
  });
  assert.equal(legacy.timestamp.state, "not_checked");
  assert.equal(legacy.timestamp.basis, "TOKEN_RECORDED_NOT_VALIDATED");
  // The comparison is never positive for an unvalidated token.
  assert.equal(
    compareTimestampDigest({ tsaStatus: "RECORDED_NOT_VALIDATED", tsaMessageImprint: D, tsaInputDigestHex: D, fileSha256: D }),
    null,
  );
});

test("D8: one badge per claim — green only when the anchor is independently verified against the Bitcoin main chain", () => {
  // No lifecycle state on its own is green — not even ANCHORED (a block the proof only names).
  for (const state of OTS_STATES) {
    const p = presentOtsAnchoring({ state });
    assert.notEqual(p.tone, "success", state);
    assert.equal(p.title, "Bitcoin anchoring");
  }
  assert.equal(presentOtsAnchoring({ state: "ANCHORED" }).status, "Attestation recorded");
  assert.equal(presentOtsAnchoring({ state: "ANCHORED" }).secondaryStatus, "Not independently checked against Bitcoin");
  // A client-claimed CHAIN_VERIFIED over a non-ANCHORED state is never believed.
  assert.notEqual(presentOtsAnchoring({ state: "PENDING", verification: "CHAIN_VERIFIED" }).tone, "success");
  assert.equal(presentOtsAnchoring({ state: "ANCHORED", verification: "CHAIN_VERIFIED" }).tone, "success");
  assert.equal(presentOtsAnchoring({ state: "FAILED" }).tone, "danger");
  assert.equal(parseOtsState("ANCHORED"), "ANCHORED");
  // Anything a client does not know — a lower-case value, a retired claim, nothing — is Unavailable.
  for (const v of ["anchored", "VERIFIED", "ANCHORED_NOT_CHECKED", "CHAIN_VERIFIED", undefined, null]) {
    assert.equal(parseOtsState(v), "UNAVAILABLE", String(v));
    assert.notEqual(presentOtsAnchoring({ state: v }).tone, "success", String(v));
  }
});

test("D8: a stored ANCHORED status with an anchor time over a pending proof is PENDING, never green", () => {
  const FP = REAL.boundFingerprintHash;
  const claim = resolveOtsAnchoring({ status: "ANCHORED", anchoredAtUtc: AT, proofBase64: REAL.boundProofBase64, fingerprintHash: FP });
  assert.equal(claim.state, "PENDING");
  assert.notEqual(presentOtsAnchoring(claim).tone, "success");
  // An upgraded proof whose path has no transaction is ANCHORED with no txid — never "pending" —
  // and green only once a chain verification is bound to it.
  const p = upgradedProof({ withTransaction: false });
  const noTx = resolveOtsAnchoring({ status: "ANCHORED", anchoredAtUtc: AT, proofBase64: p.base64, fingerprintHash: FP });
  assert.equal(noTx.state, "ANCHORED");
  assert.equal(noTx.bitcoinTxid, null);
  assert.notEqual(presentOtsAnchoring(noTx).tone, "success");
  const verified = resolveOtsAnchoring({ status: "ANCHORED", anchoredAtUtc: AT, proofBase64: p.base64, fingerprintHash: FP, chain: chainRecordFor(p) });
  assert.equal(presentOtsAnchoring(verified).tone, "success");
});

test("txid: shown only when the executed proof derives it, and only for ANCHORED; nothing is promoted", () => {
  const FP = REAL.boundFingerprintHash;
  const up = upgradedProof();
  const anchored = toOtsAnchoringView(resolveOtsAnchoring({ status: "ANCHORED", anchoredAtUtc: AT, proofBase64: up.base64, fingerprintHash: FP }));
  assert.equal(anchored.bitcoinTxid, up.txid);
  // A txid a server sends beside any other state is dropped by the client.
  for (const state of ["PENDING", "FAILED", "UNAVAILABLE", "NOT_REQUESTED"]) {
    const v = readOtsAnchoringView({ state, bitcoinTxid: TXID, bitcoinBlockHeight: 900_000, anchoredAtUtc: AT });
    assert.equal(v.bitcoinTxid, null, state);
    assert.equal(v.bitcoinBlockHeight, null, state);
    assert.equal(v.anchoredAtUtc, null, state);
    assert.notEqual(v.tone, "success", state);
  }
  // A proof for another digest is never promoted, whatever the status column says.
  const other = resolveOtsAnchoring({ status: "ANCHORED", anchoredAtUtc: AT, proofBase64: upgradedProof({ base64: REAL.otherProofBase64 }).base64, fingerprintHash: FP });
  assert.equal(other.state, "FAILED");
  assert.equal(other.bitcoinTxid, null);
  assert.equal(resolveOtsAnchoring({ status: "PENDING", proofBase64: REAL.boundProofBase64, fingerprintHash: FP }).bitcoinTxid, null);
});
