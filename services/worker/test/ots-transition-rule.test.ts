/**
 * THE OTS TRANSITION RULE (2026-09-29) — pure decisions.
 *
 * `decideOtsTransition(row, observation, observedAt)` is the one place that
 * decides how an OTS observation changes a record. These cases pin the rule
 * the processor applies compare-and-set (see ots-upgrade-processor.behaviour).
 */
import { describe, expect, it } from "vitest";

import {
  decideOtsTransition,
  hasOtsProofMagic,
  isCheckedOtsAnchor,
  otsSnapshotWhere,
  type OtsRowSnapshot,
} from "../src/ots-state.js";

const TXID = "a".repeat(64);
const BLOCK_TIME = new Date("2026-09-20T10:00:00Z");
const EARLIER = new Date("2026-09-21T10:00:00Z");
const NOW = new Date("2026-09-29T12:00:00Z");

function row(over: Partial<OtsRowSnapshot> = {}): OtsRowSnapshot {
  return {
    otsStatus: "PENDING",
    otsProofBase64: "cHJvb2Y=",
    otsHash: "b".repeat(64),
    otsCalendar: "https://calendar.example",
    otsBitcoinTxid: null,
    otsAnchoredAtUtc: null,
    otsUpgradedAtUtc: EARLIER,
    otsFailureReason: null,
    otsAnchorCheck: null,
    ...over,
  };
}

/** (2026-10-12) A recorded chain verification and its evidence (test values). */
const CHAIN_CHECK = {
  status: "VERIFIED" as const,
  checkedAtUtc: new Date("2026-09-20T12:00:00Z"),
  verifier: "test-double/1",
  verifiedAtUtc: new Date("2026-09-20T12:00:00Z"),
  blockHeight: 1,
  blockHash: "0".repeat(20) + "b".repeat(44),
  blockTimeUtc: BLOCK_TIME,
  confirmations: 6,
};
const CHAIN_COLUMNS = {
  otsChainVerificationStatus: "VERIFIED",
  otsChainCheckedAtUtc: CHAIN_CHECK.checkedAtUtc,
  otsChainVerifiedAtUtc: CHAIN_CHECK.verifiedAtUtc,
  otsChainBlockHeight: 1,
  otsChainBlockHash: CHAIN_CHECK.blockHash,
  otsChainBlockTimeUtc: BLOCK_TIME,
  otsChainConfirmations: 6,
  otsChainVerifier: "test-double/1",
  otsChainFailureCode: null,
};

const anchoredChecked = (check: "BITCOIN_VERIFIED" | "PROOF_STRUCTURE") =>
  row({
    otsStatus: "ANCHORED",
    otsBitcoinTxid: TXID,
    otsAnchoredAtUtc: BLOCK_TIME,
    otsAnchorCheck: check,
    otsAttestationRecordedAtUtc: BLOCK_TIME,
    otsAttestationBlockHeight: 1,
    ...(check === "BITCOIN_VERIFIED" ? CHAIN_COLUMNS : { otsChainVerificationStatus: null, otsChainFailureCode: null }),
  });

