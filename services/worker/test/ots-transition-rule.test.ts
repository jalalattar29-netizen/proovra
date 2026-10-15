/**
 * THE OTS TRANSITION RULE (2026-10-13), on real OpenTimestamps bytes.
 *
 * The worker decides from the executed proof (resolveOtsAnchoring): a proof
 * that executes to a valid Bitcoin block attestation over the record's digest
 * is written ANCHORED; ANCHORED is terminal per proof (no stale regression);
 * a defect is FAILED with a bounded code and the stored proof preserved; an
 * attempt error changes nothing. No deprecated column is written.
 */
import { describe, expect, it } from "vitest";

import { REAL, upgradedProof } from "../../../packages/shared/tests/helpers/ots-fixtures.mjs";
import {
  buildOtsEvidenceUpdateData,
  decideOtsTransition,
  decideStoredStatusAlignment,
  isAnchoredOtsRow,
  otsSnapshotWhere,
  type OtsRowSnapshot,
} from "../src/ots-state.js";

const FP = REAL.boundFingerprintHash;
const T0 = new Date("2026-10-01T00:00:00.000Z");
const NOW = new Date("2026-10-13T12:00:00.000Z");
const ANCHORED = upgradedProof();

function row(over: Partial<OtsRowSnapshot> = {}): OtsRowSnapshot {
  return {
    otsStatus: "PENDING",
    otsProofBase64: REAL.boundProofBase64,
    otsHash: FP,
    otsCalendar: "https://a.pool.opentimestamps.org",
    otsBitcoinTxid: null,
    otsAnchoredAtUtc: null,
    otsUpgradedAtUtc: T0,
    otsFailureReason: null,
    fingerprintHash: FP,
    otsChainVerificationStatus: null,
    otsChainCheckedAtUtc: null,
    otsChainVerifiedAtUtc: null,
    otsChainBlockHeight: null,
    otsChainBlockHash: null,
    otsChainBlockTimeUtc: null,
    otsChainConfirmations: null,
    otsChainVerifier: null,
    otsChainFailureCode: null,
    ...over,
  };
}

// Expand/contract columns that stay unused.
const DEPRECATED = ["otsAnchorCheck", "otsAttestationRecordedAtUtc", "otsAttestationBlockHeight"];

// 2026-10-15: the ots_chain_* columns are LIVE again — the one independent
// Bitcoin-chain verification of the stored proof. Only decideOtsChainTransition
// writes values into them; every proof write CLEARS them (a chain fact is about
// exactly one proof), and the CAS snapshot includes them.
const CHAIN = [
  "otsChainVerificationStatus",
  "otsChainCheckedAtUtc",
  "otsChainVerifiedAtUtc",
  "otsChainBlockHeight",
  "otsChainBlockHash",
  "otsChainBlockTimeUtc",
  "otsChainConfirmations",
  "otsChainVerifier",
  "otsChainFailureCode",
];

describe("the column writer", () => {
  it("never writes a deprecated column, and every proof write clears the chain fact, for any status", () => {
    for (const status of ["DISABLED", "PENDING", "ANCHORED", "FAILED"] as const) {
      const data = buildOtsEvidenceUpdateData({ status, proofBase64: "x", upgradedAtUtc: NOW });
      for (const key of DEPRECATED) expect(Object.keys(data)).not.toContain(key);
      // No chain fact survives a write that (re)states the proof: cleared, never set.
      for (const key of CHAIN) expect((data as Record<string, unknown>)[key]).toBeNull();
    }
  });

  it("keeps the chain fact only for a write that keeps the exact same proof (status alignment)", () => {
    const data = buildOtsEvidenceUpdateData({ status: "ANCHORED", proofBase64: "x", upgradedAtUtc: NOW, keepChain: true });
    for (const key of CHAIN) expect(Object.keys(data)).not.toContain(key);
  });

  it("writes a txid only beside ANCHORED, and only a well-formed one", () => {
    const txid = "ab".repeat(32);
    expect(buildOtsEvidenceUpdateData({ status: "PENDING", bitcoinTxid: txid }).otsBitcoinTxid).toBeNull();
    expect(buildOtsEvidenceUpdateData({ status: "FAILED", bitcoinTxid: txid }).otsBitcoinTxid).toBeNull();
    expect(buildOtsEvidenceUpdateData({ status: "ANCHORED", bitcoinTxid: txid, upgradedAtUtc: NOW }).otsBitcoinTxid).toBe(txid);
    expect(buildOtsEvidenceUpdateData({ status: "ANCHORED", bitcoinTxid: "nope", upgradedAtUtc: NOW }).otsBitcoinTxid).toBeNull();
  });
});

