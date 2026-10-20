/**
 * THE CHAIN TRANSITION RULE — independent Bitcoin-chain verification of an
 * ANCHORED proof, written to the evidence.ots_chain_* columns only.
 *
 * decideOtsChainTransition(row, check, policy) is pure. These tests drive it
 * over an OtsRowSnapshot whose stored proof is the real `ots stamp` proof plus
 * a synthetic Bitcoin branch (packages/shared/tests/helpers/ots-fixtures.mjs).
 *
 * MOCKS (clearly labelled):
 *   - VERIFIER CHECKS are hand-built OtsChainCheckInput values (no Bitcoin
 *     node, no RPC client).
 *   - STORED CHAIN COLUMNS come from the fixture `chainColumnsFor` (timestamps
 *     converted to Date, as Prisma returns them).
 *   - FAKE TRANSACTION: `fakeTx()` is an in-memory stand-in for
 *     Prisma.TransactionClient whose evidence.updateMany is a vi.fn spy.
 */
import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { formatOtsChainVerifier, type OtsChainDecision, type OtsChainFailureCode } from "@proovra/shared";

import * as fixtures from "../../../packages/shared/tests/helpers/ots-fixtures.mjs";
import {
  OTS_CHAIN_CLEARED,
  applyOtsTransition,
  buildOtsEvidenceUpdateData,
  decideOtsChainTransition,
  isTerminalOtsChainOutcome,
  nextOtsChainCheckDelayMs,
  otsSnapshotWhere,
  resolveRowOtsAnchoring,
  type OtsChainCheckInput,
  type OtsRowSnapshot,
  type OtsTransition,
} from "../src/ots-state.js";

const { REAL, upgradedProof } = fixtures;

type ChainColumns = {
  otsChainVerificationStatus: string | null;
  otsChainCheckedAtUtc: string | null;
  otsChainVerifiedAtUtc: string | null;
  otsChainBlockHeight: number | null;
  otsChainBlockHash: string | null;
  otsChainBlockTimeUtc: string | null;
  otsChainConfirmations: number | null;
  otsChainVerifier: string | null;
  otsChainFailureCode: string | null;
};
// chainColumnsFor exists in the .mjs fixture; its .d.mts does not declare it yet.
const chainColumnsFor = (fixtures as unknown as {
  chainColumnsFor: (up: { blockHeight: number; proofSha256: string }, o?: Record<string, unknown>) => ChainColumns;
}).chainColumnsFor;

const FP = REAL.boundFingerprintHash;
const T0 = new Date("2026-10-01T00:00:00.000Z");
const CHECKED = new Date("2026-10-15T12:00:00.000Z");
const PRIOR_VERIFIED_AT = "2026-10-14T08:00:00.000Z";
const UP = upgradedProof();
const H = UP.blockHeight;
const HASH_A = "00000000000000000001a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7";
const HASH_B = "0000000000000000000200000000000000000000000000000000000000000abc";
const POLICY = { minConfirmations: 6 };
const VERIFIER = formatOtsChainVerifier({ nodeVersion: 270100, minConfirmations: 6, proofSha256: UP.proofSha256 });

const CHAIN_NULL = {
  otsChainVerificationStatus: null,
  otsChainCheckedAtUtc: null,
  otsChainVerifiedAtUtc: null,
  otsChainBlockHeight: null,
  otsChainBlockHash: null,
  otsChainBlockTimeUtc: null,
  otsChainConfirmations: null,
  otsChainVerifier: null,
  otsChainFailureCode: null,
} satisfies Partial<OtsRowSnapshot>;

/** An ANCHORED evidence row storing UP — all 18 snapshot fields. */
function row(over: Partial<OtsRowSnapshot> = {}): OtsRowSnapshot {
  return {
    otsStatus: "ANCHORED",
    otsProofBase64: UP.base64,
    otsHash: FP,
    otsCalendar: "https://a.pool.opentimestamps.org",
    otsBitcoinTxid: UP.txid,
    otsAnchoredAtUtc: T0,
    otsUpgradedAtUtc: T0,
    otsFailureReason: null,
    fingerprintHash: FP,
    ...CHAIN_NULL,
    ...over,
  };
}

const dateOrNull = (v: string | null) => (v == null ? null : new Date(v));

