/**
 * THE OPENTIMESTAMPS BITCOIN-CHAIN VERIFIER (worker side), deterministic.
 *
 * checkOtsProofAgainstBitcoin(anchoring, deps) fetches readiness facts and one
 * header per attested block through Bitcoin Core RPC and lets the pure shared
 * authority decide. These tests exercise every branch of that contract.
 *
 * MOCKS (clearly labelled):
 *   - FAKE RPC CLIENT: `fakeClient()` below is an in-memory stand-in for
 *     BtcRpcClient (getNetworkInfo, getBlockchainInfo, getBlockHash,
 *     getBlockHeaderRaw, getBlockHeaderVerbose). No network, no Bitcoin node.
 *     It records every call so tests can prove what was (not) fetched.
 *   - EXPLICIT CONFIG: an `enabled` config object is injected (deps.config);
 *     no environment variable, no password file and no secret is read.
 *   - FIXED CLOCK: deps.now returns a constant instant.
 *   - SYNTHETIC HEADERS: 80-byte block headers are assembled here whose
 *     hashMerkleRoot (internal byte order) is the merkle root the fixture
 *     proof's executed path produces; the block hash is their double SHA-256.
 *     The genesis probe answers with the REAL Bitcoin mainnet genesis header.
 *
 * The proof bytes are the real `ots stamp` proof plus a synthetic Bitcoin
 * branch (packages/shared/tests/helpers/ots-fixtures.mjs).
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  BITCOIN_MAINNET_GENESIS_HASH,
  BITCOIN_MAINNET_GENESIS_HEADER_HEX,
  OTS_CHAIN_POLICY_DEFAULTS,
  bitcoinHeaderHashDisplayHex,
  resolveOtsAnchoring,
  reverseHexBytes,
  type OtsAnchoring,
} from "@proovra/shared";

import { REAL, upgradedProof } from "../../../packages/shared/tests/helpers/ots-fixtures.mjs";
import type { OtsBitcoinVerifierConfig } from "../src/ots-bitcoin-config.js";
import { BtcRpcError } from "../src/ots-bitcoin-rpc.js";
import {
  OTS_BLOCK_BEYOND_TIP_GRACE,
  checkOtsProofAgainstBitcoin,
  getOtsBitcoinVerifierReadiness,
  probeOtsBitcoinVerifierReadiness,
  type OtsBitcoinVerifierDeps,
} from "../src/ots-bitcoin-verifier.js";

const FP = REAL.boundFingerprintHash;
const NOW = new Date("2026-10-15T12:00:00.000Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const NODE_VERSION = 270100;

const UP = upgradedProof();
const H = UP.blockHeight;
const ROOT = UP.merkleRootHex!;

/** EXPLICIT TEST CONFIG — never resolved from the environment. */
const CONFIG: OtsBitcoinVerifierConfig = {
  kind: "enabled",
  rpcUrl: "http://127.0.0.1:8332/",
  rpcEndpointLabel: "127.0.0.1:8332",
  username: "test-user",
  timeoutMs: 5_000,
  policy: { ...OTS_CHAIN_POLICY_DEFAULTS },
  passwordFile: null,
};

function anchoringOf(base64: string, status = "ANCHORED"): OtsAnchoring {
  return resolveOtsAnchoring({ status, proofBase64: base64, fingerprintHash: FP, otsHash: FP });
}

/** SYNTHETIC 80-byte header: version · prev · merkleRoot (internal order) · time · bits · nonce. */
function headerHex(merkleRootInternalHex: string, timeSeconds: number, nonce = 7): string {
  const b = Buffer.alloc(80);
  b.writeUInt32LE(0x20000000, 0);
  Buffer.alloc(32, 0x00).copy(b, 4);
  Buffer.from(merkleRootInternalHex, "hex").copy(b, 36);
  b.writeUInt32LE(timeSeconds >>> 0, 68);
  b.writeUInt32LE(0x1d00ffff, 72);
  b.writeUInt32LE(nonce, 76);
  return b.toString("hex");
}
const hashOf = (rawHex: string) => bitcoinHeaderHashDisplayHex(Buffer.from(rawHex, "hex"));

const BLOCK_TIME_S = NOW_S - 86_400 * 30;

