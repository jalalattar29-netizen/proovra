/**
 * INDEPENDENT BITCOIN-CHAIN VERIFICATION — the pure authority
 * (src/ots-chain-verification.ts) and the CI gate that no OpenTimestamps
 * proof which was not chain-verified can reach any positive claim.
 *
 * Headers are built here with node:crypto, independently of the module under
 * test: the 80-byte serialization, the double SHA-256 block hash (displayed
 * reversed) and the merkle root at bytes 36..68 in Bitcoin INTERNAL order —
 * the order the reference client (opentimestamps 0.4.5,
 * verify_against_blockheader) compares the replayed message in.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  BITCOIN_MAINNET_GENESIS_HASH,
  BITCOIN_MAINNET_GENESIS_HEADER_HEX,
  OTS_CHAIN_POLICY_DEFAULTS,
  OTS_COMPONENT_STATE,
  OTS_TRUST_BY_VERIFICATION,
  OTS_VERIFICATION_KEYS,
  OTS_VERIFICATION_TONES,
  TRUST_SIGNAL_STATE_PRESENTATION,
  VERIFICATION_STATUS_LABELS,
  bindOtsChainRecord,
  decideOtsChainVerification,
  deriveAnchorSemantics,
  deriveTrustPresentation,
  evaluateOtsChainReadiness,
  formatOtsChainVerifier,
  orderOtsChainCandidates,
  otsMatrixStatusOf,
  parseBitcoinHeader,
  parseOtsChainVerifier,
  presentOtsAnchoring,
  reclassifyAfterPriorVerification,
  resolveOtsAnchoring,
  toVerificationStatus,
  verifyOtsChainCandidate,
} from "../dist/index.js";
import { REAL, chainRecordFor, upgradedProof } from "./helpers/ots-fixtures.mjs";

const sha = (b) => createHash("sha256").update(b).digest();
const dsha = (b) => sha(sha(b));
const FP = REAL.boundFingerprintHash;
const POLICY = OTS_CHAIN_POLICY_DEFAULTS;

/** An 80-byte header whose merkle root (internal order) is `merkleInternalHex`. */
function header({ merkleInternalHex, time = 1_714_564_800, prev = Buffer.alloc(32, 7), nonce = 42 }) {
  const h = Buffer.alloc(80);
  h.writeUInt32LE(0x20000000, 0);
  prev.copy(h, 4);
  Buffer.from(merkleInternalHex, "hex").copy(h, 36);
  h.writeUInt32LE(time, 68);
  h.writeUInt32LE(0x17034219, 72);
  h.writeUInt32LE(nonce, 76);
  return { raw: h, rawHex: h.toString("hex"), hash: Buffer.from(dsha(h)).reverse().toString("hex") };
}
const lookupFor = (h, { height, confirmations = 100, merkleroot } = {}) => ({
  found: true,
  blockHash: h.hash,
  rawHeaderHex: h.rawHex,
  verbose: { height, confirmations, hash: h.hash, merkleroot: merkleroot ?? Buffer.from(h.raw.subarray(36, 68)).reverse().toString("hex") },
});

// ---------------------------------------------------------------------------
// Byte order, headers and the genesis probe
// ---------------------------------------------------------------------------

test("byte order: the replayed commitment is compared to raw header bytes 36..68 (internal order), never to the display-order merkleroot", () => {
  const up = upgradedProof();
  const h = header({ merkleInternalHex: up.merkleRootHex });
  const ok = verifyOtsChainCandidate({ blockHeight: up.blockHeight, merkleRootInternalHex: up.merkleRootHex }, lookupFor(h, { height: up.blockHeight }), POLICY);
  assert.equal(ok.status, "VERIFIED");
  // The same root written into the header in DISPLAY order does not match.
  const reversed = header({ merkleInternalHex: Buffer.from(up.merkleRootHex, "hex").reverse().toString("hex") });
  const wrongOrder = verifyOtsChainCandidate({ blockHeight: up.blockHeight, merkleRootInternalHex: up.merkleRootHex }, lookupFor(reversed, { height: up.blockHeight }), POLICY);
  assert.equal(wrongOrder.status, "FAILED");
  assert.equal(wrongOrder.code, "ROOT_MISMATCH");
});