/** The fixture chain columns, as Prisma returns them (Dates). */
function chain(o: Record<string, unknown>): Partial<OtsRowSnapshot> {
  const c = chainColumnsFor(UP, o);
  return {
    ...c,
    otsChainCheckedAtUtc: dateOrNull(c.otsChainCheckedAtUtc),
    otsChainVerifiedAtUtc: dateOrNull(c.otsChainVerifiedAtUtc),
    otsChainBlockTimeUtc: dateOrNull(c.otsChainBlockTimeUtc),
  };
}

function decided(decision: OtsChainDecision): OtsChainCheckInput {
  return { kind: "DECIDED", decision, verifier: VERIFIER, checkedAtUtc: CHECKED };
}
function verified(blockHash = HASH_A, confirmations = 10): OtsChainCheckInput {
  return decided({ status: "VERIFIED", failureCode: null, blockHeight: H, blockHash, blockTimeUtc: "2024-05-01T12:00:00.000Z", confirmations, rejected: [] });
}
function insufficient(blockHash = HASH_A, confirmations = 2): OtsChainCheckInput {
  return decided({
    status: "INSUFFICIENT_CONFIRMATIONS",
    failureCode: "INSUFFICIENT_CONFIRMATIONS",
    blockHeight: H,
    blockHash,
    blockTimeUtc: "2024-05-01T12:00:00.000Z",
    confirmations,
    rejected: [],
  });
}
function failed(code: OtsChainFailureCode): OtsChainCheckInput {
  return decided({ status: "FAILED", failureCode: code, blockHeight: H, blockHash: null, blockTimeUtc: null, confirmations: null, rejected: [{ blockHeight: H, code }] });
}
function unavailable(code: OtsChainFailureCode = "BTC_RPC_TIMEOUT"): OtsChainCheckInput {
  return { kind: "UNAVAILABLE", code, detail: "node unreachable", checkedAtUtc: CHECKED };
}

function asWrite(t: OtsTransition): Extract<OtsTransition, { kind: "WRITE" }> {
  expect(t.kind).toBe("WRITE");
  if (t.kind !== "WRITE") throw new Error("expected WRITE");
  return t;
}

/** The row after the write is applied (for repeat checks). */
function applied(r: OtsRowSnapshot, t: Extract<OtsTransition, { kind: "WRITE" }>): OtsRowSnapshot {
  return { ...r, ...(t.data as Partial<OtsRowSnapshot>) };
}