type Scenario = {
  network: { version: number; subversion: string };
  chain: {
    chain: string;
    blocks: number;
    headers: number;
    initialblockdownload: boolean;
    verificationprogress: number;
    time: number;
    bestblockhash: string;
    warnings: string | string[];
  };
  genesisHash: string | null;
  genesisRaw: string;
  /** height → block hash (null = RPC -8, beyond the active tip). */
  hashes: Map<number, string | null>;
  raw: Map<string, string>;
  verbose: Map<string, { hash: string; height: number; confirmations: number; merkleroot: string }>;
  throwOn?: { method: string; error: unknown };
};

type Call = { method: string; arg?: unknown };

/** FAKE RPC CLIENT — in-memory, records every call. */
function fakeClient(s: Scenario): { client: NonNullable<OtsBitcoinVerifierDeps["client"]>; calls: Call[] } {
  const calls: Call[] = [];
  const maybeThrow = (method: string) => {
    if (s.throwOn?.method === method) throw s.throwOn.error;
  };
  const client: NonNullable<OtsBitcoinVerifierDeps["client"]> = {
    async getNetworkInfo() {
      calls.push({ method: "getNetworkInfo" });
      maybeThrow("getNetworkInfo");
      return { ...s.network };
    },
    async getBlockchainInfo() {
      calls.push({ method: "getBlockchainInfo" });
      maybeThrow("getBlockchainInfo");
      return { ...s.chain };
    },
    async getBlockHash(height: number) {
      calls.push({ method: "getBlockHash", arg: height });
      maybeThrow("getBlockHash");
      if (height === 0) return s.genesisHash;
      return s.hashes.has(height) ? s.hashes.get(height)! : null;
    },
    async getBlockHeaderRaw(blockHash: string) {
      calls.push({ method: "getBlockHeaderRaw", arg: blockHash });
      if (blockHash === s.genesisHash) return s.genesisRaw;
      maybeThrow("getBlockHeaderRaw");
      const r = s.raw.get(blockHash);
      if (r === undefined) throw new BtcRpcError("BTC_RPC_ERROR", "getblockheader", "unknown block", -5);
      return r;
    },
    async getBlockHeaderVerbose(blockHash: string) {
      calls.push({ method: "getBlockHeaderVerbose", arg: blockHash });
      maybeThrow("getBlockHeaderVerbose");
      const v = s.verbose.get(blockHash);
      if (v === undefined) throw new BtcRpcError("BTC_RPC_ERROR", "getblockheader", "unknown block", -5);
      return { ...v };
    },
  };
  return { client, calls };
}

/** A healthy mainnet node whose block H carries the header for `root`. */
function scenario(o: { root?: string; tip?: number; confirmations?: number } = {}): Scenario {
  const tip = o.tip ?? H + 9;
  const raw = headerHex(o.root ?? ROOT, BLOCK_TIME_S);
  const hash = hashOf(raw);
  const s: Scenario = {
    network: { version: NODE_VERSION, subversion: "/Satoshi:27.1.0/" },
    chain: {
      chain: "main",
      blocks: tip,
      headers: tip,
      initialblockdownload: false,
      verificationprogress: 1,
      time: NOW_S - 300,
      bestblockhash: "00".repeat(32),
      warnings: "",
    },
    genesisHash: BITCOIN_MAINNET_GENESIS_HASH,
    genesisRaw: BITCOIN_MAINNET_GENESIS_HEADER_HEX,
    hashes: new Map([[H, hash]]),
    raw: new Map([[hash, raw]]),
    verbose: new Map([
      [hash, { hash, height: H, confirmations: o.confirmations ?? tip - H + 1, merkleroot: reverseHexBytes(o.root ?? ROOT) }],
    ]),
  };
  return s;
}
const blockHashOf = (s: Scenario) => s.hashes.get(H)!;

async function check(s: Scenario, anchoring: OtsAnchoring = anchoringOf(UP.base64), config: OtsBitcoinVerifierConfig = CONFIG) {
  const { client, calls } = fakeClient(s);
  const result = await checkOtsProofAgainstBitcoin(anchoring, { config, client, now: () => NOW });
  return { result, calls };
}

beforeEach(() => {
  // Sanity: the fixture proof resolves ANCHORED at H with the expected root.
  const a = anchoringOf(UP.base64);
  expect(a.state).toBe("ANCHORED");
  expect(a.bitcoinAttestations).toEqual([{ blockHeight: H, merkleRootHex: ROOT }]);
  expect(a.proofSha256).toBe(UP.proofSha256);
});

