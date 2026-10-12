/**
 * VERIFICATION CLAIM CONSISTENCY (2026-09-29) — D8, D9, D10 at the shared
 * authorities every surface reads.
 *
 *   D10  a STAMPED record with no stored imprint is an UNKNOWN comparison
 *        (null), never a mismatch (false); a real difference stays false.
 *   D8   one badge per claim: green only for a chain-verified anchor; a
 *        recorded anchor whose chain was not checked is informational.
 *   D9   a historical anchor with no recorded check claims no check.
 *   txid a chain-checked claim needs its txid when the caller holds one.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBasicVerification,
  compareTimestampDigest,
  otsClaimBadge,
  parseOtsAnchorClaim,
  presentedTsaStatus,
  resolveOtsAnchorClaim,
} from "../dist/index.js";

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
    otsStatus: null,
    otsAnchoredAtUtc: null,
    otsBitcoinTxid: null,
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
    otsStatus: null,
    otsAnchoredAtUtc: null,
    otsBitcoinTxid: null,
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

test("D8: one badge per claim — green only when the chain was checked", () => {
  assert.deepEqual(otsClaimBadge("VERIFIED"), { label: "VERIFIED", tone: "success" });
  const unchecked = otsClaimBadge("ANCHORED_NOT_CHECKED");
  assert.equal(unchecked.tone, "info");
  assert.equal(unchecked.label, "ATTESTATION RECORDED");
  assert.notEqual(otsClaimBadge("PENDING").tone, "success");
  assert.notEqual(otsClaimBadge("FAILED").tone, "success");
  assert.equal(parseOtsAnchorClaim("VERIFIED"), "VERIFIED");
  assert.equal(parseOtsAnchorClaim("verified"), null);
  assert.equal(parseOtsAnchorClaim(undefined), null);
});

test("D8: an anchor recorded without a txid is anchored-not-checked, never 'pending' and never green", () => {
  const claim = resolveOtsAnchorClaim({ status: "ANCHORED", anchoredAtUtc: AT, anchorCheck: "PROOF_STRUCTURE", bitcoinTxid: null });
  assert.equal(claim, "ANCHORED_NOT_CHECKED");
  assert.equal(otsClaimBadge(claim).tone, "info");
});

test("txid precondition: a chain-checked claim needs its txid when the caller holds one; nothing is promoted", () => {
  const chain = {
    chainVerificationStatus: "VERIFIED",
    chainVerifiedAtUtc: "2026-10-01T03:00:00.000Z",
    chainBlockHeight: 970507,
    chainBlockHash: "00000000000000000001ec3f183cf87a623516376df048fed10a1696ed0f328f",
    chainBlockTimeUtc: "2026-10-01T01:24:48.000Z",
    chainConfirmations: 6,
    chainVerifier: "test-double/1",
  };
  const r = (over) => resolveOtsAnchorClaim({ status: "ANCHORED", anchoredAtUtc: AT, anchorCheck: "BITCOIN_VERIFIED", chain, ...over });
  assert.equal(r({ bitcoinTxid: TXID }), "VERIFIED");
  assert.equal(r({ bitcoinTxid: null }), "ANCHORED_NOT_CHECKED");
  assert.equal(r({ bitcoinTxid: "not-a-txid" }), "ANCHORED_NOT_CHECKED");
  assert.equal(r({}), "VERIFIED", "callers that do not hold the txid keep the previous rule");
  // Never an upgrade.
  assert.equal(r({ anchorCheck: "PROOF_STRUCTURE", bitcoinTxid: TXID }), "ANCHORED_NOT_CHECKED");
  assert.equal(r({ anchorCheck: null, bitcoinTxid: TXID }), "ANCHORED_NOT_CHECKED");
  assert.equal(resolveOtsAnchorClaim({ status: "PENDING", anchoredAtUtc: null, anchorCheck: null, bitcoinTxid: TXID }), "PENDING");
});