describe("anchored with a valid (checked) proof", () => {
  it("is never demoted by an inconclusive re-check, a transient error or the budget", () => {
    const r = anchoredChecked("BITCOIN_VERIFIED");
    expect(isCheckedOtsAnchor(r)).toBe(true);
    expect(decideOtsTransition(r, { kind: "PENDING", proofBase64: "x", txid: null }, NOW).kind).toBe("NO_CHANGE");
    expect(decideOtsTransition(r, { kind: "TRANSIENT_ERROR", reason: "ECONNRESET" }, NOW).kind).toBe(
      "RECORD_ATTEMPT_ERROR",
    );
    expect(decideOtsTransition(r, { kind: "BUDGET_EXHAUSTED" }, NOW).kind).toBe("NO_CHANGE");
  });

  it("recorded chain evidence is kept through an inconclusive re-check, and a verifying check upgrades a structural one", () => {
    const verified = anchoredChecked("BITCOIN_VERIFIED");
    for (const chain of [null, { status: "UNAVAILABLE" as const, checkedAtUtc: NOW, verifier: "test-double/1", reason: "down" }]) {
      const t = decideOtsTransition(
        verified,
        { kind: "ANCHOR_PROVEN", proofBase64: "cHJvb2Y=", check: "PROOF_STRUCTURE", txid: TXID, blockTimeUtc: null, blockHeight: 1, chain },
        NOW,
      );
      expect(t.kind).toBe("NO_CHANGE");
    }

    const structural = anchoredChecked("PROOF_STRUCTURE");
    const up = decideOtsTransition(
      structural,
      { kind: "ANCHOR_PROVEN", proofBase64: "cHJvb2Y=", check: "BITCOIN_VERIFIED", txid: TXID, blockTimeUtc: BLOCK_TIME, blockHeight: 1, chain: CHAIN_CHECK },
      NOW,
    );
    expect(up).toMatchObject({ kind: "WRITE", status: "ANCHORED", phase: "chain_verified" });
    if (up.kind === "WRITE") {
      expect(up.data).toMatchObject({ otsAnchorCheck: "BITCOIN_VERIFIED", otsChainVerificationStatus: "VERIFIED", otsChainConfirmations: 6 });
    }
  });

  it("BITCOIN_VERIFIED is never written without a VERIFIED chain check — the observation's own label is not enough", () => {
    const t = decideOtsTransition(
      row(),
      { kind: "ANCHOR_PROVEN", proofBase64: "bmV3", check: "BITCOIN_VERIFIED", txid: TXID, blockTimeUtc: BLOCK_TIME, blockHeight: 1 },
      NOW,
    );
    expect(t.kind === "WRITE" && t.data.otsAnchorCheck).toBe("PROOF_STRUCTURE");
  });

  it("a verified anchor is withdrawn when a configured verifier reached the chain and it did not verify (reorg)", () => {
    const t = decideOtsTransition(
      anchoredChecked("BITCOIN_VERIFIED"),
      {
        kind: "ANCHOR_PROVEN",
        proofBase64: "cHJvb2Y=",
        check: "PROOF_STRUCTURE",
        txid: TXID,
        blockTimeUtc: null,
        blockHeight: 1,
        chain: { status: "FAILED", checkedAtUtc: NOW, verifier: "test-double/1", failureCode: "ATTESTATION_NOT_IN_CHAIN" },
      },
      NOW,
    );
    expect(t).toMatchObject({ kind: "WRITE", phase: "chain_verification_withdrawn" });
    if (t.kind === "WRITE") {
      expect(t.data).toMatchObject({
        otsAnchorCheck: "PROOF_STRUCTURE",
        otsChainVerificationStatus: "FAILED",
        otsChainFailureCode: "ATTESTATION_NOT_IN_CHAIN",
        otsChainBlockTimeUtc: null,
      });
    }
  });

  it("the anchor time is the block time; else the existing anchor time; never overwritten by a later observation", () => {
    const fromPending = decideOtsTransition(
      row(),
      { kind: "ANCHOR_PROVEN", proofBase64: "bmV3", check: "BITCOIN_VERIFIED", txid: TXID, blockTimeUtc: BLOCK_TIME, blockHeight: 1, chain: CHAIN_CHECK },
      NOW,
    );
    expect(fromPending.kind === "WRITE" && fromPending.data.otsAnchoredAtUtc).toEqual(BLOCK_TIME);
    expect(fromPending.kind === "WRITE" && fromPending.data.otsUpgradedAtUtc).toEqual(NOW);

    // Structure-only proof carries no block time: the observation time is the
    // earliest defensible upper bound — used only when no anchor time exists.
    const structural = decideOtsTransition(
      row(),
      { kind: "ANCHOR_PROVEN", proofBase64: "bmV3", check: "PROOF_STRUCTURE", txid: TXID, blockTimeUtc: null, blockHeight: 1 },
      NOW,
    );
    expect(structural.kind === "WRITE" && structural.data.otsAnchoredAtUtc).toEqual(NOW);
    // (2026-10-12) That time is RECORDED as what it is: the attestation-recorded
    // time. No verified block time exists for it.
    expect(structural.kind === "WRITE" && structural.data.otsAttestationRecordedAtUtc).toEqual(NOW);
    expect(structural.kind === "WRITE" && structural.data.otsChainBlockTimeUtc).toBeNull();

    const legacy = row({ otsStatus: "ANCHORED", otsAnchoredAtUtc: BLOCK_TIME });
    const kept = decideOtsTransition(
      legacy,
      { kind: "ANCHOR_PROVEN", proofBase64: "bmV3", check: "PROOF_STRUCTURE", txid: TXID, blockTimeUtc: null, blockHeight: 1 },
      NOW,
    );
    expect(kept.kind === "WRITE" && kept.data.otsAnchoredAtUtc).toEqual(BLOCK_TIME);
  });

  it("duplicate delivery of the same proven anchor writes nothing", () => {
    const r = anchoredChecked("PROOF_STRUCTURE");
    const t = decideOtsTransition(
      r,
      { kind: "ANCHOR_PROVEN", proofBase64: r.otsProofBase64!, check: "PROOF_STRUCTURE", txid: TXID, blockTimeUtc: null, blockHeight: 1 },
      NOW,
    );
    expect(t).toEqual({ kind: "NO_CHANGE", reason: expect.any(String) });
  });
});