describe("decideOtsChainTransition — the chain answered", () => {
  it("VERIFIED over an unchecked ANCHORED row writes only chain columns, material, CHAIN_VERIFIED", () => {
    const r = row();
    expect(resolveRowOtsAnchoring(r).state).toBe("ANCHORED");
    const t = asWrite(decideOtsChainTransition(r, verified(), POLICY));
    expect(t.status).toBe("ANCHORED");
    expect(t.phase).toBe("chain_verified");
    expect(t.material).toBe(true);
    expect(t.data.otsChainVerificationStatus).toBe("VERIFIED");
    expect(t.data.otsChainVerifiedAtUtc).toEqual(CHECKED);
    expect(t.data.otsChainCheckedAtUtc).toEqual(CHECKED);
    expect(t.data.otsChainBlockHeight).toBe(H);
    expect(t.data.otsChainBlockHash).toBe(HASH_A);
    expect(t.data.otsChainConfirmations).toBe(10);
    expect(t.data.otsChainVerifier).toBe(VERIFIER);
    expect(t.data.otsChainFailureCode).toBeNull();
    for (const key of Object.keys(t.data)) expect(key.startsWith("otsChain")).toBe(true);
    expect(t.anchoring.state).toBe("ANCHORED");
    expect(t.anchoring.verification).toBe("CHAIN_VERIFIED");
  });

  it("re-verifying the same block hash is not material and keeps the first verifiedAt", () => {
    const r = row(chain({ status: "VERIFIED", blockHash: HASH_A, verifiedAtUtc: PRIOR_VERIFIED_AT }));
    expect(resolveRowOtsAnchoring(r).chain?.status).toBe("VERIFIED");
    const t = asWrite(decideOtsChainTransition(r, verified(HASH_A, 30), POLICY));
    expect(t.material).toBe(false);
    expect(t.data.otsChainVerifiedAtUtc).toEqual(new Date(PRIOR_VERIFIED_AT));
    expect(t.data.otsChainCheckedAtUtc).toEqual(CHECKED);
    expect(t.data.otsChainConfirmations).toBe(30);
    expect(t.anchoring.verification).toBe("CHAIN_VERIFIED");
  });

  it("prior INSUFFICIENT_CONFIRMATIONS then VERIFIED is a material verification at checkedAt", () => {
    const r = row(chain({ status: "INSUFFICIENT_CONFIRMATIONS", blockHash: HASH_A }));
    expect(resolveRowOtsAnchoring(r).verification).toBe("CHAIN_CONFIRMATIONS_PENDING");
    const t = asWrite(decideOtsChainTransition(r, verified(HASH_A), POLICY));
    expect(t.phase).toBe("chain_verified");
    expect(t.material).toBe(true);
    expect(t.data.otsChainVerifiedAtUtc).toEqual(CHECKED);
    expect(t.data.otsChainFailureCode).toBeNull();
  });

  it("prior VERIFIED then FAILED NOT_IN_ACTIVE_CHAIN is REORGED", () => {
    const r = row(chain({ status: "VERIFIED", blockHash: HASH_A }));
    const t = asWrite(decideOtsChainTransition(r, failed("NOT_IN_ACTIVE_CHAIN"), POLICY));
    expect(t.phase).toBe("chain_reorged");
    expect(t.material).toBe(true);
    expect(t.data.otsChainVerificationStatus).toBe("FAILED");
    expect(t.data.otsChainFailureCode).toBe("REORGED");
    expect(t.data.otsChainVerifiedAtUtc).toBeNull();
    expect(t.data.otsChainBlockHash).toBeNull();
    expect(t.anchoring.verification).toBe("CHAIN_FAILED");
  });

  it("prior VERIFIED then INSUFFICIENT_CONFIRMATIONS on a different block hash is REORGED", () => {
    const r = row(chain({ status: "VERIFIED", blockHash: HASH_A }));
    const t = asWrite(decideOtsChainTransition(r, insufficient(HASH_B), POLICY));
    expect(t.phase).toBe("chain_reorged");
    expect(t.data.otsChainVerificationStatus).toBe("FAILED");
    expect(t.data.otsChainFailureCode).toBe("REORGED");
  });

  it("FAILED NOT_IN_ACTIVE_CHAIN over an unchecked row is a plain verification failure (not REORGED)", () => {
    const t = asWrite(decideOtsChainTransition(row(), failed("NOT_IN_ACTIVE_CHAIN"), POLICY));
    expect(t.phase).toBe("chain_verification_failed");
    expect(t.data.otsChainFailureCode).toBe("NOT_IN_ACTIVE_CHAIN");
  });
});

describe("decideOtsChainTransition — an outage never overwrites a recorded outcome", () => {
  it.each([
    ["VERIFIED", { status: "VERIFIED" }],
    ["FAILED NOT_IN_ACTIVE_CHAIN", { status: "FAILED", failureCode: "NOT_IN_ACTIVE_CHAIN" }],
    ["INSUFFICIENT_CONFIRMATIONS", { status: "INSUFFICIENT_CONFIRMATIONS" }],
  ])("UNAVAILABLE over prior %s → NO_CHANGE", (_label, o) => {
    const r = row(chain(o));
    expect(resolveRowOtsAnchoring(r).chain).not.toBeNull();
    expect(decideOtsChainTransition(r, unavailable(), POLICY).kind).toBe("NO_CHANGE");
  });

  it("UNAVAILABLE over no record writes UNAVAILABLE; the same code again is not material", () => {
    const r = row();
    const t = asWrite(decideOtsChainTransition(r, unavailable("BTC_RPC_TIMEOUT"), POLICY));
    expect(t.phase).toBe("chain_verification_unavailable");
    expect(t.material).toBe(true);
    expect(t.status).toBe("ANCHORED");
    expect(t.data.otsChainVerificationStatus).toBe("UNAVAILABLE");
    expect(t.data.otsChainFailureCode).toBe("BTC_RPC_TIMEOUT");
    expect(t.data.otsChainCheckedAtUtc).toEqual(CHECKED);
    expect(t.data.otsChainVerifiedAtUtc).toBeNull();
    expect(t.data.otsChainBlockHash).toBeNull();
    expect(t.anchoring.verification).toBe("CHAIN_UNAVAILABLE");
    for (const key of Object.keys(t.data)) expect(key.startsWith("otsChain")).toBe(true);

    const again = applied(r, t);
    expect(resolveRowOtsAnchoring(again).chain?.status).toBe("UNAVAILABLE");
    const t2 = asWrite(decideOtsChainTransition(again, unavailable("BTC_RPC_TIMEOUT"), POLICY));
    expect(t2.material).toBe(false);
    const t3 = asWrite(decideOtsChainTransition(again, unavailable("NODE_STALE"), POLICY));
    expect(t3.material).toBe(true);
  });
});