describe("decideOtsTransition", () => {
  it("an upgraded proof that executes to a Bitcoin attestation is written ANCHORED with the derived txid", () => {
    const t = decideOtsTransition(row(), { kind: "PROOF", proofBase64: ANCHORED.base64 }, NOW);
    expect(t.kind).toBe("WRITE");
    if (t.kind !== "WRITE") return;
    expect(t.status).toBe("ANCHORED");
    expect(t.phase).toBe("anchored");
    expect(t.material).toBe(true);
    expect(t.anchoring.state).toBe("ANCHORED");
    expect(t.anchoring.bitcoinBlockHeight).toBe(ANCHORED.blockHeight);
    expect(t.data.otsBitcoinTxid).toBe(ANCHORED.txid);
    expect(t.data.otsProofBase64).toBe(ANCHORED.base64);
    expect(t.data.otsAnchoredAtUtc).toEqual(NOW);
  });

  it("an upgraded proof with no transaction step is ANCHORED with no txid (never invented)", () => {
    const p = upgradedProof({ withTransaction: false });
    const t = decideOtsTransition(row(), { kind: "PROOF", proofBase64: p.base64 }, NOW);
    expect(t.kind === "WRITE" && t.status).toBe("ANCHORED");
    expect(t.kind === "WRITE" && t.data.otsBitcoinTxid).toBeNull();
  });

  it("the same pending proof refreshes PENDING without a material change", () => {
    const t = decideOtsTransition(row(), { kind: "PROOF", proofBase64: REAL.boundProofBase64 }, NOW);
    expect(t.kind === "WRITE" && t.status).toBe("PENDING");
    expect(t.kind === "WRITE" && t.material).toBe(false);
  });

  it("upgraded bytes that commit to another digest are a defect: FAILED, the stored proof preserved", () => {
    const t = decideOtsTransition(row(), { kind: "PROOF", proofBase64: REAL.otherProofBase64 }, NOW);
    expect(t.kind).toBe("WRITE");
    if (t.kind !== "WRITE") return;
    expect(t.status).toBe("FAILED");
    expect(t.data.otsFailureReason).toBe("PROOF_HASH_MISMATCH");
    expect(t.data.otsProofBase64).toBe(REAL.boundProofBase64);
  });

  it("a malformed Bitcoin attestation in the upgrade is FAILED INVALID_ATTESTATION", () => {
    const p = upgradedProof({ trailingPayload: new Uint8Array([1]) });
    const t = decideOtsTransition(row(), { kind: "PROOF", proofBase64: p.base64 }, NOW);
    expect(t.kind === "WRITE" && t.data.otsFailureReason).toBe("INVALID_ATTESTATION");
  });

  it("ANCHORED is terminal per proof: no observation regresses it", () => {
    const anchored = row({ otsStatus: "ANCHORED", otsProofBase64: ANCHORED.base64, otsAnchoredAtUtc: T0 });
    expect(isAnchoredOtsRow(anchored)).toBe(true);
    for (const obs of [
      { kind: "PROOF", proofBase64: REAL.boundProofBase64 },
      { kind: "PROOF", proofBase64: REAL.otherProofBase64 },
      { kind: "BUDGET_EXHAUSTED" },
      { kind: "TRANSIENT_ERROR", reason: "calendar down" },
    ] as const) {
      expect(decideOtsTransition(anchored, obs, NOW).kind).toBe("NO_CHANGE");
    }
  });

  it("an established proof defect is terminal", () => {
    const failed = row({ otsStatus: "FAILED", otsProofBase64: REAL.otherProofBase64, otsFailureReason: "PROOF_HASH_MISMATCH" });
    expect(decideOtsTransition(failed, { kind: "PROOF", proofBase64: ANCHORED.base64 }, NOW).kind).toBe("NO_CHANGE");
  });

  it("an attempt error changes nothing and is recorded as an attempt", () => {
    expect(decideOtsTransition(row(), { kind: "TRANSIENT_ERROR", reason: "OTS_CALENDAR_UNAVAILABLE" }, NOW)).toEqual({
      kind: "RECORD_ATTEMPT_ERROR",
      reason: "OTS_CALENDAR_UNAVAILABLE",
    });
  });

  it("budget exhaustion fails only a PENDING proof, with its stable code", () => {
    const t = decideOtsTransition(row(), { kind: "BUDGET_EXHAUSTED" }, NOW);
    expect(t.kind === "WRITE" && t.data.otsFailureReason).toBe("OTS_GLOBAL_BUDGET_EXHAUSTED");
    expect(t.kind === "WRITE" && t.data.otsProofBase64).toBe(REAL.boundProofBase64);
  });
});

