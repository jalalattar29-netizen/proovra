/**
 * THE OTS TRUTH MODEL AND THE PROOF'S DIGEST BINDING (2026-10-12).
 *
 * Real proof bytes (fixtures/ots-proofs.json, created with
 * opentimestamps-client 0.7.2) are read by the product parser; the truth model
 * keeps "the proof carries an attestation", "PROOVRA recorded the proof" and
 * "the attestation was independently verified" apart.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  OTS_PROOF_RECORDED_AT_LABEL,
  OTS_REPORTED_BY_PROOF_QUALIFIER,
  OtsDigestBindingError,
  assertOtsDigestBinding,
  checkOtsDigestBinding,
  parseOtsProof,
  resolveOtsTruth,
} from "../dist/index.js";

const PROOFS = JSON.parse(readFileSync(new URL("./fixtures/ots-proofs.json", import.meta.url), "utf8"));
const RECORDED = "2026-10-08T17:22:20.958Z";
const TXID = "e2757846a54fc4a79f296c7f2b31a196fe8ad1761503e6814259b8a6ac2fbdb6";
const CHAIN = {
  chainVerificationStatus: "VERIFIED",
  chainCheckedAtUtc: "2026-10-12T09:00:00.000Z",
  chainVerifiedAtUtc: "2026-10-12T09:00:00.000Z",
  chainBlockHeight: 970507,
  chainBlockHash: "00000000000000000001ec3f183cf87a623516376df048fed10a1696ed0f328f",
  chainBlockTimeUtc: "2026-10-08T15:24:48.000Z",
  chainConfirmations: 499,
  chainVerifier: "test-double/1",
};

test("the parser reads the digest a real proof commits to, from its bytes", () => {
  const bound = parseOtsProof(PROOFS.boundProofBase64);
  assert.equal(bound.fileDigestAlgorithm, "sha256");
  assert.equal(bound.committedDigestHex, createHash("sha256").update(PROOFS.boundFingerprintCanonicalJson).digest("hex"));
  assert.equal(bound.committedDigestHex, PROOFS.boundFingerprintHash);
  assert.deepEqual(bound.bitcoinBlockHeights, []);
  assert.ok(bound.pendingCalendars.length > 0);
  assert.ok(bound.pendingCalendars.every((u) => u.startsWith("https://")));
  assert.equal(parseOtsProof(PROOFS.otherProofBase64).committedDigestHex, PROOFS.otherDigest);
});

test("digest binding: match, mismatch, unreadable, absent", () => {
  const fp = PROOFS.boundFingerprintHash;
  assert.equal(checkOtsDigestBinding({ proofBase64: PROOFS.boundProofBase64, fingerprintHash: fp, otsHash: fp }).kind, "MATCH");
  const other = checkOtsDigestBinding({ proofBase64: PROOFS.otherProofBase64, fingerprintHash: fp, otsHash: fp });
  assert.equal(other.kind, "MISMATCH");
  assert.equal(other.reason, "PROOF_COMMITS_TO_OTHER_DIGEST");
  assert.equal(other.committedDigestHex, PROOFS.otherDigest);
  assert.equal(
    checkOtsDigestBinding({ proofBase64: PROOFS.boundProofBase64, fingerprintHash: fp, otsHash: PROOFS.otherDigest }).reason,
    "OTS_HASH_IS_NOT_FINGERPRINT",
  );
  // One flipped byte inside the committed digest is a different commitment.
  const bytes = Buffer.from(PROOFS.boundProofBase64, "base64");
  bytes[33] ^= 0x01;
  assert.equal(checkOtsDigestBinding({ proofBase64: bytes.toString("base64"), fingerprintHash: fp }).kind, "MISMATCH");
  // Truncated, foreign or non-base64 bytes are unreadable, never "absent".
  for (const bad of [PROOFS.boundProofBase64.slice(0, 200), Buffer.from("not an ots proof").toString("base64"), "%%%"]) {
    assert.equal(checkOtsDigestBinding({ proofBase64: bad, fingerprintHash: fp }).kind, "UNREADABLE", bad.slice(0, 12));
  }
  assert.equal(checkOtsDigestBinding({ proofBase64: null, fingerprintHash: fp }).kind, "ABSENT");
  assert.throws(
    () => assertOtsDigestBinding({ proofBase64: PROOFS.otherProofBase64, fingerprintHash: fp }, "test boundary"),
    (e) => e instanceof OtsDigestBindingError && e.code === "OTS_PROOF_DIGEST_MISMATCH",
  );
  assert.equal(assertOtsDigestBinding({ proofBase64: PROOFS.boundProofBase64, fingerprintHash: fp }, "test boundary").kind, "MATCH");
});

const anchoredByStructure = {
  status: "ANCHORED",
  anchoredAtUtc: RECORDED,
  anchorCheck: "PROOF_STRUCTURE",
  bitcoinTxid: TXID,
  upgradedAtUtc: RECORDED,
  attestationBlockHeight: 970507,
};

test("THE INCIDENT: an attestation read from the proof is not an anchor and has no anchor time", () => {
  const t = resolveOtsTruth(anchoredByStructure);
  assert.equal(t.state, "ATTESTATION_PRESENT_NOT_VERIFIED");
  assert.equal(t.claim, "ANCHORED_NOT_CHECKED");
  assert.equal(t.headline, "Bitcoin attestation present");
  assert.equal(t.detail, "Not independently verified against the Bitcoin blockchain");
  // The worker's recording time is the proof-recorded time — never an anchor time.
  assert.equal(t.verifiedAnchorTimeUtc, null);
  assert.equal(t.proofRecordedAtUtc, RECORDED);
  assert.deepEqual(t.reported, { txid: TXID, blockHeight: 970507, qualifier: OTS_REPORTED_BY_PROOF_QUALIFIER });
  assert.equal(t.chain, null);
  assert.equal(OTS_PROOF_RECORDED_AT_LABEL, "Proof recorded by PROOVRA (UTC)");
});

test("each truth state is distinct; none is promoted by a txid, a status or a time", () => {
  assert.equal(resolveOtsTruth({ status: null, anchoredAtUtc: null, anchorCheck: null }).state, "NOT_REQUESTED");
  assert.equal(resolveOtsTruth({ status: "PENDING", anchoredAtUtc: null, anchorCheck: null }).state, "PENDING");
  // Pending for longer than anchoring takes is stale, not pending.
  assert.equal(
    resolveOtsTruth({ status: "PENDING", anchoredAtUtc: null, anchorCheck: null, submittedAtUtc: "2026-09-01T00:00:00Z", now: new Date("2026-10-12T00:00:00Z") }).state,
    "UNKNOWN_OR_STALE",
  );
  assert.equal(resolveOtsTruth({ ...anchoredByStructure, chainVerificationStatus: "NOT_CONFIGURED" }).state, "ATTESTATION_PRESENT_NOT_VERIFIED");
  assert.equal(resolveOtsTruth({ ...anchoredByStructure, chainVerificationStatus: "INSUFFICIENT_CONFIRMATIONS" }).state, "ATTESTATION_PRESENT_NOT_VERIFIED");
  const unavailable = resolveOtsTruth({ ...anchoredByStructure, chainVerificationStatus: "UNAVAILABLE", chainCheckedAtUtc: "2026-10-12T09:00:00Z" });
  assert.equal(unavailable.state, "CHAIN_VERIFICATION_UNAVAILABLE");
  assert.equal(unavailable.claim, "ANCHORED_NOT_CHECKED");
  assert.match(unavailable.detail, /Not independently verified against the Bitcoin blockchain/);
  const failed = resolveOtsTruth({ ...anchoredByStructure, chainVerificationStatus: "FAILED", chainFailureCode: "ATTESTATION_NOT_IN_CHAIN" });
  assert.equal(failed.state, "CHAIN_VERIFICATION_FAILED");
  assert.equal(failed.claim, "FAILED");
  assert.equal(failed.chainCheck.failureCode, "ATTESTATION_NOT_IN_CHAIN");
  assert.equal(failed.verifiedAnchorTimeUtc, null);
  // A verified chain status with incomplete evidence is not verified.
  assert.equal(
    resolveOtsTruth({ ...anchoredByStructure, anchorCheck: "BITCOIN_VERIFIED", ...CHAIN, chainBlockHash: null }).state,
    "ATTESTATION_PRESENT_NOT_VERIFIED",
  );
  // Anchored before the check column existed: cannot be established.
  const legacy = resolveOtsTruth({ status: "ANCHORED", anchoredAtUtc: RECORDED, anchorCheck: null, bitcoinTxid: TXID });
  assert.equal(legacy.state, "UNKNOWN_OR_STALE");
  assert.equal(legacy.claim, "ANCHORED_NOT_CHECKED");
  assert.equal(legacy.verifiedAnchorTimeUtc, null);
  assert.equal(resolveOtsTruth({ status: "FAILED", anchoredAtUtc: null, anchorCheck: null }).state, "PROOF_INVALID");
});

test("CHAIN_VERIFIED carries the full recorded evidence; its block time is the only anchor time", () => {
  const t = resolveOtsTruth({ ...anchoredByStructure, anchorCheck: "BITCOIN_VERIFIED", ...CHAIN });
  assert.equal(t.state, "CHAIN_VERIFIED");
  assert.equal(t.claim, "VERIFIED");
  assert.equal(t.verifiedAnchorTimeUtc, "2026-10-08T15:24:48.000Z");
  assert.deepEqual(t.chain, {
    verifier: "test-double/1",
    verifiedAtUtc: "2026-10-12T09:00:00.000Z",
    blockHeight: 970507,
    blockHash: CHAIN.chainBlockHash,
    blockTimeUtc: "2026-10-08T15:24:48.000Z",
    confirmations: 499,
  });
  assert.match(t.detail, /Block 970507, 499 confirmations/);
  // A txid is required as well.
  assert.equal(resolveOtsTruth({ ...anchoredByStructure, anchorCheck: "BITCOIN_VERIFIED", ...CHAIN, bitcoinTxid: null }).state, "ATTESTATION_PRESENT_NOT_VERIFIED");
});

test("a proof bound to another digest is PROOF_INVALID in every state, verified included", () => {
  const mismatch = checkOtsDigestBinding({
    proofBase64: PROOFS.otherProofBase64,
    fingerprintHash: PROOFS.boundFingerprintHash,
    otsHash: PROOFS.boundFingerprintHash,
  });
  for (const row of [anchoredByStructure, { ...anchoredByStructure, anchorCheck: "BITCOIN_VERIFIED", ...CHAIN }, { status: "PENDING", anchoredAtUtc: null, anchorCheck: null }]) {
    const t = resolveOtsTruth({ ...row, digestBinding: mismatch });
    assert.equal(t.state, "PROOF_INVALID");
    assert.equal(t.claim, "FAILED");
    assert.equal(t.reported, null);
    assert.equal(t.verifiedAnchorTimeUtc, null);
  }
});