describe("decideOtsChainTransition — terminal and non-applicable", () => {
  it("a terminal ROOT_MISMATCH bound to this proof → NO_CHANGE for any later check", () => {
    const r = row(chain({ status: "FAILED", failureCode: "ROOT_MISMATCH" }));
    expect(resolveRowOtsAnchoring(r).chain?.failureCode).toBe("ROOT_MISMATCH");
    for (const c of [verified(), insufficient(), failed("NOT_IN_ACTIVE_CHAIN"), unavailable(), { kind: "DISABLED" } as const]) {
      expect(decideOtsChainTransition(r, c, POLICY).kind).toBe("NO_CHANGE");
    }
  });

  it("isTerminalOtsChainOutcome: ROOT_MISMATCH / INVALID_HEADER are terminal; NOT_IN_ACTIVE_CHAIN / REORGED are not", () => {
    const t = (code: string) => isTerminalOtsChainOutcome({ otsChainVerificationStatus: "FAILED", otsChainFailureCode: code });
    expect(t("ROOT_MISMATCH")).toBe(true);
    expect(t("INVALID_HEADER")).toBe(true);
    expect(t("NOT_IN_ACTIVE_CHAIN")).toBe(false);
    expect(t("REORGED")).toBe(false);
    expect(isTerminalOtsChainOutcome({ otsChainVerificationStatus: "UNAVAILABLE", otsChainFailureCode: "ROOT_MISMATCH" })).toBe(false);
  });

  it("a non-ANCHORED (PENDING) row → NO_CHANGE", () => {
    const r = row({ otsStatus: "PENDING", otsProofBase64: REAL.boundProofBase64, otsBitcoinTxid: null, otsAnchoredAtUtc: null });
    expect(resolveRowOtsAnchoring(r).state).toBe("PENDING");
    expect(decideOtsChainTransition(r, verified(), POLICY).kind).toBe("NO_CHANGE");
    expect(decideOtsChainTransition(r, unavailable(), POLICY).kind).toBe("NO_CHANGE");
  });

  it("DISABLED → NO_CHANGE", () => {
    expect(decideOtsChainTransition(row(), { kind: "DISABLED" }, POLICY).kind).toBe("NO_CHANGE");
  });
});

describe("decideOtsChainTransition — a chain record about ANOTHER proof counts as none", () => {
  const OTHER = "f".repeat(64);

  it("a VERIFIED record of another proof is unbound; UNAVAILABLE then writes UNAVAILABLE", () => {
    const r = row(chain({ status: "VERIFIED", proofSha256: OTHER }));
    expect(resolveRowOtsAnchoring(r).chain).toBeNull();
    expect(resolveRowOtsAnchoring(r).verification).toBe("ATTESTATION_RECORDED");
    const t = asWrite(decideOtsChainTransition(r, unavailable(), POLICY));
    expect(t.material).toBe(true);
    expect(t.data.otsChainVerificationStatus).toBe("UNAVAILABLE");
    expect(t.data.otsChainVerifier).toBe(formatOtsChainVerifier({ nodeVersion: null, minConfirmations: 6, proofSha256: UP.proofSha256 }));
  });

  it("a FAILED ROOT_MISMATCH record of another proof is not terminal for this one", () => {
    const r = row(chain({ status: "FAILED", failureCode: "ROOT_MISMATCH", proofSha256: OTHER }));
    expect(resolveRowOtsAnchoring(r).chain).toBeNull();
    const t = asWrite(decideOtsChainTransition(r, verified(), POLICY));
    expect(t.data.otsChainVerificationStatus).toBe("VERIFIED");
    expect(t.material).toBe(true);
  });
});