test("the Bitcoin mainnet genesis header parses, hashes to the genesis hash, and carries the known merkle root", () => {
  const g = parseBitcoinHeader(BITCOIN_MAINNET_GENESIS_HEADER_HEX);
  assert.equal(g.hashHex, BITCOIN_MAINNET_GENESIS_HASH);
  // 4a5e1e4b…a33b displayed; 3ba3edfd…5e4a internal.
  assert.equal(g.merkleRootInternalHex, "3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a");
  assert.equal(new Date(g.timeSeconds * 1000).toISOString(), "2009-01-03T18:15:05.000Z");
  for (const bad of ["", "00", "zz".repeat(80), BITCOIN_MAINNET_GENESIS_HEADER_HEX + "00"]) assert.equal(parseBitcoinHeader(bad), null, bad.slice(0, 8));
});

test("a header that does not hash to the RPC block hash, names another block, or has another height is INVALID_HEADER", () => {
  const up = upgradedProof();
  const h = header({ merkleInternalHex: up.merkleRootHex });
  const c = { blockHeight: up.blockHeight, merkleRootInternalHex: up.merkleRootHex };
  const tampered = { ...lookupFor(h, { height: up.blockHeight }), blockHash: "11".repeat(32) };
  assert.equal(verifyOtsChainCandidate(c, tampered, POLICY).code, "INVALID_HEADER");
  const shortRaw = { ...lookupFor(h, { height: up.blockHeight }), rawHeaderHex: h.rawHex.slice(0, 158) };
  assert.equal(verifyOtsChainCandidate(c, shortRaw, POLICY).code, "INVALID_HEADER");
  const otherHeight = lookupFor(h, { height: up.blockHeight + 1 });
  assert.equal(verifyOtsChainCandidate(c, otherHeight, POLICY).code, "INVALID_HEADER");
  const inconsistentVerbose = lookupFor(h, { height: up.blockHeight, merkleroot: "22".repeat(32) });
  assert.equal(verifyOtsChainCandidate(c, inconsistentVerbose, POLICY).code, "INVALID_HEADER");
});

test("active chain and confirmations: -1/0 is NOT_IN_ACTIVE_CHAIN; below policy is INSUFFICIENT_CONFIRMATIONS; beyond the tip is NOT_IN_ACTIVE_CHAIN", () => {
  const up = upgradedProof();
  const h = header({ merkleInternalHex: up.merkleRootHex });
  const c = { blockHeight: up.blockHeight, merkleRootInternalHex: up.merkleRootHex };
  assert.equal(verifyOtsChainCandidate(c, lookupFor(h, { height: up.blockHeight, confirmations: -1 }), POLICY).code, "NOT_IN_ACTIVE_CHAIN");
  assert.equal(verifyOtsChainCandidate(c, lookupFor(h, { height: up.blockHeight, confirmations: 0 }), POLICY).code, "NOT_IN_ACTIVE_CHAIN");
  const shallow = verifyOtsChainCandidate(c, lookupFor(h, { height: up.blockHeight, confirmations: 5 }), POLICY);
  assert.equal(shallow.status, "INSUFFICIENT_CONFIRMATIONS");
  assert.equal(shallow.confirmations, 5);
  assert.equal(verifyOtsChainCandidate(c, lookupFor(h, { height: up.blockHeight, confirmations: 6 }), POLICY).status, "VERIFIED");
  assert.equal(verifyOtsChainCandidate(c, { found: false }, POLICY).code, "NOT_IN_ACTIVE_CHAIN");
  // A block that a prior check VERIFIED and that is no longer in the active chain is REORGED.
  const dropped = decideOtsChainVerification([verifyOtsChainCandidate(c, lookupFor(h, { height: up.blockHeight, confirmations: -1 }), POLICY)]);
  assert.equal(reclassifyAfterPriorVerification(dropped, { status: "VERIFIED", blockHash: h.hash }).failureCode, "REORGED");
  assert.equal(reclassifyAfterPriorVerification(dropped, { status: null, blockHash: null }).failureCode, "NOT_IN_ACTIVE_CHAIN");
  // A REPLACEMENT block at that height has another merkle root: after a prior
  // VERIFIED (or an already-recorded REORGED) that is a reorg, never the
  // terminal ROOT_MISMATCH — the record must recover when the chain returns.
  const replaced = decideOtsChainVerification([
    verifyOtsChainCandidate(c, lookupFor(header({ merkleInternalHex: "ab".repeat(32) }), { height: up.blockHeight, confirmations: 3 }), POLICY),
  ]);
  assert.equal(replaced.failureCode, "ROOT_MISMATCH");
  assert.equal(reclassifyAfterPriorVerification(replaced, { status: "VERIFIED", blockHash: h.hash }).failureCode, "REORGED");
  assert.equal(reclassifyAfterPriorVerification(replaced, { status: "FAILED", blockHash: null, failureCode: "REORGED" }).failureCode, "REORGED");
  assert.equal(reclassifyAfterPriorVerification(replaced, { status: null, blockHash: null }).failureCode, "ROOT_MISMATCH");
  assert.equal(reclassifyAfterPriorVerification(replaced, { status: "FAILED", blockHash: null, failureCode: "ROOT_MISMATCH" }).failureCode, "ROOT_MISMATCH");
});