describe("checkOtsProofAgainstBitcoin — the chain answers", () => {
  it("VERIFIED: the replayed commitment is the raw header's merkle root of an active-chain block deep enough", async () => {
    const s = scenario();
    const { result } = await check(s);
    expect(result.kind).toBe("DECIDED");
    if (result.kind !== "DECIDED") return;
    expect(result.decision.status).toBe("VERIFIED");
    expect(result.decision.failureCode).toBeNull();
    expect(result.decision.blockHeight).toBe(H);
    expect(result.decision.blockHash).toBe(blockHashOf(s));
    expect(result.decision.confirmations).toBe(10);
    expect(result.decision.blockTimeUtc).toBe(new Date(BLOCK_TIME_S * 1000).toISOString());
    expect(result.verifier).toBe(`proovra-ots-chain/1;core=${NODE_VERSION};min=6;proof=${UP.proofSha256.slice(0, 16)}`);
    expect(result.checkedAtUtc).toEqual(NOW);
    expect(result.tip.height).toBe(H + 9);
    expect(result.tip.chain).toBe("main");
    expect(result.tip.nodeVersion).toBe(NODE_VERSION);
  });

  it("ROOT_MISMATCH: a proof whose merkle path differs from the block's root is FAILED", async () => {
    const other = upgradedProof({ merkleLevels: 4 });
    expect(other.blockHeight).toBe(H);
    expect(other.merkleRootHex).not.toBe(ROOT);
    // The block at H carries the OTHER proof's root; UP is checked against it.
    const { result } = await check(scenario({ root: other.merkleRootHex! }));
    expect(result.kind).toBe("DECIDED");
    if (result.kind !== "DECIDED") return;
    expect(result.decision.status).toBe("FAILED");
    expect(result.decision.failureCode).toBe("ROOT_MISMATCH");
    expect(result.decision.blockHeight).toBe(H);
    expect(result.decision.blockHash).toBeNull();
  });

  it("INSUFFICIENT_CONFIRMATIONS: a matching block below the policy depth", async () => {
    const s = scenario({ tip: H + 1, confirmations: 2 });
    const { result } = await check(s);
    expect(result.kind).toBe("DECIDED");
    if (result.kind !== "DECIDED") return;
    expect(result.decision.status).toBe("INSUFFICIENT_CONFIRMATIONS");
    expect(result.decision.failureCode).toBe("INSUFFICIENT_CONFIRMATIONS");
    expect(result.decision.confirmations).toBe(2);
    expect(result.decision.blockHash).toBe(blockHashOf(s));
  });

  it("confirmations -1 (a stale-branch header) is FAILED NOT_IN_ACTIVE_CHAIN", async () => {
    const { result } = await check(scenario({ confirmations: -1 }));
    expect(result.kind).toBe("DECIDED");
    if (result.kind !== "DECIDED") return;
    expect(result.decision.status).toBe("FAILED");
    expect(result.decision.failureCode).toBe("NOT_IN_ACTIVE_CHAIN");
  });

  it("an attested height more than the grace beyond the tip is FAILED NOT_IN_ACTIVE_CHAIN, without fetching it", async () => {
    const s = scenario({ tip: H - (OTS_BLOCK_BEYOND_TIP_GRACE + 1) });
    const { result, calls } = await check(s);
    expect(result.kind).toBe("DECIDED");
    if (result.kind !== "DECIDED") return;
    expect(result.decision.status).toBe("FAILED");
    expect(result.decision.failureCode).toBe("NOT_IN_ACTIVE_CHAIN");
    expect(calls.some((c) => c.method === "getBlockHash" && c.arg === H)).toBe(false);
  });

  it("a height at or below the tip whose getblockhash answers -8 (null) is FAILED NOT_IN_ACTIVE_CHAIN", async () => {
    const s = scenario();
    s.hashes.set(H, null);
    const { result, calls } = await check(s);
    expect(result.kind).toBe("DECIDED");
    if (result.kind !== "DECIDED") return;
    expect(result.decision.status).toBe("FAILED");
    expect(result.decision.failureCode).toBe("NOT_IN_ACTIVE_CHAIN");
    expect(calls.some((c) => c.method === "getBlockHash" && c.arg === H)).toBe(true);
    expect(calls.some((c) => c.method === "getBlockHeaderVerbose")).toBe(false);
  });

  it("INVALID_HEADER: the verbose header names another block hash", async () => {
    const s = scenario();
    const hash = blockHashOf(s);
    s.verbose.set(hash, { ...s.verbose.get(hash)!, hash: "ab".repeat(32) });
    const { result } = await check(s);
    expect(result.kind).toBe("DECIDED");
    if (result.kind !== "DECIDED") return;
    expect(result.decision.status).toBe("FAILED");
    expect(result.decision.failureCode).toBe("INVALID_HEADER");
  });

  it("INVALID_HEADER: the verbose header reports another height", async () => {
    const s = scenario();
    const hash = blockHashOf(s);
    s.verbose.set(hash, { ...s.verbose.get(hash)!, height: H + 1 });
    const { result } = await check(s);
    expect(result.kind).toBe("DECIDED");
    if (result.kind !== "DECIDED") return;
    expect(result.decision.status).toBe("FAILED");
    expect(result.decision.failureCode).toBe("INVALID_HEADER");
  });

  it("INVALID_HEADER: the raw header does not hash to the block hash getblockhash returned", async () => {
    const s = scenario();
    const realHash = blockHashOf(s);
    const claimed = "cd".repeat(32);
    s.hashes.set(H, claimed);
    s.raw.set(claimed, s.raw.get(realHash)!);
    s.verbose.set(claimed, { ...s.verbose.get(realHash)!, hash: claimed });
    const { result } = await check(s);
    expect(result.kind).toBe("DECIDED");
    if (result.kind !== "DECIDED") return;
    expect(result.decision.status).toBe("FAILED");
    expect(result.decision.failureCode).toBe("INVALID_HEADER");
  });
});