describe("applyOtsTransition — compare-and-set over the full snapshot", () => {
  /** FAKE TRANSACTION — evidence.updateMany is a spy. */
  function fakeTx(count: number) {
    const updateMany = vi.fn<(args: { where: unknown; data: unknown }) => Promise<{ count: number }>>(async () => ({ count }));
    return { tx: { evidence: { updateMany } } as unknown as Prisma.TransactionClient, updateMany };
  }

  it("passes otsSnapshotWhere(id,row) including every chain CAS column, and the decision data", async () => {
    const r = row(chain({ status: "INSUFFICIENT_CONFIRMATIONS", blockHash: HASH_A }));
    const t = asWrite(decideOtsChainTransition(r, verified(HASH_A), POLICY));
    const { tx, updateMany } = fakeTx(1);
    await expect(applyOtsTransition(tx, "ev-1", r, t)).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledTimes(1);
    const args = updateMany.mock.calls[0]![0];
    expect(args.where).toEqual(otsSnapshotWhere("ev-1", r));
    expect(args.where).toMatchObject({
      id: "ev-1",
      otsChainVerificationStatus: r.otsChainVerificationStatus,
      otsChainCheckedAtUtc: r.otsChainCheckedAtUtc,
      otsChainBlockHash: r.otsChainBlockHash,
      otsChainConfirmations: r.otsChainConfirmations,
      otsChainFailureCode: r.otsChainFailureCode,
      otsChainVerifier: r.otsChainVerifier,
    });
    expect(args.data).toEqual(t.data);
  });

  it("returns false when the row moved on (count 0)", async () => {
    const r = row();
    const t = asWrite(decideOtsChainTransition(r, verified(), POLICY));
    const { tx } = fakeTx(0);
    await expect(applyOtsTransition(tx, "ev-1", r, t)).resolves.toBe(false);
  });
});

describe("buildOtsEvidenceUpdateData — a write that stores a proof clears its chain fact", () => {
  it("every status clears every chain column unless keepChain", () => {
    const keys = Object.keys(OTS_CHAIN_CLEARED);
    expect(keys).toHaveLength(9);
    for (const k of keys) expect((OTS_CHAIN_CLEARED as Record<string, unknown>)[k]).toBeNull();
    for (const status of ["ANCHORED", "PENDING", "FAILED", "DISABLED"] as const) {
      const data = buildOtsEvidenceUpdateData({ status, proofBase64: UP.base64, upgradedAtUtc: T0 }) as Record<string, unknown>;
      for (const k of keys) {
        expect(k in data).toBe(true);
        expect(data[k]).toBeNull();
      }
      const kept = buildOtsEvidenceUpdateData({ status, proofBase64: UP.base64, upgradedAtUtc: T0, keepChain: true });
      expect(Object.keys(kept).filter((k) => k.startsWith("otsChain"))).toEqual([]);
    }
  });
});

describe("nextOtsChainCheckDelayMs", () => {
  const HOUR = 60 * 60 * 1000;
  const delay = (r: OtsRowSnapshot) => nextOtsChainCheckDelayMs(resolveRowOtsAnchoring(r));

  it("non-ANCHORED → null", () => {
    expect(delay(row({ otsStatus: "PENDING", otsProofBase64: REAL.boundProofBase64, otsBitcoinTxid: null, otsAnchoredAtUtc: null }))).toBeNull();
  });

  it("ANCHORED and never checked → 1 h", () => {
    expect(delay(row())).toBe(HOUR);
  });

  it("VERIFIED deep enough (≥ 144) → null; shallower (120) → 24 h", () => {
    expect(delay(row(chain({ status: "VERIFIED", confirmations: 144 })))).toBeNull();
    expect(delay(row(chain({ status: "VERIFIED", confirmations: 120 })))).toBe(24 * HOUR);
  });

  it.each([
    ["INSUFFICIENT_CONFIRMATIONS", { status: "INSUFFICIENT_CONFIRMATIONS" }],
    ["UNAVAILABLE", { status: "UNAVAILABLE" }],
    // 2026-10-20 (AUD-50) — FAILED NOT_IN_ACTIVE_CHAIN now backs off with the
    // proof's age and is given up after 30 days: ots-chain-recheck-bounds.test.ts.
    ["FAILED REORGED", { status: "FAILED", failureCode: "REORGED" }],
  ])("%s → 1 h", (_label, o) => {
    const r = row(chain(o));
    expect(resolveRowOtsAnchoring(r).chain).not.toBeNull();
    expect(delay(r)).toBe(HOUR);
  });

  it("terminal ROOT_MISMATCH → null", () => {
    expect(delay(row(chain({ status: "FAILED", failureCode: "ROOT_MISMATCH" })))).toBeNull();
  });
});
