/**
 * INDEPENDENT BITCOIN VERIFICATION against a REAL Bitcoin Core node (regtest).
 *
 * No mocks: the Product RPC client, the Product proof parser and the one chain
 * transition authority run against a disposable `bitcoind -regtest` container.
 * The proof is committed in a real block (test/fixtures/bitcoin-regtest.ts).
 *
 *   correct proof, 1 confirmation       → INSUFFICIENT_CONFIRMATIONS (pending)
 *   mutated proof                       → FAILED ROOT_MISMATCH (terminal)
 *   mine to the policy minimum          → VERIFIED
 *   block invalidated, chain replaced   → FAILED REORGED (never terminal)
 *   original chain restored             → VERIFIED again
 *
 * Live-integration convention: runs only when TEST_BITCOIN_REGTEST_RPC_URL
 * names a loopback regtest node (CI starts one and refuses a skip); skipped
 * otherwise. The RPC password is a throwaway for the disposable container.
 */
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveOtsAnchoring } from "@proovra/shared";

import { resolveOtsBitcoinVerifierConfig, type OtsBitcoinVerifierConfig } from "../src/ots-bitcoin-config.js";
import { checkOtsProofAgainstBitcoin, probeOtsBitcoinVerifierReadiness } from "../src/ots-bitcoin-verifier.js";
import { decideOtsChainTransition, resolveRowOtsAnchoring, type OtsRowSnapshot } from "../src/ots-state.js";
import { passwordFiles, regtestHarness, regtestTarget, reverseHex, type BuiltProof, type StampedProof } from "./fixtures/bitcoin-regtest.js";

const TARGET = regtestTarget();
const runIf = TARGET ? describe : describe.skip;
const MIN_CONFIRMATIONS = 6;

/** A persisted row, evolved only through the one transition authority. */
function rowFor(proof: BuiltProof): OtsRowSnapshot {
  return {
    otsStatus: "ANCHORED",
    otsProofBase64: proof.base64,
    otsHash: proof.digestHex,
    otsCalendar: null,
    otsBitcoinTxid: null,
    otsAnchoredAtUtc: new Date(),
    otsUpgradedAtUtc: new Date(),
    otsFailureReason: null,
    fingerprintHash: proof.digestHex,
    otsChainVerificationStatus: null,
    otsChainCheckedAtUtc: null,
    otsChainVerifiedAtUtc: null,
    otsChainBlockHeight: null,
    otsChainBlockHash: null,
    otsChainBlockTimeUtc: null,
    otsChainConfirmations: null,
    otsChainVerifier: null,
    otsChainFailureCode: null,
  };
}

/** Apply a WRITE transition's scalar data to the snapshot (what the CAS update persists). */
function apply(row: OtsRowSnapshot, data: Record<string, unknown>): OtsRowSnapshot {
  const next = { ...row } as Record<string, unknown>;
  for (const [k, v] of Object.entries(data)) if (k in next) next[k] = v;
  return next as OtsRowSnapshot;
}