// ---------------------------------------------------------------------------
// The mutation catalogue: what the product's replay yields vs a real header
// ---------------------------------------------------------------------------

function mutate(bytes, needle) {
  const b = Buffer.from(bytes);
  const at = b.indexOf(needle);
  assert.ok(at > 0);
  b[at] ^= 0x01;
  return b;
}

test("the chain check rejects every digest-path mutation the parser alone accepts (sibling, nonce, transaction, graft, fabrication)", () => {
  const up = upgradedProof();
  const h = header({ merkleInternalHex: up.merkleRootHex }); // the block the GENUINE proof commits to
  const verdict = (bytes) => {
    const a = resolveOtsAnchoring({ status: "ANCHORED", proofBase64: Buffer.from(bytes).toString("base64"), fingerprintHash: FP });
    if (a.state !== "ANCHORED") return `parser:${a.state}`;
    // Without any chain fact the parser result is only an attestation recorded.
    assert.equal(a.verification, "ATTESTATION_RECORDED");
    const outcomes = a.bitcoinAttestations.map((att) =>
      verifyOtsChainCandidate({ blockHeight: att.blockHeight, merkleRootInternalHex: att.merkleRootHex }, att.blockHeight === up.blockHeight ? lookupFor(h, { height: att.blockHeight }) : { found: false }, POLICY),
    );
    const d = decideOtsChainVerification(outcomes);
    return d.status === "VERIFIED" ? "VERIFIED" : `${d.status}:${d.failureCode}`;
  };
  assert.equal(verdict(up.bytes), "VERIFIED");
  assert.equal(verdict(mutate(up.bytes, sha(Buffer.from("sibling-1")))), "FAILED:ROOT_MISMATCH");
  assert.equal(verdict(mutate(up.bytes, Buffer.alloc(16, 0x5a))), "FAILED:ROOT_MISMATCH");
  assert.equal(verdict(mutate(up.bytes, Buffer.alloc(32, 0x11))), "FAILED:ROOT_MISMATCH");
  // Another digest's anchored branch grafted beneath this digest's header.
  const other = upgradedProof({ base64: REAL.otherProofBase64, blockHeight: up.blockHeight });
  const graft = Buffer.concat([up.bytes.subarray(0, 65), other.bytes.subarray(65)]);
  assert.match(verdict(graft), /^(FAILED:ROOT_MISMATCH|VERIFIED)$/);
  // (The fixture's branch ops are digest-independent, so a same-op graft replays
  // to the same root; a graft with different ops must mismatch:)
  const g2 = upgradedProof({ base64: REAL.otherProofBase64, blockHeight: up.blockHeight, merkleLevels: 2 });
  assert.equal(verdict(Buffer.concat([up.bytes.subarray(0, 65), g2.bytes.subarray(65)])), "FAILED:ROOT_MISMATCH");
  // A fabricated proof: this digest, one sha256, a made-up height attestation.
  const varuint = (n) => { const o = []; do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; o.push(b); } while (n > 0); return Buffer.from(o); };
  const fab = (height) => Buffer.concat([up.bytes.subarray(0, 65), Buffer.from([0x08, 0x00]), Buffer.from("0588960d73d71901", "hex"), varuint(varuint(height).length), varuint(height)]);
  assert.equal(verdict(fab(up.blockHeight)), "FAILED:ROOT_MISMATCH");
  assert.equal(verdict(fab(123_456)), "FAILED:NOT_IN_ACTIVE_CHAIN");
  // Changed digest / header digest / truncation never even reach ANCHORED.
  assert.equal(verdict(mutate(up.bytes, Buffer.from(FP, "hex"))), "parser:FAILED");
  assert.equal(verdict(up.bytes.subarray(0, up.bytes.length - 3)), "parser:FAILED");
});

