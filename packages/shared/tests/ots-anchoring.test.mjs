/**
 * THE OPENTIMESTAMPS ANCHORING STATE — `resolveOtsAnchoring` is the one
 * authority (2026-10-13). Every case runs on real proof bytes: the proofs
 * `ots stamp` produced (tests/fixtures/ots-proofs.json) and their upgraded
 * form built by tests/helpers/ots-fixtures.mjs, whose txid and merkle root are
 * computed independently with node:crypto.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  OTS_ANCHORED_BOUNDARY,
  OTS_FAILURE_LABELS,
  OTS_PROOF_INTEGRITY_FAILURES,
  OTS_PROOF_VALIDATOR,
  OTS_STATES,
  OTS_STATE_WORDS,
  checkOtsDigestBinding,
  deriveAnchorSemantics,
  isSerializedBitcoinTransaction,
  otsAnchoringCopy,
  otsBlocksPublication,
  parseOtsProof,
  parseOtsState,
  presentOtsAnchoring,
  readOtsAnchoringView,
  resolveOtsAnchoring,
  resolveRecordOtsAnchoring,
  toOtsAnchoringView,
} from "../dist/index.js";
import {
  REAL,
  badMagic,
  proofSha256,
  tooDeep,
  tooLarge,
  truncated,
  txAround,
  upgradedProof,
} from "./helpers/ots-fixtures.mjs";

const FP = REAL.boundFingerprintHash;
const BITCOIN_TAG = Buffer.from("0588960d73d71901", "hex");
const sha = (b) => createHash("sha256").update(b).digest();

const resolve = (proofBase64, extra = {}) =>
  resolveOtsAnchoring({ status: "PENDING", proofBase64, fingerprintHash: FP, ...extra });

// ---------------------------------------------------------------------------
// (1)–(11) the resolver
// ---------------------------------------------------------------------------

test("(1) the real pending proof is PENDING with its calendars, and no height or txid", () => {
  const a = resolve(REAL.boundProofBase64);
  assert.equal(a.state, "PENDING");
  assert.equal(a.failureCode, null);
  assert.equal(a.attestationType, "PENDING_CALENDAR");
  assert.ok(a.pendingCalendars.length >= 1);
  for (const uri of a.pendingCalendars) assert.match(uri, /^https:\/\//);
  assert.equal(a.bitcoinBlockHeight, null);
  assert.equal(a.bitcoinTxid, null);
  assert.equal(a.merkleRootHex, null);
  assert.equal(a.anchoredAtUtc, null);
  assert.equal(a.committedDigestHex, FP);
  assert.equal(a.proofSha256, proofSha256(REAL.boundProofBase64));
  assert.equal(a.validator, OTS_PROOF_VALIDATOR);
});

test("(2) an upgraded proof is ANCHORED with the height, merkle root and txid its path derives", () => {
  const up = upgradedProof({ blockHeight: 900_001 });
  const a = resolve(up.base64, { anchoredAtUtc: "2026-10-12T10:00:00Z" });
  assert.equal(a.state, "ANCHORED");
  assert.equal(a.failureCode, null);
  assert.equal(a.attestationType, "BITCOIN_BLOCK_HEADER");
  assert.equal(a.bitcoinBlockHeight, 900_001);
  assert.equal(a.merkleRootHex, up.merkleRootHex);
  assert.match(up.txid, /^[0-9a-f]{64}$/);
  assert.equal(a.bitcoinTxid, up.txid);
  assert.equal(a.proofSha256, up.proofSha256);
  assert.equal(a.proofSha256, sha(Buffer.from(up.base64, "base64")).toString("hex"));
  assert.equal(a.committedDigestHex, FP);
  assert.equal(a.anchoredAtUtc, "2026-10-12T10:00:00.000Z");
  // The calendar branches the upgrade kept are still reported.
  assert.ok(a.pendingCalendars.length >= 1);
});

test("(3) an upgraded proof without a transaction step is ANCHORED with txid null (never invented)", () => {
  const up = upgradedProof({ withTransaction: false });
  assert.equal(up.txid, null);
  const a = resolve(up.base64, { status: "ANCHORED" });
  assert.equal(a.state, "ANCHORED");
  assert.equal(a.bitcoinTxid, null);
  assert.equal(a.bitcoinBlockHeight, up.blockHeight);
  assert.equal(a.merkleRootHex, up.merkleRootHex);
});

test("(4) a proof committing to another digest is FAILED PROOF_HASH_MISMATCH, even with status ANCHORED", () => {
  for (const status of ["PENDING", "ANCHORED", null]) {
    const a = resolve(REAL.otherProofBase64, { status, anchoredAtUtc: "2026-10-12T10:00:00Z" });
    assert.equal(a.state, "FAILED", String(status));
    assert.equal(a.failureCode, "PROOF_HASH_MISMATCH");
    assert.equal(a.committedDigestHex, REAL.otherDigest);
    assert.equal(a.bitcoinBlockHeight, null);
    assert.equal(a.anchoredAtUtc, null);
  }
  // An upgraded (Bitcoin-attested) proof for the other digest is still never anchored here.
  const otherUp = upgradedProof({ base64: REAL.otherProofBase64 });
  const b = resolve(otherUp.base64, { status: "ANCHORED" });
  assert.equal(b.state, "FAILED");
  assert.equal(b.failureCode, "PROOF_HASH_MISMATCH");
  // The record's own ots_hash naming another digest is a mismatch too.
  const c = resolve(upgradedProof().base64, { status: "ANCHORED", otsHash: REAL.otherDigest });
  assert.equal(c.state, "FAILED");
  assert.equal(c.failureCode, "PROOF_HASH_MISMATCH");
});

test("(5) truncated or bad-magic bytes are FAILED MALFORMED_PROOF", () => {
  for (const bytes of [truncated(), badMagic(), truncated(upgradedProof().base64, 3), "%%%not-base64%%%"]) {
    const a = resolve(bytes, { status: "ANCHORED" });
    assert.equal(a.state, "FAILED");
    assert.equal(a.failureCode, "MALFORMED_PROOF");
    assert.equal(a.bitcoinBlockHeight, null);
  }
});

test("(6) a non-executed operation before the Bitcoin attestation is FAILED UNSUPPORTED_PROOF_OPERATION", () => {
  const up = upgradedProof({ unexecutedOp: 0x02 });
  const a = resolve(up.base64, { status: "ANCHORED" });
  assert.equal(a.state, "FAILED");
  assert.equal(a.failureCode, "UNSUPPORTED_PROOF_OPERATION");
  assert.equal(a.bitcoinBlockHeight, null);
  assert.equal(a.bitcoinTxid, null);
});

test("(7) a Bitcoin attestation payload with trailing bytes is FAILED INVALID_ATTESTATION", () => {
  const up = upgradedProof({ trailingPayload: Buffer.from([0x01]) });
  const a = resolve(up.base64, { status: "ANCHORED" });
  assert.equal(a.state, "FAILED");
  assert.equal(a.failureCode, "INVALID_ATTESTATION");
  assert.equal(a.bitcoinBlockHeight, null);
});

test("(8) size and complexity limits are FAILED MALFORMED_PROOF without throwing", () => {
  for (const bytes of [tooDeep(), tooLarge()]) {
    let a;
    assert.doesNotThrow(() => {
      a = resolve(bytes);
    });
    assert.equal(a.state, "FAILED");
    assert.equal(a.failureCode, "MALFORMED_PROOF");
  }
  assert.throws(() => parseOtsProof(tooDeep()), /MALFORMED_PROOF/);
  assert.throws(() => parseOtsProof(tooLarge()), /MALFORMED_PROOF/);
});

test("(9) status ANCHORED + a well-formed txid + anchoredAt over the pending proof is PENDING", () => {
  const a = resolveRecordOtsAnchoring({
    otsStatus: "ANCHORED",
    otsProofBase64: REAL.boundProofBase64,
    fingerprintHash: FP,
    otsHash: FP,
    otsAnchoredAtUtc: "2026-10-12T10:00:00Z",
    otsUpgradedAtUtc: "2026-10-12T10:00:00Z",
  });
  assert.equal(a.state, "PENDING");
  assert.equal(a.bitcoinTxid, null);
  assert.equal(a.bitcoinBlockHeight, null);
  assert.equal(a.anchoredAtUtc, null);
});

test("(10) proof material missing → UNAVAILABLE PROOF_MATERIAL_MISSING; no fingerprint → FINGERPRINT_MISSING", () => {
  for (const status of ["PENDING", "ANCHORED", "pending", " anchored "]) {
    const a = resolveOtsAnchoring({ status, proofBase64: null, fingerprintHash: FP, anchoredAtUtc: "2026-10-12T10:00:00Z" });
    assert.equal(a.state, "UNAVAILABLE", status);
    assert.equal(a.failureCode, "PROOF_MATERIAL_MISSING");
    assert.equal(a.anchoredAtUtc, null);
    const blank = resolveOtsAnchoring({ status, proofBase64: "   ", fingerprintHash: FP });
    assert.equal(blank.state, "UNAVAILABLE");
  }
  for (const fingerprintHash of [null, "", "not-a-digest"]) {
    const a = resolveOtsAnchoring({ status: "ANCHORED", proofBase64: upgradedProof().base64, fingerprintHash });
    assert.equal(a.state, "UNAVAILABLE");
    assert.equal(a.failureCode, "FINGERPRINT_MISSING");
    assert.equal(a.bitcoinBlockHeight, null);
  }
});

test("(11) DISABLED / no status and no proof are NOT_REQUESTED; a budget-exhausted FAILED over a pending proof keeps its code; publication blocks only on proof integrity", () => {
  assert.equal(resolveOtsAnchoring({ status: "DISABLED", proofBase64: upgradedProof().base64, fingerprintHash: FP }).state, "NOT_REQUESTED");
  const none = resolveOtsAnchoring({ status: null, proofBase64: null, fingerprintHash: FP });
  assert.equal(none.state, "NOT_REQUESTED");
  assert.equal(none.failureCode, null);

  const budget = resolve(REAL.boundProofBase64, { status: "FAILED", failureReason: "OTS_GLOBAL_BUDGET_EXHAUSTED" });
  assert.equal(budget.state, "FAILED");
  assert.equal(budget.failureCode, "OTS_GLOBAL_BUDGET_EXHAUSTED");
  assert.equal(otsBlocksPublication(budget), false);

  // A raw legacy reason is bounded; no proof + FAILED still FAILED.
  const raw = resolveOtsAnchoring({ status: "FAILED", proofBase64: null, fingerprintHash: FP, failureReason: "socket hang up at calendar" });
  assert.equal(raw.state, "FAILED");
  assert.equal(raw.failureCode, "OTS_PROCESSING_FAILED");

  // A stored FAILED never outranks a proof that is genuinely anchored.
  assert.equal(resolve(upgradedProof().base64, { status: "FAILED", failureReason: "OTS_GLOBAL_BUDGET_EXHAUSTED" }).state, "ANCHORED");

  assert.deepEqual([...OTS_PROOF_INTEGRITY_FAILURES].sort(), [
    "INVALID_ATTESTATION",
    "MALFORMED_PROOF",
    "PROOF_HASH_MISMATCH",
    "UNSUPPORTED_PROOF_OPERATION",
  ]);
  for (const code of OTS_PROOF_INTEGRITY_FAILURES) assert.equal(otsBlocksPublication({ state: "FAILED", failureCode: code }), true, code);
  for (const code of ["OTS_GLOBAL_BUDGET_EXHAUSTED", "OTS_PROCESSING_FAILED", "PROOF_MATERIAL_MISSING", "FINGERPRINT_MISSING", null]) {
    assert.equal(otsBlocksPublication({ state: "FAILED", failureCode: code }), false, String(code));
  }
  for (const state of ["NOT_REQUESTED", "PENDING", "ANCHORED", "UNAVAILABLE"]) {
    assert.equal(otsBlocksPublication({ state, failureCode: "MALFORMED_PROOF" }), false, state);
  }
  // From real bytes.
  assert.equal(otsBlocksPublication(resolve(REAL.otherProofBase64)), true);
  assert.equal(otsBlocksPublication(resolve(truncated())), true);
  assert.equal(otsBlocksPublication(resolve(upgradedProof({ unexecutedOp: 0x02 }).base64)), true);
  assert.equal(otsBlocksPublication(resolve(upgradedProof({ trailingPayload: Buffer.from([1]) }).base64)), true);
});

// ---------------------------------------------------------------------------
// (12) the wire contract and the words
// ---------------------------------------------------------------------------

test("(12) wire contract: view round trip, conservative reads, client-owned words, localized copy", () => {
  const up = upgradedProof();
  const anchored = resolve(up.base64, { anchoredAtUtc: "2026-10-12T10:00:00Z", submittedAtUtc: "2026-10-12T09:00:00Z" });
  const view = toOtsAnchoringView(anchored);
  assert.equal(view.state, "ANCHORED");
  assert.equal(view.title, "Bitcoin anchoring");
  assert.equal(view.status, "Anchored");
  assert.equal(view.sentence, "OpenTimestamps proof anchored in Bitcoin.");
  assert.equal(view.bitcoinTxid, up.txid);
  assert.equal(view.bitcoinBlockHeight, up.blockHeight);
  assert.equal(view.anchoredAtUtc, "2026-10-12T10:00:00.000Z");
  assert.deepEqual(readOtsAnchoringView(JSON.parse(JSON.stringify(view))), view);

  // Each real state round-trips.
  for (const a of [
    resolve(REAL.boundProofBase64),
    resolve(REAL.otherProofBase64),
    resolveOtsAnchoring({ status: "PENDING", proofBase64: null, fingerprintHash: FP }),
    resolveOtsAnchoring({ status: null, proofBase64: null, fingerprintHash: FP }),
  ]) {
    const v = toOtsAnchoringView(a);
    assert.deepEqual(readOtsAnchoringView(JSON.parse(JSON.stringify(v))), v, a.state);
  }
  assert.equal(toOtsAnchoringView(resolve(REAL.otherProofBase64)).failureLabel, OTS_FAILURE_LABELS.PROOF_HASH_MISMATCH);

  // Unknown or missing state → UNAVAILABLE; the payload's words are ignored.
  for (const payload of [null, undefined, {}, { state: "CHAIN_VERIFIED" }, { state: "anchored" }, "ANCHORED"]) {
    const v = readOtsAnchoringView(payload);
    assert.equal(v.state, "UNAVAILABLE", JSON.stringify(payload));
    assert.equal(v.status, OTS_STATE_WORDS.UNAVAILABLE);
  }
  const forged = readOtsAnchoringView({
    state: "PENDING",
    status: "Anchored",
    label: "Bitcoin anchored",
    sentence: "Independently verified.",
    tone: "success",
    bitcoinTxid: up.txid,
    bitcoinBlockHeight: 842_105,
    anchoredAtUtc: "2026-10-12T10:00:00.000Z",
    failureCode: "MALFORMED_PROOF",
  });
  assert.equal(forged.status, "Pending");
  assert.equal(forged.label, "Bitcoin anchoring pending");
  assert.equal(forged.sentence, "OpenTimestamps proof is awaiting Bitcoin anchoring.");
  assert.equal(forged.tone, "neutral");
  // txid / height / anchoredAt dropped unless ANCHORED; a failure code only on FAILED/UNAVAILABLE.
  assert.equal(forged.bitcoinTxid, null);
  assert.equal(forged.bitcoinBlockHeight, null);
  assert.equal(forged.anchoredAtUtc, null);
  assert.equal(forged.failureCode, null);
  // toOtsAnchoringView drops them too for a non-anchored state.
  const pendingView = toOtsAnchoringView({ ...anchored, state: "PENDING" });
  assert.equal(pendingView.bitcoinTxid, null);
  assert.equal(pendingView.bitcoinBlockHeight, null);
  assert.equal(pendingView.anchoredAtUtc, null);
  // An ANCHORED payload with a malformed height reads null, never a guess.
  assert.equal(readOtsAnchoringView({ state: "ANCHORED", bitcoinBlockHeight: -1 }).bitcoinBlockHeight, null);
  assert.equal(readOtsAnchoringView({ state: "ANCHORED", bitcoinBlockHeight: "842105" }).bitcoinBlockHeight, null);
  assert.equal(parseOtsState("STALE"), "UNAVAILABLE");
  assert.equal(parseOtsState("NOT_CHECKED"), "UNAVAILABLE");

  // presentOtsAnchoring.
  const p = presentOtsAnchoring({ state: "ANCHORED" });
  assert.equal(p.title, "Bitcoin anchoring");
  assert.equal(p.status, "Anchored");
  assert.equal(p.tone, "success");
  assert.equal(p.sentence, "OpenTimestamps proof anchored in Bitcoin.");
  assert.equal(presentOtsAnchoring({ state: "FAILED" }).tone, "danger");
  for (const s of ["PENDING", "NOT_REQUESTED", "UNAVAILABLE"]) assert.equal(presentOtsAnchoring({ state: s }).tone, "neutral");

  // Localized copy: every state, every failure label, en/de/ar; unknown locale → en.
  const en = otsAnchoringCopy("en");
  for (const locale of ["en", "de", "ar"]) {
    const c = otsAnchoringCopy(locale);
    assert.ok(c.title.trim());
    assert.ok(c.boundary.trim());
    for (const s of OTS_STATES) {
      assert.ok(c.words[s]?.trim(), `${locale} word ${s}`);
      assert.ok(c.labels[s]?.trim(), `${locale} label ${s}`);
      assert.ok(c.sentences[s]?.trim(), `${locale} sentence ${s}`);
    }
    assert.deepEqual(Object.keys(c.failureLabels).sort(), Object.keys(OTS_FAILURE_LABELS).sort(), locale);
    for (const k of Object.keys(OTS_FAILURE_LABELS)) assert.ok(c.failureLabels[k]?.trim(), `${locale} ${k}`);
  }
  assert.equal(en.boundary, OTS_ANCHORED_BOUNDARY);
  assert.equal(en.sentences.ANCHORED, "OpenTimestamps proof anchored in Bitcoin.");
  assert.equal(otsAnchoringCopy("de-AT").title, "Bitcoin-Verankerung");
  assert.equal(otsAnchoringCopy("fr"), en);
  assert.equal(otsAnchoringCopy(null), en);
  assert.equal(otsAnchoringCopy(undefined), en);
});

// ---------------------------------------------------------------------------
// The executor on real bytes
// ---------------------------------------------------------------------------

test("parser: parseOtsProof executes the real pending proof and the upgraded proof", () => {
  const pending = parseOtsProof(REAL.boundProofBase64);
  assert.equal(pending.majorVersion, 1);
  assert.equal(pending.fileDigestAlgorithm, "sha256");
  assert.equal(pending.committedDigestHex, FP);
  assert.deepEqual(pending.bitcoinAttestations, []);
  assert.deepEqual(pending.bitcoinBlockHeights, []);
  assert.ok(pending.pendingCalendars.length >= 1);
  assert.ok(pending.attestations.every((a) => a.kind === "PENDING"));
  // Accepts raw bytes as well as base64.
  assert.equal(parseOtsProof(Buffer.from(REAL.boundProofBase64, "base64")).committedDigestHex, FP);

  const up = upgradedProof({ blockHeight: 777_777 });
  const parsed = parseOtsProof(up.base64);
  assert.deepEqual(parsed.bitcoinAttestations, [{ blockHeight: 777_777, merkleRootHex: up.merkleRootHex, bitcoinTxid: up.txid }]);
  assert.deepEqual(parsed.bitcoinBlockHeights, [777_777]);
  assert.equal(parsed.unexecutedBitcoinAttestations, 0);
  assert.equal(parsed.invalidBitcoinAttestations, 0);

  const unexecuted = parseOtsProof(upgradedProof({ unexecutedOp: 0x02 }).base64);
  assert.equal(unexecuted.unexecutedBitcoinAttestations, 1);
  assert.deepEqual(unexecuted.bitcoinAttestations, []);
  const invalid = parseOtsProof(upgradedProof({ trailingPayload: Buffer.from([7]) }).base64);
  assert.equal(invalid.invalidBitcoinAttestations, 1);
  assert.deepEqual(invalid.bitcoinAttestations, []);

  assert.throws(() => parseOtsProof(truncated()), /MALFORMED_PROOF/);
  assert.throws(() => parseOtsProof(badMagic()), /MALFORMED_PROOF/);
});

test("parser: checkOtsDigestBinding on real bytes", () => {
  const match = checkOtsDigestBinding({ proofBase64: REAL.boundProofBase64, fingerprintHash: FP, otsHash: FP });
  assert.equal(match.kind, "MATCH");
  assert.equal(match.committedDigestHex, FP);
  assert.deepEqual(match.bitcoinAttestations, []);
  // Upper-case fingerprint still binds.
  assert.equal(checkOtsDigestBinding({ proofBase64: REAL.boundProofBase64, fingerprintHash: FP.toUpperCase() }).kind, "MATCH");

  const other = checkOtsDigestBinding({ proofBase64: REAL.otherProofBase64, fingerprintHash: FP });
  assert.equal(other.kind, "MISMATCH");
  assert.equal(other.reason, "PROOF_COMMITS_TO_OTHER_DIGEST");
  assert.equal(other.committedDigestHex, REAL.otherDigest);

  const otsHash = checkOtsDigestBinding({ proofBase64: REAL.boundProofBase64, fingerprintHash: FP, otsHash: REAL.otherDigest });
  assert.equal(otsHash.kind, "MISMATCH");
  assert.equal(otsHash.reason, "OTS_HASH_IS_NOT_FINGERPRINT");

  assert.equal(checkOtsDigestBinding({ proofBase64: truncated(), fingerprintHash: FP }).code, "MALFORMED_PROOF");
  assert.equal(checkOtsDigestBinding({ proofBase64: REAL.boundProofBase64, fingerprintHash: null }).code, "NO_FINGERPRINT");
  assert.equal(checkOtsDigestBinding({ proofBase64: null, fingerprintHash: FP }).kind, "ABSENT");
});

test("parser: isSerializedBitcoinTransaction accepts exactly one transaction", () => {
  const { tx } = txAround(Buffer.alloc(32));
  assert.equal(isSerializedBitcoinTransaction(tx), true);
  assert.equal(isSerializedBitcoinTransaction(Buffer.concat([tx, Buffer.from([0])])), false);
  assert.equal(isSerializedBitcoinTransaction(tx.subarray(0, tx.length - 1)), false);
  assert.equal(isSerializedBitcoinTransaction(Buffer.alloc(32)), false);
});

test("deriveAnchorSemantics projects the canonical state and never decides it", () => {
  const anchored = deriveAnchorSemantics({ transactionId: `  ${"ab".repeat(32)}  `, otsState: "ANCHORED" });
  assert.deepEqual(anchored, {
    transactionId: "ab".repeat(32),
    hasTransactionId: true,
    otsState: "ANCHORED",
    anchoringLabel: "Bitcoin anchored",
    anchorMode: "anchored",
  });
  // A txid on a PENDING record does not make it anchored.
  const pending = deriveAnchorSemantics({ transactionId: "ab".repeat(32), otsState: "PENDING" });
  assert.equal(pending.anchorMode, "bitcoin_anchoring_pending");
  assert.equal(pending.anchoringLabel, "Bitcoin anchoring pending");
  assert.equal(deriveAnchorSemantics({ transactionId: "  ", otsState: "ANCHORED" }).hasTransactionId, false);
  assert.equal(deriveAnchorSemantics({ otsState: "FAILED" }).anchorMode, "failed");
  assert.equal(deriveAnchorSemantics({ otsState: "UNAVAILABLE" }).anchorMode, "unavailable");
  assert.equal(deriveAnchorSemantics({ otsState: "NOT_REQUESTED" }).anchorMode, "not_configured");
});

// ---------------------------------------------------------------------------
// Mutations of an anchored proof
// ---------------------------------------------------------------------------

test("mutation: flipping one byte of the digest inside an anchored proof is never ANCHORED", () => {
  const up = upgradedProof();
  assert.equal(resolve(up.base64).state, "ANCHORED");
  const b = Buffer.from(up.bytes);
  const digestStart = 31 + 1 + 1; // magic, version, file-hash op
  assert.equal(b.subarray(digestStart, digestStart + 32).toString("hex"), FP);
  b[digestStart + 5] ^= 0x01;
  const a = resolve(b.toString("base64"), { status: "ANCHORED" });
  assert.notEqual(a.state, "ANCHORED");
  assert.equal(a.state, "FAILED");
  assert.equal(a.failureCode, "PROOF_HASH_MISMATCH");
  assert.equal(a.bitcoinBlockHeight, null);
});

test("mutation: changing the block-height payload encoding is INVALID_ATTESTATION", () => {
  const up = upgradedProof();
  const b = up.bytes;
  const at = b.indexOf(BITCOIN_TAG);
  assert.ok(at > 0);
  const lenAt = at + BITCOIN_TAG.length;
  const len = b[lenAt];
  // Re-encode the payload as height + one extra byte (two values where one is allowed).
  const reencoded = Buffer.concat([
    b.subarray(0, lenAt),
    Buffer.from([len + 1]),
    b.subarray(lenAt + 1, lenAt + 1 + len),
    Buffer.from([0x00]),
    b.subarray(lenAt + 1 + len),
  ]);
  const a = resolve(reencoded.toString("base64"), { status: "ANCHORED" });
  assert.equal(a.state, "FAILED");
  assert.equal(a.failureCode, "INVALID_ATTESTATION");

  // A height whose varuint runs past its payload cannot be read at all.
  const runaway = Buffer.from(b);
  runaway[lenAt + len] |= 0x80;
  const r = resolve(runaway.toString("base64"), { status: "ANCHORED" });
  assert.equal(r.state, "FAILED");
  assert.equal(r.failureCode, "MALFORMED_PROOF");
});

test("mutation: removing the transaction step sets txid null but keeps ANCHORED", () => {
  const withTx = resolve(upgradedProof({ withTransaction: true }).base64);
  const withoutTx = resolve(upgradedProof({ withTransaction: false }).base64);
  assert.equal(withTx.state, "ANCHORED");
  assert.equal(withoutTx.state, "ANCHORED");
  assert.match(withTx.bitcoinTxid, /^[0-9a-f]{64}$/);
  assert.equal(withoutTx.bitcoinTxid, null);
  assert.notEqual(withTx.merkleRootHex, withoutTx.merkleRootHex);
});

test("mutation: swapping a merkle sibling changes the merkle root and stays ANCHORED (no node: the root is not checked against a chain)", () => {
  const up = upgradedProof();
  const sibling = sha(Buffer.from("sibling-1"));
  const at = up.bytes.indexOf(sibling);
  assert.ok(at > 0);
  const swapped = Buffer.from(up.bytes);
  sha(Buffer.from("another-sibling")).copy(swapped, at);
  const a = resolve(swapped.toString("base64"));
  assert.equal(a.state, "ANCHORED");
  assert.notEqual(a.merkleRootHex, up.merkleRootHex);
  assert.match(a.merkleRootHex, /^[0-9a-f]{64}$/);
  // The leaf side is untouched, so the transaction is the same.
  assert.equal(a.bitcoinTxid, up.txid);
  assert.notEqual(a.proofSha256, up.proofSha256);
  // That boundary is stated wherever ANCHORED is.
  assert.match(OTS_ANCHORED_BOUNDARY, /does not claim independent canonical-chain verification/);
});