runIf("independent Bitcoin verification — real Bitcoin Core regtest node", () => {
  const node = regtestHarness(TARGET!);
  const files = passwordFiles();
  let goodPasswordFile = "";
  let stamped: StampedProof;
  let row: OtsRowSnapshot;

  function regtestConfig(overrides: Record<string, string> = {}): OtsBitcoinVerifierConfig {
    return resolveOtsBitcoinVerifierConfig({
      OTS_BITCOIN_VERIFY_ENABLED: "true",
      OTS_BITCOIN_RPC_URL: TARGET!.url,
      OTS_BITCOIN_RPC_USERNAME: TARGET!.user,
      OTS_BITCOIN_RPC_PASSWORD_FILE: goodPasswordFile,
      OTS_BITCOIN_EXPECTED_CHAIN: "regtest",
      OTS_BITCOIN_MIN_CONFIRMATIONS: String(MIN_CONFIRMATIONS),
      ...overrides,
    });
  }

  /** One verification pass: the Product client and parser, then the one transition authority. */
  async function verifyPass(current: OtsRowSnapshot, config = regtestConfig()) {
    const anchoring = resolveRowOtsAnchoring(current);
    const check = await checkOtsProofAgainstBitcoin(anchoring, { config });
    const transition = decideOtsChainTransition(current, check, { minConfirmations: MIN_CONFIRMATIONS });
    const next = transition.kind === "WRITE" ? apply(current, transition.data as Record<string, unknown>) : current;
    return { check, transition, row: next, verification: resolveRowOtsAnchoring(next).verification };
  }

  beforeAll(async () => {
    goodPasswordFile = files.write("password", TARGET!.password);
    stamped = await node.stamp(randomBytes(32));
    row = rowFor(stamped);
  }, 120_000);

  afterAll(async () => {
    // Leave the disposable node on its most-work chain; the container is discarded by the harness.
    if (stamped) await node.rpc("reconsiderblock", [stamped.blockHash]).catch(() => undefined);
    files.dispose();
  });

  it("readiness: the node is reachable, authenticated, regtest, out of IBD; wrong chain and wrong password are refused", async () => {
    const ready = await probeOtsBitcoinVerifierReadiness({ config: regtestConfig() });
    expect(ready).toMatchObject({ enabled: true, ready: true, code: null, chain: "regtest" });
    expect(ready.nodeVersion).toBeGreaterThanOrEqual(270000);

    const wrongChain = await probeOtsBitcoinVerifierReadiness({ config: regtestConfig({ OTS_BITCOIN_EXPECTED_CHAIN: "main" }) });
    expect(wrongChain).toMatchObject({ ready: false, code: "WRONG_CHAIN" });

    const badAuth = await probeOtsBitcoinVerifierReadiness({
      config: regtestConfig({ OTS_BITCOIN_RPC_PASSWORD_FILE: files.write("wrong", `${TARGET!.password}-wrong`) }),
    });
    expect(badAuth).toMatchObject({ ready: false, code: "BTC_RPC_UNAUTHORIZED" });
    // No credential in anything the readiness reports.
    expect(JSON.stringify([ready, wrongChain, badAuth])).not.toContain(TARGET!.password);
  });

  it("the Product parser reads the proof as ANCHORED (attestation recorded, not yet checked)", () => {
    const a = resolveOtsAnchoring({ status: "ANCHORED", proofBase64: stamped.base64, fingerprintHash: stamped.digestHex, otsHash: stamped.digestHex });
    expect(a.state).toBe("ANCHORED");
    expect(a.verification).toBe("ATTESTATION_RECORDED");
    expect(a.bitcoinAttestations).toEqual([{ blockHeight: stamped.blockHeight, merkleRootHex: stamped.merkleRootInternal.toString("hex") }]);
  });

  it("correct proof with 1 confirmation → INSUFFICIENT_CONFIRMATIONS: Bitcoin verification pending, never verified", async () => {
    const pass = await verifyPass(row);
    expect(pass.check.kind).toBe("DECIDED");
    expect(pass.transition.kind).toBe("WRITE");
    expect(pass.row.otsChainVerificationStatus).toBe("INSUFFICIENT_CONFIRMATIONS");
    expect(pass.row.otsChainBlockHash).toBe(stamped.blockHash);
    expect(pass.row.otsChainConfirmations).toBe(1);
    expect(pass.verification).toBe("CHAIN_CONFIRMATIONS_PENDING");
    expect(pass.row.otsStatus).toBe("ANCHORED");
    row = pass.row;
  });

  it("a mutated proof (wrong merkle sibling) → FAILED ROOT_MISMATCH; proof integrity truth is not rewritten", async () => {
    const bytes = Buffer.from(stamped.base64, "base64");
    // Flip one byte inside the coinbase-txid PREPEND argument (the merkle sibling).
    const at = bytes.indexOf(reverseHex(stamped.coinbaseTxidDisplay));
    expect(at).toBeGreaterThan(0);
    bytes[at + 5] ^= 0xff;
    const pass = await verifyPass(rowFor({ ...stamped, base64: bytes.toString("base64") }));
    expect(pass.row.otsChainVerificationStatus).toBe("FAILED");
    expect(pass.row.otsChainFailureCode).toBe("ROOT_MISMATCH");
    expect(pass.verification).toBe("CHAIN_FAILED");
    expect(pass.row.otsStatus).toBe("ANCHORED");
    // Terminal: a second pass changes nothing.
    expect((await verifyPass(pass.row)).transition.kind).toBe("NO_CHANGE");
  });

  it("mine to the policy minimum → VERIFIED against the real header; merkle root and block hash match the node", async () => {
    await node.mine(MIN_CONFIRMATIONS - 1);
    const pass = await verifyPass(row);
    expect(pass.row.otsChainVerificationStatus).toBe("VERIFIED");
    expect(pass.row.otsChainBlockHash).toBe(stamped.blockHash);
    expect(pass.row.otsChainBlockHeight).toBe(stamped.blockHeight);
    expect(pass.row.otsChainConfirmations).toBe(MIN_CONFIRMATIONS);
    expect(pass.row.otsChainVerifier).toMatch(/^proovra-ots-chain\/1;core=\d+;min=6;proof=[0-9a-f]{16}$/);
    expect(pass.verification).toBe("CHAIN_VERIFIED");
    const header = await node.rpc<{ merkleroot: string }>("getblockheader", [stamped.blockHash, true]);
    expect(header.merkleroot).toBe(Buffer.from(stamped.merkleRootInternal).reverse().toString("hex"));
    row = pass.row;

    // The same block verified again stays verified (no new outcome).
    const again = await verifyPass(row);
    expect(again.verification).toBe("CHAIN_VERIFIED");
    expect(again.transition.kind === "WRITE" ? again.transition.material : false).toBe(false);
  });

  it("block invalidated → beyond the tip is temporarily unavailable (the VERIFIED record is kept); a replacement chain → FAILED REORGED", async () => {
    await node.rpc("invalidateblock", [stamped.blockHash]);
    expect(await node.tipHeight()).toBe(stamped.blockHeight - 1);
    const beyond = await verifyPass(row);
    expect(beyond.check).toMatchObject({ kind: "UNAVAILABLE", code: "BLOCK_BEYOND_TIP" });
    expect(beyond.transition.kind).toBe("NO_CHANGE");

    // A shorter replacement chain (2 blocks): another block now sits at the attested height.
    await node.mine(2);
    expect(await node.rpc<string>("getblockhash", [stamped.blockHeight])).not.toBe(stamped.blockHash);
    const reorged = await verifyPass(row);
    expect(reorged.row.otsChainVerificationStatus).toBe("FAILED");
    expect(reorged.row.otsChainFailureCode).toBe("REORGED");
    expect(reorged.verification).toBe("CHAIN_FAILED");
    expect(reorged.row.otsStatus).toBe("ANCHORED");
    row = reorged.row;

    // Still reorged on the next pass — REORGED never collapses into a terminal ROOT_MISMATCH.
    const still = await verifyPass(row);
    expect(still.row.otsChainFailureCode).toBe("REORGED");
    row = still.row;
  });

  it("original chain restored (most work) → VERIFIED again", async () => {
    await node.rpc("reconsiderblock", [stamped.blockHash]);
    expect(await node.rpc<string>("getblockhash", [stamped.blockHeight])).toBe(stamped.blockHash);
    const pass = await verifyPass(row);
    expect(pass.row.otsChainVerificationStatus).toBe("VERIFIED");
    expect(pass.row.otsChainBlockHash).toBe(stamped.blockHash);
    expect(pass.row.otsChainFailureCode).toBeNull();
    expect(pass.verification).toBe("CHAIN_VERIFIED");
  });
});