test("mixed attestations: a malformed Bitcoin attestation beside a valid one fails the proof; multiple valid ones are verified in ascending height", () => {
  const up = upgradedProof({ blockHeight: 842_105 });
  const varuint = (n) => { const o = []; do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; o.push(b); } while (n > 0); return Buffer.from(o); };
  const badBranch = Buffer.concat([Buffer.from([0xf0, 2]), Buffer.from("zz"), Buffer.from([0x00]), Buffer.from("0588960d73d71901", "hex"), Buffer.from([1, 5])]);
  // tree := (0xff branch)* branch — the malformed branch first, then the genuine tree.
  const mixed = Buffer.concat([up.bytes.subarray(0, 65), Buffer.from([0xff]), badBranch, up.bytes.subarray(65)]);
  const a = resolveOtsAnchoring({ status: "ANCHORED", proofBase64: mixed.toString("base64"), fingerprintHash: FP });
  assert.equal(a.state, "FAILED");
  assert.equal(a.failureCode, "INVALID_ATTESTATION");
  // Ordering: ascending height, deterministic, duplicates removed.
  const ordered = orderOtsChainCandidates([
    { blockHeight: 9, merkleRootInternalHex: "bb" },
    { blockHeight: 3, merkleRootInternalHex: "cc" },
    { blockHeight: 9, merkleRootInternalHex: "aa" },
    { blockHeight: 3, merkleRootInternalHex: "cc" },
  ]);
  assert.deepEqual(ordered.map((c) => `${c.blockHeight}:${c.merkleRootInternalHex}`), ["3:cc", "9:aa", "9:bb"]);
  // The first candidate that passes establishes VERIFIED; earlier rejects stay as bounded diagnostics.
  const d = decideOtsChainVerification([
    { status: "FAILED", code: "ROOT_MISMATCH", blockHeight: 3, detail: "x" },
    { status: "INSUFFICIENT_CONFIRMATIONS", blockHeight: 5, blockHash: "a".repeat(64), blockTimeUtc: "2024-01-01T00:00:00.000Z", confirmations: 2 },
    { status: "VERIFIED", blockHeight: 9, blockHash: "b".repeat(64), blockTimeUtc: "2024-01-02T00:00:00.000Z", confirmations: 50 },
  ]);
  assert.equal(d.status, "VERIFIED");
  assert.equal(d.blockHeight, 9);
  assert.deepEqual(d.rejected, [{ blockHeight: 3, code: "ROOT_MISMATCH" }, { blockHeight: 5, code: "INSUFFICIENT_CONFIRMATIONS" }]);
  // No verified candidate: confirmations pending outranks a contradiction.
  assert.equal(decideOtsChainVerification(d.rejected.length ? [
    { status: "FAILED", code: "ROOT_MISMATCH", blockHeight: 3, detail: "x" },
    { status: "INSUFFICIENT_CONFIRMATIONS", blockHeight: 5, blockHash: "a".repeat(64), blockTimeUtc: "2024-01-01T00:00:00.000Z", confirmations: 2 },
  ] : []).status, "INSUFFICIENT_CONFIRMATIONS");
  assert.equal(decideOtsChainVerification([]).failureCode, "NO_BITCOIN_ATTESTATION");
});

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