describe("checkOtsProofAgainstBitcoin — the verifier could not check (UNAVAILABLE, never FAILED)", () => {
  async function expectUnavailable(s: Scenario, code: string) {
    const { result, calls } = await check(s);
    expect(result.kind).toBe("UNAVAILABLE");
    if (result.kind !== "UNAVAILABLE") return calls;
    expect(result.code).toBe(code);
    expect(result.checkedAtUtc).toEqual(NOW);
    expect(result.detail.length).toBeLessThanOrEqual(200);
    return calls;
  }

  it("wrong network chain → WRONG_CHAIN, no block fetched", async () => {
    const s = scenario();
    s.chain.chain = "test";
    const calls = await expectUnavailable(s, "WRONG_CHAIN");
    expect(calls.some((c) => c.method === "getBlockHash" && c.arg === H)).toBe(false);
  });

  it("initial block download → INITIAL_BLOCK_DOWNLOAD", async () => {
    const s = scenario();
    s.chain.initialblockdownload = true;
    await expectUnavailable(s, "INITIAL_BLOCK_DOWNLOAD");
  });

  it("a tip older than maxTipAgeSeconds → NODE_STALE", async () => {
    const s = scenario();
    s.chain.time = NOW_S - (OTS_CHAIN_POLICY_DEFAULTS.maxTipAgeSeconds + 1);
    await expectUnavailable(s, "NODE_STALE");
  });

  it("headers ahead of blocks by more than maxHeaderLag → HEADER_LAG", async () => {
    const s = scenario();
    s.chain.headers = s.chain.blocks + OTS_CHAIN_POLICY_DEFAULTS.maxHeaderLag + 1;
    await expectUnavailable(s, "HEADER_LAG");
  });

  it("node warnings (string form) → NODE_WARNINGS", async () => {
    const s = scenario();
    s.chain.warnings = "Unknown new rules activated";
    await expectUnavailable(s, "NODE_WARNINGS");
  });

  it("node warnings (array form) → NODE_WARNINGS", async () => {
    const s = scenario();
    s.chain.warnings = ["", "This is a pre-release test build"];
    await expectUnavailable(s, "NODE_WARNINGS");
  });

  it("a node older than minNodeVersion → UNSUPPORTED_NODE_VERSION", async () => {
    const s = scenario();
    s.network.version = OTS_CHAIN_POLICY_DEFAULTS.minNodeVersion - 1;
    await expectUnavailable(s, "UNSUPPORTED_NODE_VERSION");
  });

  it("a genesis hash that is not mainnet's → GENESIS_MISMATCH", async () => {
    const s = scenario();
    s.genesisHash = "00".repeat(31) + "01";
    await expectUnavailable(s, "GENESIS_MISMATCH");
  });

  it("a genesis header that does not hash to mainnet's genesis → GENESIS_MISMATCH", async () => {
    const s = scenario();
    s.genesisRaw = BITCOIN_MAINNET_GENESIS_HEADER_HEX.slice(0, -2) + "00";
    await expectUnavailable(s, "GENESIS_MISMATCH");
  });

  it("an attested block within the grace beyond the tip → BLOCK_BEYOND_TIP, without fetching it", async () => {
    const s = scenario({ tip: H - OTS_BLOCK_BEYOND_TIP_GRACE });
    const calls = await expectUnavailable(s, "BLOCK_BEYOND_TIP");
    expect(calls.some((c) => c.method === "getBlockHash" && c.arg === H)).toBe(false);
  });

  it("a BtcRpcError mid-way (timeout on the verbose header) → its own code", async () => {
    const s = scenario();
    s.throwOn = { method: "getBlockHeaderVerbose", error: new BtcRpcError("BTC_RPC_TIMEOUT", "getblockheader", "timed out") };
    await expectUnavailable(s, "BTC_RPC_TIMEOUT");
  });

  it("any other throw → BTC_RPC_UNAVAILABLE", async () => {
    const s = scenario();
    s.throwOn = { method: "getBlockHeaderRaw", error: new Error("socket hang up") };
    await expectUnavailable(s, "BTC_RPC_UNAVAILABLE");
  });

  it("a readiness RPC that throws → its code (never a crash)", async () => {
    const s = scenario();
    s.throwOn = { method: "getBlockchainInfo", error: new BtcRpcError("BTC_RPC_UNAUTHORIZED", "getblockchaininfo", "401") };
    await expectUnavailable(s, "BTC_RPC_UNAUTHORIZED");
  });
});

