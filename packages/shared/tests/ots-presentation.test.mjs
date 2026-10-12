/**
 * THE CUSTOMER-FACING OPENTIMESTAMPS CARD (2026-10-12): one title, one status,
 * one sentence and an optional date. The truth model's states never reach it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { OTS_PUBLIC_STATUSES, OTS_TRUTH_STATES, otsBlocksPublication, presentOtsTruth } from "../dist/index.js";

const RECORDED = "2026-10-08T12:00:00.000Z";
const CHAIN = {
  verifier: "test-double/1",
  verifiedAtUtc: "2026-10-12T09:00:00.000Z",
  blockHeight: 970507,
  blockHash: "00".repeat(32),
  blockTimeUtc: "2026-10-08T15:24:48.000Z",
  confirmations: 499,
};

test("the card: pending, attestation, unavailable verifier and verified", () => {
  assert.deepEqual(presentOtsTruth({ state: "PENDING", proofRecordedAtUtc: null, chain: null }), {
    title: "OpenTimestamps",
    status: "Pending",
    sentence: "The anchoring proof is still being prepared.",
    dateLabel: null,
    dateUtc: null,
  });
  assert.deepEqual(presentOtsTruth({ state: "ATTESTATION_PRESENT_NOT_VERIFIED", proofRecordedAtUtc: RECORDED, chain: null }), {
    title: "OpenTimestamps",
    status: "Attestation recorded",
    sentence: "Independent Bitcoin verification was not performed.",
    dateLabel: "Recorded by PROOVRA",
    dateUtc: RECORDED,
  });
  assert.deepEqual(presentOtsTruth({ state: "CHAIN_VERIFICATION_UNAVAILABLE", proofRecordedAtUtc: RECORDED, chain: null }), {
    title: "OpenTimestamps",
    status: "Attestation recorded",
    sentence: "Independent verification is currently unavailable.",
    dateLabel: "Recorded by PROOVRA",
    dateUtc: RECORDED,
  });
  assert.deepEqual(presentOtsTruth({ state: "CHAIN_VERIFIED", proofRecordedAtUtc: RECORDED, chain: CHAIN }), {
    title: "OpenTimestamps",
    status: "Verified",
    sentence: "The proof was independently verified against the Bitcoin blockchain.",
    dateLabel: "Verified",
    dateUtc: CHAIN.verifiedAtUtc,
  });
});

test("every state reads in the public vocabulary, one sentence, no internals", () => {
  for (const state of OTS_TRUTH_STATES) {
    const card = presentOtsTruth({ state, proofRecordedAtUtc: RECORDED, chain: state === "CHAIN_VERIFIED" ? CHAIN : null });
    assert.ok(OTS_PUBLIC_STATUSES.includes(card.status), `${state}: ${card.status}`);
    assert.equal(card.sentence.split(/(?<=\.)\s/).length, 1, `${state}: one sentence`);
    const text = `${card.status} ${card.sentence} ${card.dateLabel ?? ""}`;
    assert.doesNotMatch(text, /[A-Z]{3,}_[A-Z_]+|NOT_CHECKED|PROOF_STRUCTURE|BITCOIN_VERIFIED|PROOF_HASH_MISMATCH/);
    assert.doesNotMatch(text, /Anchored at|Bitcoin time|block time|block \d|confirmation|RPC|txid/i);
    // "Verified" is earned only by a recorded chain check.
    if (card.status === "Verified") assert.equal(state, "CHAIN_VERIFIED");
  }
  // An attestation never borrows a Bitcoin time as its date.
  const attested = presentOtsTruth({ state: "ATTESTATION_PRESENT_NOT_VERIFIED", proofRecordedAtUtc: null, chain: null });
  assert.equal(attested.dateLabel, null);
});

test("publication: a mismatched, unreadable or chain-refuted proof is refused; a bound unverified proof publishes", () => {
  for (const truthState of OTS_TRUTH_STATES) {
    assert.equal(otsBlocksPublication({ digestBinding: "MISMATCH", truthState }), true);
    assert.equal(otsBlocksPublication({ digestBinding: "UNREADABLE", truthState }), true);
  }
  assert.equal(otsBlocksPublication({ digestBinding: "MATCH", truthState: "CHAIN_VERIFICATION_FAILED" }), true);
  // The distinction: a correctly bound proof with no verifier is allowed.
  for (const truthState of ["ATTESTATION_PRESENT_NOT_VERIFIED", "CHAIN_VERIFICATION_UNAVAILABLE", "PENDING", "CHAIN_VERIFIED"]) {
    assert.equal(otsBlocksPublication({ digestBinding: "MATCH", truthState }), false, truthState);
  }
  assert.equal(otsBlocksPublication({ digestBinding: "ABSENT", truthState: "NOT_REQUESTED" }), false);
});

test("Public Verify: a proof bound to another digest, or unreadable, is never presented as attached", async () => {
  const { readFileSync } = await import("node:fs");
  const { boundOtsProofBase64 } = await import("../dist/index.js");
  const PROOFS = JSON.parse(readFileSync(new URL("./fixtures/ots-proofs.json", import.meta.url), "utf8"));
  const fp = PROOFS.boundFingerprintHash;
  assert.equal(boundOtsProofBase64({ proofBase64: PROOFS.boundProofBase64, fingerprintHash: fp, otsHash: fp }), PROOFS.boundProofBase64);
  assert.equal(boundOtsProofBase64({ proofBase64: PROOFS.otherProofBase64, fingerprintHash: fp, otsHash: fp }), null);
  assert.equal(boundOtsProofBase64({ proofBase64: Buffer.from("not a proof").toString("base64"), fingerprintHash: fp, otsHash: fp }), null);
  assert.equal(boundOtsProofBase64({ proofBase64: null, fingerprintHash: fp, otsHash: fp }), null);
});