const NOW = 1_800_000_000;
const ready = (over = {}) => ({
  network: { version: 310100, subversion: "/Satoshi:31.1.0/", ...over.network },
  chain: { chain: "main", blocks: 900_000, headers: 900_000, initialblockdownload: false, verificationprogress: 0.9999998, time: NOW - 600, bestblockhash: "00".repeat(32), warnings: "", ...over.chain },
  genesis: { hash: BITCOIN_MAINNET_GENESIS_HASH, rawHeaderHex: BITCOIN_MAINNET_GENESIS_HEADER_HEX, ...over.genesis },
});

test("readiness: every gate refuses with its own bounded code; a ready node reports its tip and version", () => {
  const ok = evaluateOtsChainReadiness(ready(), POLICY, NOW);
  assert.deepEqual(ok, { ready: true, chain: "main", tipHeight: 900_000, tipHash: "00".repeat(32), nodeVersion: 310100, nodeSubversion: "/Satoshi:31.1.0/" });
  const code = (over) => evaluateOtsChainReadiness(ready(over), POLICY, NOW).code;
  assert.equal(code({ network: { version: 260000 } }), "UNSUPPORTED_NODE_VERSION");
  assert.equal(code({ chain: { chain: "test" } }), "WRONG_CHAIN");
  assert.equal(code({ chain: { chain: "regtest" } }), "WRONG_CHAIN");
  assert.equal(code({ chain: { initialblockdownload: true } }), "INITIAL_BLOCK_DOWNLOAD");
  assert.equal(code({ chain: { verificationprogress: 0.42 } }), "INITIAL_BLOCK_DOWNLOAD");
  assert.equal(code({ chain: { headers: 900_050 } }), "HEADER_LAG");
  assert.equal(code({ chain: { headers: 899_000 } }), "HEADER_LAG");
  // A small negative lag (header tip briefly below the validated tip after a reorg) is not "behind".
  assert.equal(code({ chain: { headers: 899_996 } }), undefined);
  assert.equal(code({ chain: { headers: 900_000 - 145 } }), "HEADER_LAG");
  assert.equal(code({ chain: { time: NOW - 5 * 3600 } }), "NODE_STALE");
  assert.equal(code({ chain: { warnings: "This is a pre-release test build" } }), "NODE_WARNINGS");
  assert.equal(code({ chain: { warnings: ["", "Unknown new rules activated"] } }), "NODE_WARNINGS");
  assert.equal(evaluateOtsChainReadiness(ready({ chain: { warnings: [] } }), POLICY, NOW).ready, true);
  assert.equal(code({ genesis: { hash: "11".repeat(32) } }), "GENESIS_MISMATCH");
  assert.equal(code({ genesis: { rawHeaderHex: BITCOIN_MAINNET_GENESIS_HEADER_HEX.replace(/7c$/, "7d") } }), "GENESIS_MISMATCH");
  // Details never echo a credential-shaped value back unbounded.
  const long = evaluateOtsChainReadiness(ready({ chain: { warnings: "x".repeat(5000) } }), POLICY, NOW);
  assert.ok(long.detail.length < 200);
});

// ---------------------------------------------------------------------------
// The persisted record is bound to THIS proof
// ---------------------------------------------------------------------------