describe("checkOtsProofAgainstBitcoin — configuration and proof preconditions", () => {
  it("disabled: DISABLED and the client is never called", async () => {
    const { result, calls } = await check(scenario(), anchoringOf(UP.base64), { kind: "disabled" });
    expect(result).toEqual({ kind: "DISABLED" });
    expect(calls).toEqual([]);
  });

  it("misconfigured: UNAVAILABLE BTC_RPC_MISCONFIGURED and the client is never called", async () => {
    const { result, calls } = await check(scenario(), anchoringOf(UP.base64), { kind: "misconfigured", reason: "OTS_BITCOIN_RPC_URL is required" });
    expect(result.kind).toBe("UNAVAILABLE");
    if (result.kind !== "UNAVAILABLE") return;
    expect(result.code).toBe("BTC_RPC_MISCONFIGURED");
    expect(calls).toEqual([]);
  });

  it("a non-ANCHORED proof (pending calendar attestations only) → UNAVAILABLE NO_BITCOIN_ATTESTATION, client never called", async () => {
    const pending = anchoringOf(REAL.boundProofBase64, "PENDING");
    expect(pending.state).toBe("PENDING");
    const { result, calls } = await check(scenario(), pending);
    expect(result.kind).toBe("UNAVAILABLE");
    if (result.kind !== "UNAVAILABLE") return;
    expect(result.code).toBe("NO_BITCOIN_ATTESTATION");
    expect(calls).toEqual([]);
  });
});

describe("probeOtsBitcoinVerifierReadiness", () => {
  it("a healthy node is ready, and the last probe is what getOtsBitcoinVerifierReadiness reports", async () => {
    const { client } = fakeClient(scenario());
    const r = await probeOtsBitcoinVerifierReadiness({ config: CONFIG, client, now: () => NOW });
    expect(r.ready).toBe(true);
    expect(r.enabled).toBe(true);
    expect(r.code).toBeNull();
    expect(r.chain).toBe("main");
    expect(r.tipHeight).toBe(H + 9);
    expect(r.nodeVersion).toBe(NODE_VERSION);
    expect(r.endpoint).toBe("127.0.0.1:8332");
    expect(r.observedAtUtc).toBe(NOW.toISOString());
    expect(getOtsBitcoinVerifierReadiness()).toEqual(r);
  });

  it("a later not-ready probe replaces the remembered readiness", async () => {
    const s = scenario();
    s.chain.chain = "test";
    const { client } = fakeClient(s);
    const r = await probeOtsBitcoinVerifierReadiness({ config: CONFIG, client, now: () => NOW });
    expect(r.ready).toBe(false);
    expect(r.code).toBe("WRONG_CHAIN");
    expect(getOtsBitcoinVerifierReadiness()).toEqual(r);
  });
});