describe("decideStoredStatusAlignment (restart recovery and legacy rows)", () => {
  it("a PENDING label over an anchored proof is aligned to ANCHORED from the proof", () => {
    const t = decideStoredStatusAlignment(row({ otsProofBase64: ANCHORED.base64 }), NOW);
    expect(t?.kind === "WRITE" && t.status).toBe("ANCHORED");
    expect(t?.kind === "WRITE" && t.phase).toBe("anchored_by_stored_proof");
    expect(t?.kind === "WRITE" && t.data.otsBitcoinTxid).toBe(ANCHORED.txid);
  });

  it("an ANCHORED label over a proof without a Bitcoin attestation is aligned to PENDING", () => {
    const t = decideStoredStatusAlignment(
      row({ otsStatus: "ANCHORED", otsBitcoinTxid: "cd".repeat(32), otsAnchoredAtUtc: T0 }),
      NOW,
    );
    expect(t?.kind === "WRITE" && t.status).toBe("PENDING");
    expect(t?.kind === "WRITE" && t.phase).toBe("legacy_anchor_label_without_attestation");
  });

  it("a stored proof bound to another digest is aligned to FAILED", () => {
    const t = decideStoredStatusAlignment(row({ otsProofBase64: REAL.otherProofBase64 }), NOW);
    expect(t?.kind === "WRITE" && t.data.otsFailureReason).toBe("PROOF_HASH_MISMATCH");
  });

  it("an aligned row produces no decision (idempotent)", () => {
    expect(decideStoredStatusAlignment(row(), NOW)).toBeNull();
    const anchored = row({ otsStatus: "ANCHORED", otsProofBase64: ANCHORED.base64, otsBitcoinTxid: ANCHORED.txid, otsAnchoredAtUtc: T0 });
    expect(decideStoredStatusAlignment(anchored, NOW)).toBeNull();
  });

  it("an ANCHORED label with no proof is left for Operations (UNAVAILABLE), never rewritten", () => {
    expect(decideStoredStatusAlignment(row({ otsStatus: "ANCHORED", otsProofBase64: null }), NOW)).toBeNull();
  });
});

describe("compare-and-set", () => {
  it("is conditional on the stored proof and the OTS columns (the chain outcome included), not on deprecated ones", () => {
    const where = otsSnapshotWhere("e1", row());
    expect(where).toMatchObject({ id: "e1", otsStatus: "PENDING", otsProofBase64: REAL.boundProofBase64 });
    for (const key of DEPRECATED) expect(Object.keys(where)).not.toContain(key);
    // A stale job can never overwrite a newer chain verification.
    for (const key of [
      "otsChainVerificationStatus",
      "otsChainCheckedAtUtc",
      "otsChainBlockHash",
      "otsChainConfirmations",
      "otsChainFailureCode",
      "otsChainVerifier",
    ]) {
      expect(Object.keys(where)).toContain(key);
    }
  });
});
