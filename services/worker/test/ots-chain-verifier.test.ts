/**
 * THE OTS CHAIN VERIFIER, AGAINST A LOCAL TEST NODE (2026-10-12).
 *
 * A deterministic local fixture — NOT Production Bitcoin verification: a real
 * HTTP JSON-RPC server on loopback answers `getblockhash` / `getblockheader`
 * the way Bitcoin Core does (Basic auth from the node URL, `-8` for an unknown
 * height, `confirmations: -1` for a block off the best chain), and the
 * `ots verify` step is doubled with the client's own output lines. Every
 * outcome the worker records is exercised: unavailable, failed (each bounded
 * code), insufficient confirmations and verified — and the node URL, which
 * carries credentials, never appears in anything the verifier returns.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createBitcoindRpcVerifier,
  NOT_CONFIGURED_VERIFIER,
  OtsChainVerifierConfigError,
  resolveOtsChainVerifier,
  type OtsChainCheck,
} from "../src/ots-chain-verifier.js";

const HEIGHT = 860_000;
const BLOCK_HASH = "00000000000000000001ec3f183cf87a623516376df048fed10a1696ed0f328f";
const BLOCK_TIME = 1_724_745_600; // 2024-08-27T08:00:00Z
const DIGEST = "80546a5ba7055fb4e4e92bbe0f6031fb9da9d08a3f9a2ed112118fdc84f7e458";
const INPUT = { proofBase64: Buffer.from("proof-bytes").toString("base64"), digestHex: DIGEST, attestationBlockHeights: [HEIGHT] };

type NodeState = { confirmations: number; knownHeight: number; authSeen: string[] };
const node: NodeState = { confirmations: 12, knownHeight: HEIGHT, authSeen: [] };
let server: Server;
let nodeUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      node.authSeen.push(String(req.headers.authorization ?? ""));
      const { method, params, id } = JSON.parse(body) as { method: string; params: unknown[]; id: string };
      const reply = (result: unknown, error: { code: number; message: string } | null = null) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ result, error, id }));
      };
      if (req.headers.authorization !== `Basic ${Buffer.from("rpcuser:s3cret").toString("base64")}`) {
        res.statusCode = 401;
        return res.end();
      }
      if (method === "getblockhash") {
        return params[0] === node.knownHeight ? reply(BLOCK_HASH) : reply(null, { code: -8, message: "Block height out of range" });
      }
      if (method === "getblockheader") {
        return reply({ hash: BLOCK_HASH, height: node.knownHeight, time: BLOCK_TIME, confirmations: node.confirmations });
      }
      return reply(null, { code: -32601, message: "Method not found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  nodeUrl = `http://rpcuser:s3cret@127.0.0.1:${port}/`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const SUCCESS = { stdout: "", stderr: `Success! Bitcoin block ${HEIGHT} attests existence as of 2024-08-27 UTC\n`, errored: false };
const verifier = (over: Partial<Parameters<typeof createBitcoindRpcVerifier>[0]> = {}) =>
  createBitcoindRpcVerifier({
    nodeUrl,
    minConfirmations: 6,
    otsBin: "ots-not-installed-in-this-test",
    timeoutMs: 5_000,
    runOtsVerify: async () => SUCCESS,
    now: () => new Date("2026-10-12T10:00:00.000Z"),
    ...over,
  });
const noSecret = (check: OtsChainCheck) => expect(JSON.stringify(check)).not.toMatch(/s3cret|rpcuser/);

describe("configuration", () => {
  it("no verifier is the default and is NOT_CONFIGURED, never verified", async () => {
    expect(resolveOtsChainVerifier({})).toBe(NOT_CONFIGURED_VERIFIER);
    expect((await NOT_CONFIGURED_VERIFIER.verify(INPUT)).status).toBe("NOT_CONFIGURED");
  });
  it("bitcoind-rpc needs an http(s) node URL; any other kind is refused", () => {
    expect(() => resolveOtsChainVerifier({ OTS_CHAIN_VERIFIER: "bitcoind-rpc" })).toThrow(OtsChainVerifierConfigError);
    expect(() => resolveOtsChainVerifier({ OTS_CHAIN_VERIFIER: "bitcoind-rpc", OTS_BITCOIN_NODE_URL: "ftp://x" })).toThrow(/http/);
    expect(() => resolveOtsChainVerifier({ OTS_CHAIN_VERIFIER: "blockstream" })).toThrow(OtsChainVerifierConfigError);
    expect(() => resolveOtsChainVerifier({ OTS_CHAIN_VERIFIER: "bitcoind-rpc", OTS_BITCOIN_NODE_URL: nodeUrl, OTS_CHAIN_MIN_CONFIRMATIONS: "0" })).toThrow(/>= 1/);
    expect(resolveOtsChainVerifier({ OTS_CHAIN_VERIFIER: "bitcoind-rpc", OTS_BITCOIN_NODE_URL: nodeUrl }).kind).toBe("bitcoind-rpc");
  });
});

describe("outcomes against the local test node", () => {
  it("VERIFIED records the block it verified against, its time and confirmations — over authenticated RPC", async () => {
    node.confirmations = 12;
    node.knownHeight = HEIGHT;
    node.authSeen = [];
    const check = await verifier().verify(INPUT);
    expect(check).toMatchObject({
      status: "VERIFIED",
      blockHeight: HEIGHT,
      blockHash: BLOCK_HASH,
      blockTimeUtc: new Date(BLOCK_TIME * 1000),
      confirmations: 12,
      verifiedAtUtc: new Date("2026-10-12T10:00:00.000Z"),
    });
    expect((check as { verifier: string }).verifier).toMatch(/bitcoind RPC \(min 6 confirmations\)/);
    expect(node.authSeen.length).toBe(2);
    noSecret(check);
  });

  it("too few confirmations is INSUFFICIENT_CONFIRMATIONS (re-checked later), never verified", async () => {
    node.confirmations = 2;
    const check = await verifier().verify(INPUT);
    expect(check).toMatchObject({ status: "INSUFFICIENT_CONFIRMATIONS", confirmations: 2, requiredConfirmations: 6 });
  });

  it("FAILED, with a bounded code, when the node answers and the attestation does not hold", async () => {
    node.confirmations = -1; // a block no longer on the best chain
    expect(await verifier().verify(INPUT)).toMatchObject({ status: "FAILED", failureCode: "ATTESTATION_NOT_IN_CHAIN" });
    node.confirmations = 12;
    node.knownHeight = HEIGHT + 1; // the node does not know the reported height
    expect(await verifier().verify(INPUT)).toMatchObject({ status: "FAILED", failureCode: "BLOCK_NOT_FOUND" });
    node.knownHeight = HEIGHT;
    // `ots verify` succeeded on a different block than the proof reports.
    const other = { ...SUCCESS, stderr: `Success! Bitcoin block ${HEIGHT + 5} attests existence as of 2024-08-27 UTC` };
    expect(await verifier({ runOtsVerify: async () => other }).verify(INPUT)).toMatchObject({ status: "FAILED", failureCode: "BLOCK_HEIGHT_MISMATCH" });
    // The client ran against the node and refused the attestation.
    const rejected = { stdout: "", stderr: "Bitcoin block merkleroot mismatch: does not match", errored: true };
    expect(await verifier({ runOtsVerify: async () => rejected }).verify(INPUT)).toMatchObject({ status: "FAILED", failureCode: "VERIFIER_REJECTED_PROOF" });
    // No Bitcoin attestation at all.
    expect(await verifier().verify({ ...INPUT, attestationBlockHeights: [] })).toMatchObject({ status: "FAILED", failureCode: "NO_BITCOIN_ATTESTATION" });
  });

  it("UNAVAILABLE — never FAILED — when the node cannot be reached, and the credentials never leak", async () => {
    const down = `http://rpcuser:s3cret@127.0.0.1:1/`;
    const unreachable = { stdout: "", stderr: `Could not connect to Bitcoin node ${down}: Connection refused`, errored: true };
    const check = await createBitcoindRpcVerifier({
      nodeUrl: down,
      minConfirmations: 6,
      otsBin: "ots-not-installed-in-this-test",
      timeoutMs: 2_000,
      runOtsVerify: async () => unreachable,
    }).verify(INPUT);
    expect(check.status).toBe("UNAVAILABLE");
    noSecret(check);
    // ots verified, but the RPC half of the check cannot reach the node.
    const rpcDown = await createBitcoindRpcVerifier({
      nodeUrl: down,
      minConfirmations: 6,
      otsBin: "ots-not-installed-in-this-test",
      timeoutMs: 2_000,
      runOtsVerify: async () => SUCCESS,
    }).verify(INPUT);
    expect(rpcDown.status).toBe("UNAVAILABLE");
    noSecret(rpcDown);
  });
});
