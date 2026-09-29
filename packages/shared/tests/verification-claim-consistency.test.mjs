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
  assert.equal(matches.timestamp.basis, "IMPRINT_MATCHES_TOKEN_SIGNATURE_NOT_VERIFIED");
  const mismatch = buildBasicVerification({ ...base, tsaImprintMatches: false });
  assert.equal(mismatch.timestamp.state, "failed");
});

test("D8: one badge per claim — green only when the chain was checked", () => {
  assert.deepEqual(otsClaimBadge("VERIFIED"), { label: "ANCHORED · VERIFIED", tone: "success" });
  const unchecked = otsClaimBadge("ANCHORED_NOT_CHECKED");
  assert.equal(unchecked.tone, "info");
  assert.match(unchecked.label, /CHAIN NOT CHECKED/);
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
  const r = (over) => resolveOtsAnchorClaim({ status: "ANCHORED", anchoredAtUtc: AT, anchorCheck: "BITCOIN_VERIFIED", ...over });
  assert.equal(r({ bitcoinTxid: TXID }), "VERIFIED");
  assert.equal(r({ bitcoinTxid: null }), "ANCHORED_NOT_CHECKED");
  assert.equal(r({ bitcoinTxid: "not-a-txid" }), "ANCHORED_NOT_CHECKED");
  assert.equal(r({}), "VERIFIED", "callers that do not hold the txid keep the previous rule");
  // Never an upgrade.
  assert.equal(r({ anchorCheck: "PROOF_STRUCTURE", bitcoinTxid: TXID }), "ANCHORED_NOT_CHECKED");
  assert.equal(r({ anchorCheck: null, bitcoinTxid: TXID }), "ANCHORED_NOT_CHECKED");
  assert.equal(resolveOtsAnchorClaim({ status: "PENDING", anchoredAtUtc: null, anchorCheck: null, bitcoinTxid: TXID }), "PENDING");
});