describe("anchored WITHOUT a defensible txid or a recorded check (legacy)", () => {
  it("is demoted to PENDING when the re-check cannot confirm it — the label is not kept to avoid a downgrade", () => {
    const legacy = row({ otsStatus: "ANCHORED", otsAnchoredAtUtc: BLOCK_TIME });
    expect(isCheckedOtsAnchor(legacy)).toBe(false);
    const t = decideOtsTransition(legacy, { kind: "PENDING", proofBase64: "cmVmcmVzaGVk", txid: null }, NOW);
    expect(t).toMatchObject({ kind: "WRITE", status: "PENDING", phase: "anchor_not_confirmed_on_recheck", material: true });
    if (t.kind === "WRITE") {
      expect(t.data.otsAnchoredAtUtc).toBeNull();
      expect(t.data.otsAnchorCheck).toBeNull();
      // The refreshed proof is kept; nothing established is thrown away.
      expect(t.data.otsProofBase64).toBe("cmVmcmVzaGVk");
    }
  });

  it("is confirmed (and gains its check) when the re-check proves it", () => {
    const legacy = row({ otsStatus: "ANCHORED", otsAnchoredAtUtc: BLOCK_TIME });
    const t = decideOtsTransition(
      legacy,
      { kind: "ANCHOR_PROVEN", proofBase64: "cHJvb2Y=", check: "PROOF_STRUCTURE", txid: TXID, blockTimeUtc: null, blockHeight: 7 },
      NOW,
    );
    expect(t).toMatchObject({ kind: "WRITE", status: "ANCHORED" });
    if (t.kind === "WRITE") expect(t.data.otsAnchorCheck).toBe("PROOF_STRUCTURE");
  });
});

