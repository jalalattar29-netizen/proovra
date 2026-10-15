/**
 * THE VERIFICATION PACKAGE'S OPENTIMESTAMPS MATERIAL — `decideOtsPackageArtifact`
 * (2026-10-13), on REAL OpenTimestamps bytes.
 *
 *   * the state is the canonical resolution against the package's own
 *     fingerprint digest (sha256 of fingerprint.json);
 *   * the .ots file is the stored proof's exact bytes, included only when they
 *     commit to that digest; opentimestamps.json states the state, the
 *     digest ↔ proof mapping, the proof SHA-256, the attestation facts and the
 *     validator;
 *   * a proof-integrity failure refuses the package; NOT_REQUESTED emits
 *     nothing; a txid only when the executed path derives it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { OTS_ANCHORED_BOUNDARY, OTS_CHAIN_VERIFIED_BOUNDARY } from "@proovra/shared";
import { describe, expect, it } from "vitest";

import { REAL, proofSha256, upgradedProof } from "../../../packages/shared/tests/helpers/ots-fixtures.mjs";
import { chainRecordFor } from "./fixtures/ots-chain-fixtures.js";
import { decideOtsPackageArtifact } from "../src/verification-package.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const FP = REAL.boundFingerprintHash;
const UPGRADED = upgradedProof({ blockHeight: 860000 });
const base = {
  hash: FP,
  fingerprintHash: FP,
  calendar: "https://a.pool.opentimestamps.org",
  anchoredAtUtc: null,
  upgradedAtUtc: null,
  failureReason: null,
};

describe("ANCHORED: a proof that executes to a Bitcoin block attestation", () => {
  const result = decideOtsPackageArtifact({
    ...base,
    status: "ANCHORED",
    proofBase64: UPGRADED.base64,
    anchoredAtUtc: "2026-10-13T08:00:00.000Z",
    submittedAtUtc: "2026-10-12T08:00:00.000Z",
  });

  it("packages the stored proof's exact bytes", () => {
    expect(Buffer.from(result.proofBytes!).equals(Buffer.from(UPGRADED.base64, "base64"))).toBe(true);
  });

  it("states the canonical state, the digest ↔ proof mapping and the attestation facts", () => {
    expect(result.companion).toMatchObject({
      schema: "PROOVRA_OPENTIMESTAMPS_STATE",
      version: 3,
      state: "ANCHORED",
      // 2026-10-15: ANCHORED only NAMES a block — an unchecked attestation.
      verification: "ATTESTATION_RECORDED",
      title: "Bitcoin anchoring",
      status: "Attestation recorded",
      label: "Bitcoin attestation recorded",
      sentence: "The proof names Bitcoin block 860000; PROOVRA has not checked it against the Bitcoin main chain.",
      evidenceDigest: { algorithm: "sha256", hex: FP, file: "fingerprint.json" },
      committedDigest: { algorithm: "sha256", hex: FP, matchesEvidenceDigest: true },
      proof: { file: "opentimestamps-proof.ots", sha256: UPGRADED.proofSha256, sizeBytes: UPGRADED.bytes.length },
      attestation: {
        type: "BITCOIN_BLOCK_HEADER",
        bitcoinBlockHeight: 860000,
        bitcoinTxid: UPGRADED.txid,
        merkleRootHex: UPGRADED.merkleRootHex,
      },
      submittedAtUtc: "2026-10-12T08:00:00.000Z",
      anchoredRecordedAtUtc: "2026-10-13T08:00:00.000Z",
      boundary: OTS_ANCHORED_BOUNDARY,
      // Never checked: no chain fact is stated.
      chainVerification: null,
    });
    expect(result.companion!.validator).toMatch(/\S/);
  });

  it("states no verified claim for an unchecked attestation", () => {
    // 2026-10-15: was "no chain-verifier vocabulary". The companion now names
    // the verification; an unchecked attestation must never read as verified.
    expect(JSON.stringify(result.companion)).not.toMatch(/CHAIN_VERIFIED|publicAnchoringVerified|anchorCheck|independently verified|verifiedAtUtc/i);
  });

  it("a proof with no transaction step is ANCHORED with no txid", () => {
    const p = upgradedProof({ withTransaction: false });
    const r = decideOtsPackageArtifact({ ...base, status: "ANCHORED", proofBase64: p.base64 });
    expect(r.companion).toMatchObject({ state: "ANCHORED", attestation: { bitcoinTxid: null } });
  });
});

describe("CHAIN_VERIFIED: the same proof, independently verified against the Bitcoin main chain", () => {
  const record = chainRecordFor(UPGRADED);
  const result = decideOtsPackageArtifact({
    ...base,
    status: "ANCHORED",
    proofBase64: UPGRADED.base64,
    anchoredAtUtc: "2026-10-13T08:00:00.000Z",
    chain: record,
  });

  it("states the verification, its sentence, the verified boundary and the bound chain facts", () => {
    expect(result.companion).toMatchObject({
      state: "ANCHORED",
      verification: "CHAIN_VERIFIED",
      status: "Independently verified",
      label: "Independently verified against the Bitcoin main chain",
      sentence: "Merkle root matches Bitcoin block 860000; 120 confirmations at 2026-10-15 08:00:00 UTC.",
      boundary: OTS_CHAIN_VERIFIED_BOUNDARY,
      chainVerification: {
        status: "VERIFIED",
        failureCode: null,
        blockHeight: 860000,
        blockHash: record.blockHash,
        confirmations: 120,
        minConfirmations: 6,
        checkedAtUtc: "2026-10-15T08:00:00.000Z",
        verifiedAtUtc: "2026-10-15T08:00:00.000Z",
        verifier: `proovra-ots-chain/1;core=310100;min=6;proof=${UPGRADED.proofSha256.slice(0, 16)}`,
      },
    });
    // The proof bytes are the same exact bytes.
    expect(Buffer.from(result.proofBytes!).equals(Buffer.from(UPGRADED.base64, "base64"))).toBe(true);
  });

  it("a chain record about ANOTHER proof is not believed: an unchecked attestation, no chain facts", () => {
    const r = decideOtsPackageArtifact({
      ...base,
      status: "ANCHORED",
      proofBase64: UPGRADED.base64,
      chain: chainRecordFor(UPGRADED, { proofSha256: "f".repeat(64) }),
    });
    expect(r.companion).toMatchObject({ verification: "ATTESTATION_RECORDED", status: "Attestation recorded", chainVerification: null });
  });

  it("pending confirmations are not verified", () => {
    const r = decideOtsPackageArtifact({ ...base, status: "ANCHORED", proofBase64: UPGRADED.base64, chain: chainRecordFor(UPGRADED, { status: "INSUFFICIENT_CONFIRMATIONS" }) });
    expect(r.companion).toMatchObject({ verification: "CHAIN_CONFIRMATIONS_PENDING", boundary: OTS_ANCHORED_BOUNDARY });
    expect(r.companion!.status).not.toMatch(/verified/i);
  });
});

describe("PENDING", () => {
  const result = decideOtsPackageArtifact({ ...base, status: "PENDING", proofBase64: REAL.boundProofBase64 });

  it("packages the pending proof and states it awaits Bitcoin", () => {
    expect(result.proofBytes).not.toBeNull();
    expect(result.companion).toMatchObject({
      state: "PENDING",
      verification: "PENDING",
      status: "Pending",
      label: "OpenTimestamps proof pending",
      sentence: "Submitted to OpenTimestamps calendars; no Bitcoin attestation yet.",
      attestation: { type: "PENDING_CALENDAR", bitcoinBlockHeight: null, bitcoinTxid: null },
      anchoredRecordedAtUtc: null,
      boundary: null,
      proof: { sha256: proofSha256(REAL.boundProofBase64) },
    });
  });

  it("a stored ANCHORED status, txid and time over a pending proof stay PENDING", () => {
    const r = decideOtsPackageArtifact({
      ...base,
      status: "ANCHORED",
      proofBase64: REAL.boundProofBase64,
      bitcoinTxid: "ab".repeat(32),
      anchoredAtUtc: "2026-10-01T00:00:00.000Z",
    });
    expect(r.companion).toMatchObject({ state: "PENDING", anchoredRecordedAtUtc: null });
    expect(JSON.stringify(r.companion)).not.toContain("ab".repeat(32));
  });
});

describe("proof-integrity failures refuse the package", () => {
  it("a proof committing to another digest", () => {
    expect(() => decideOtsPackageArtifact({ ...base, status: "PENDING", proofBase64: REAL.otherProofBase64 })).toThrow();
  });

  it("…even when the record already says FAILED", () => {
    expect(() =>
      decideOtsPackageArtifact({ ...base, status: "FAILED", proofBase64: REAL.otherProofBase64, failureReason: "PROOF_HASH_MISMATCH" }),
    ).toThrow();
  });

  it("an unreadable proof", () => {
    expect(() => decideOtsPackageArtifact({ ...base, status: "PENDING", proofBase64: Buffer.from("not a proof").toString("base64") })).toThrow();
  });

  it("a malformed Bitcoin attestation", () => {
    const p = upgradedProof({ trailingPayload: new Uint8Array([1]) });
    expect(() => decideOtsPackageArtifact({ ...base, status: "ANCHORED", proofBase64: p.base64 })).toThrow();
  });
});

describe("other states", () => {
  it("FAILED (budget) keeps its bound proof and names the reason", () => {
    const r = decideOtsPackageArtifact({ ...base, status: "FAILED", proofBase64: REAL.boundProofBase64, failureReason: "OTS_GLOBAL_BUDGET_EXHAUSTED" });
    expect(r.proofBytes).not.toBeNull();
    expect(r.companion).toMatchObject({ state: "FAILED", failureCode: "OTS_GLOBAL_BUDGET_EXHAUSTED" });
    expect(r.companion!.failureLabel).toMatch(/upgrade budget/);
  });

  it("PENDING with no proof bytes is UNAVAILABLE with no file", () => {
    const r = decideOtsPackageArtifact({ ...base, status: "PENDING", proofBase64: null });
    expect(r.proofBytes).toBeNull();
    expect(r.companion).toMatchObject({ state: "UNAVAILABLE", failureCode: "PROOF_MATERIAL_MISSING", proof: null });
  });

  it("DISABLED emits nothing, even with stale proof bytes", () => {
    const r = decideOtsPackageArtifact({ ...base, status: "DISABLED", proofBase64: REAL.boundProofBase64 });
    expect(r).toMatchObject({ proofBytes: null, companion: null });
    expect(r.anchoring.state).toBe("NOT_REQUESTED");
  });
});

describe("builder wiring (source contract)", () => {
  const processorSrc = readSource("../src/processor.ts");
  const packageSrc = readSource("../src/verification-package.ts");

  it("the processor forwards the stored proof, its client and the stored chain record (read through the one reader)", () => {
    expect(processorSrc).toMatch(/ots:\s*\{[\s\S]*?proofBase64:\s*[\s\S]*?finalized\.finalizedReportEvidencePayload\.otsProofBase64/);
    // 2026-10-15: the chain fact travels as the shared record; the resolver binds it to the proof.
    expect(processorSrc).toMatch(/chain: otsChainRecordOf\(finalized\.finalizedReportEvidencePayload\)/);
    expect(processorSrc).not.toMatch(/chainVerificationStatus:|attestationRecordedAtUtc:/);
  });

  it("the builder resolves the proof against the SHA-256 of fingerprint.json and states one state everywhere", () => {
    expect(packageSrc).toMatch(/decideOtsPackageArtifact\(\{\s*\.\.\.data\.ots,\s*fingerprintHash: sha256Hex\(Buffer\.from\(data\.fingerprint, "utf8"\)\),/);
    expect(packageSrc).toContain('"opentimestamps-proof.ots"');
    expect(packageSrc).toContain('"opentimestamps.json"');
    expect(packageSrc).toMatch(/otsState: anchorSemantics\.otsState/);
    expect(packageSrc).not.toMatch(/publicAnchoringVerified|anchoringClaim/);
  });

  it("anchor.json names the digest the proof commits to, and what anchorHash is not", () => {
    expect(packageSrc).toMatch(/otsProofCommitsTo: \{\s*digest: data\.anchor\.fingerprintHash,\s*file: "fingerprint\.json"/);
    expect(packageSrc).toContain("The OpenTimestamps proof does not commit to it");
  });
});