test("a stored chain record counts only for the proof it names, a height the proof attests, and complete evidence", () => {
  const up = upgradedProof();
  const proof = { proofSha256: up.proofSha256, attestedHeights: [up.blockHeight] };
  assert.equal(bindOtsChainRecord(chainRecordFor(up), proof).status, "VERIFIED");
  assert.equal(bindOtsChainRecord(chainRecordFor(up), proof).minConfirmations, 6);
  assert.equal(bindOtsChainRecord(chainRecordFor(up, { proofSha256: "e".repeat(64) }), proof), null);
  assert.equal(bindOtsChainRecord(chainRecordFor(up, { blockHeight: up.blockHeight + 1 }), proof), null);
  assert.equal(bindOtsChainRecord({ ...chainRecordFor(up), blockHash: null }, proof), null);
  assert.equal(bindOtsChainRecord({ ...chainRecordFor(up), confirmations: 0 }, proof), null);
  assert.equal(bindOtsChainRecord({ ...chainRecordFor(up), verifier: "something-else/9;proof=" + up.proofSha256.slice(0, 16) }, proof), null);
  assert.equal(bindOtsChainRecord({ ...chainRecordFor(up), status: "VERIFIED_PLUS" }, proof), null);
  assert.equal(bindOtsChainRecord(null, proof), null);
  // The verifier identity round-trips and carries no URL, user or secret.
  const v = formatOtsChainVerifier({ nodeVersion: 310100, minConfirmations: 6, proofSha256: up.proofSha256 });
  assert.equal(v, `proovra-ots-chain/1;core=310100;min=6;proof=${up.proofSha256.slice(0, 16)}`);
  assert.ok(v.length <= 120);
  assert.deepEqual(parseOtsChainVerifier(v), { name: "proovra-ots-chain/1", core: "310100", minConfirmations: 6, proofPrefix: up.proofSha256.slice(0, 16) });
  assert.doesNotMatch(v, /http|:\/\/|@|user|pass/i);
});

// ---------------------------------------------------------------------------
// THE CI GATE: no unchecked anchoring reaches a positive claim, anywhere.
// ---------------------------------------------------------------------------

test("CI GATE: only CHAIN_VERIFIED maps to PASSED, VERIFIED, 'verified', success, 'Verified', chain_verified or VERIFIED_FINALIZED", () => {
  for (const key of OTS_VERIFICATION_KEYS) {
    const positive = key === "CHAIN_VERIFIED";
    const trust = OTS_TRUST_BY_VERIFICATION[key];
    assert.equal(trust === "PASSED", positive, `${key} trust ${trust}`);
    assert.equal(TRUST_SIGNAL_STATE_PRESENTATION[trust].countsAsPassed, positive, key);
    assert.equal(TRUST_SIGNAL_STATE_PRESENTATION[trust].label === "Verified", positive, key);
    assert.equal(otsMatrixStatusOf(key) === "VERIFIED", positive, `${key} matrix`);
    assert.equal(VERIFICATION_STATUS_LABELS[otsMatrixStatusOf(key)] === "Verified", positive, key);
    assert.equal(OTS_COMPONENT_STATE[key] === "verified", positive, `${key} basic`);
    assert.equal(OTS_VERIFICATION_TONES[key] === "success", positive, `${key} tone`);
    const state = key === "NOT_REQUESTED" || key === "PENDING" || key === "FAILED" || key === "UNAVAILABLE" ? key : "ANCHORED";
    assert.equal(presentOtsAnchoring({ state, verification: key }).tone === "success", positive, key);
    assert.equal(deriveAnchorSemantics({ otsState: state, otsVerification: key }).anchorMode === "chain_verified", positive, key);
    const signals = [
      { key: "core_integrity", state: "PASSED", summary: "" },
      { key: "signature", state: "PASSED", summary: "" },
      { key: "custody_chain", state: "PASSED", summary: "" },
      { key: "trusted_timestamp", state: "PASSED", summary: "" },
      { key: "bitcoin_anchoring", state: trust, summary: "" },
    ];
    const p = deriveTrustPresentation(signals);
    assert.equal(p.presentationState === "VERIFIED_FINALIZED", positive, `${key} finalized`);
    assert.equal(p.anchoringState === "verified", positive, `${key} bucket`);
    assert.equal(toVerificationStatus(trust) === "VERIFIED", positive, key);
  }
  // A real upgraded proof with no chain fact — the case the audit reproduced — is not positive anywhere.
  const a = resolveOtsAnchoring({ status: "ANCHORED", proofBase64: upgradedProof().base64, fingerprintHash: FP });
  assert.equal(a.state, "ANCHORED");
  assert.equal(a.verification, "ATTESTATION_RECORDED");
  assert.notEqual(presentOtsAnchoring(a).tone, "success");
});