describe("transient provider/network failure", () => {
  it("changes nothing on the row — it is recorded as an attempt error, for any state", () => {
    for (const r of [row(), row({ otsStatus: "ANCHORED", otsAnchoredAtUtc: BLOCK_TIME }), anchoredChecked("PROOF_STRUCTURE")]) {
      const t = decideOtsTransition(r, { kind: "TRANSIENT_ERROR", reason: "getaddrinfo ENOTFOUND" }, NOW);
      expect(t).toEqual({ kind: "RECORD_ATTEMPT_ERROR", reason: "getaddrinfo ENOTFOUND" });
    }
  });

  it("a record left FAILED by the old transient bug recovers to PENDING on the next good attempt", () => {
    const failed = row({ otsStatus: "FAILED", otsFailureReason: "Error: connect ECONNREFUSED" });
    const t = decideOtsTransition(failed, { kind: "PENDING", proofBase64: "cHJvb2Y=", txid: null }, NOW);
    expect(t).toMatchObject({ kind: "WRITE", status: "PENDING", phase: "recovered_from_failed_attempt" });
  });
});

describe("permanently invalid proof", () => {
  it("is FAILED with the reason code, preserving the stored proof as evidence", () => {
    const t = decideOtsTransition(row(), { kind: "PROOF_INVALID", code: "PROOF_HASH_MISMATCH", reason: "x" }, NOW);
    expect(t).toMatchObject({ kind: "WRITE", status: "FAILED", phase: "proof_hash_mismatch" });
    if (t.kind === "WRITE") {
      expect(t.data.otsFailureReason).toBe("PROOF_HASH_MISMATCH");
      expect(t.data.otsProofBase64).toBe("cHJvb2Y=");
    }
  });

  it("stays FAILED: a later inconclusive observation does not resurrect it, a repeat writes nothing", () => {
    const invalid = row({ otsStatus: "FAILED", otsFailureReason: "MALFORMED_PROOF" });
    expect(decideOtsTransition(invalid, { kind: "PENDING", proofBase64: "x", txid: null }, NOW).kind).toBe("NO_CHANGE");
    expect(
      decideOtsTransition(invalid, { kind: "PROOF_INVALID", code: "MALFORMED_PROOF", reason: "x" }, NOW).kind,
    ).toBe("NO_CHANGE");
  });

  it("only an OpenTimestamps proof passes the structural check", () => {
    const magic = Buffer.from("004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294", "hex");
    expect(hasOtsProofMagic(Buffer.concat([magic, Buffer.from([1, 2, 3])]))).toBe(true);
    expect(hasOtsProofMagic(Buffer.from("not a proof at all, just text"))).toBe(false);
    expect(hasOtsProofMagic(magic)).toBe(false); // header only, no body
  });
});

describe("pending progress and the budget", () => {
  it("a pending re-check with no new fact refreshes the observation time without a custody event", () => {
    const t = decideOtsTransition(row(), { kind: "PENDING", proofBase64: "cHJvb2Y=", txid: null }, NOW);
    expect(t).toMatchObject({ kind: "WRITE", status: "PENDING", material: false });
  });

  it("a newly detected txid is a material pending fact", () => {
    const t = decideOtsTransition(row(), { kind: "PENDING", proofBase64: "cHJvb2Y=", txid: TXID }, NOW);
    expect(t).toMatchObject({ kind: "WRITE", phase: "txid_detected_pending_confirmation", material: true });
  });

  it("budget exhaustion fails only a PENDING proof", () => {
    expect(decideOtsTransition(row(), { kind: "BUDGET_EXHAUSTED" }, NOW)).toMatchObject({
      kind: "WRITE",
      status: "FAILED",
      phase: "global_budget_exhausted",
    });
    expect(decideOtsTransition(row({ otsStatus: "FAILED" }), { kind: "BUDGET_EXHAUSTED" }, NOW).kind).toBe("NO_CHANGE");
  });
});

describe("compare-and-set predicate", () => {
  it("pins every OTS fact the decision was made from, nulls included", () => {
    expect(otsSnapshotWhere("ev-1", row())).toEqual({
      id: "ev-1",
      otsStatus: "PENDING",
      otsBitcoinTxid: null,
      otsAnchoredAtUtc: null,
      otsUpgradedAtUtc: EARLIER,
      otsAnchorCheck: null,
      otsFailureReason: null,
    });
  });
});
