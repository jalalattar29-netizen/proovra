/**
 * INDEPENDENT BITCOIN CHAIN VERIFICATION OF AN OPENTIMESTAMPS PROOF (2026-10-12).
 *
 * The proof's Bitcoin attestation is a CLAIM read from its bytes. Verifying it
 * means walking the proof's commitment path to a block-header merkle root and
 * comparing it with the Bitcoin chain — the canonical `ots verify`, which needs
 * a Bitcoin node — and recording which block it verified against, when, and
 * with how many confirmations. No public block-explorer answer is accepted as
 * that verification; the operator names the node PROOVRA trusts.
 *
 * Configuration (worker only; read on every check, no restart-time caching):
 *
 *   OTS_CHAIN_VERIFIER           "none" (default) | "bitcoind-rpc"
 *   OTS_BITCOIN_NODE_URL         SECRET. http(s)://<rpcuser>:<rpcpassword>@<host>:<port>
 *                                of a Bitcoin Core node (mainnet). Required for
 *                                "bitcoind-rpc"; never logged or persisted.
 *   OTS_CHAIN_MIN_CONFIRMATIONS  integer >= 1, default 6. Fewer confirmations
 *                                are INSUFFICIENT_CONFIRMATIONS, re-checked
 *                                later: an attestation in a block that a reorg
 *                                can still remove is never called verified.
 *
 * Outcomes (persisted as evidence.ots_chain_verification_status):
 *   NOT_CONFIGURED              no verifier: the truthful state stays
 *                               ATTESTATION_PRESENT_NOT_VERIFIED
 *   UNAVAILABLE                 the configured node could not be reached or the
 *                               check could not conclude — NOT a failure
 *   INSUFFICIENT_CONFIRMATIONS  verified path, too few confirmations so far
 *   FAILED                      the node was reached and the attestation did
 *                               not verify (bounded failure code)
 *   VERIFIED                    with block height, hash, time, confirmations,
 *                               the verifier identity and the verification time
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { OtsChainFailureCode } from "@proovra/shared";

import { parseOtsVerifyOutput } from "./ots-upgrade-output.js";

const execFileAsync = promisify(execFile);

export type OtsChainCheck =
  | { status: "NOT_CONFIGURED"; checkedAtUtc: Date; verifier: null }
  | { status: "UNAVAILABLE"; checkedAtUtc: Date; verifier: string; reason: string }
  | {
      status: "INSUFFICIENT_CONFIRMATIONS";
      checkedAtUtc: Date;
      verifier: string;
      blockHeight: number;
      confirmations: number;
      requiredConfirmations: number;
    }
  | { status: "FAILED"; checkedAtUtc: Date; verifier: string; failureCode: OtsChainFailureCode }
  | {
      status: "VERIFIED";
      checkedAtUtc: Date;
      verifier: string;
      verifiedAtUtc: Date;
      blockHeight: number;
      blockHash: string;
      blockTimeUtc: Date;
      confirmations: number;
    };

export type OtsChainVerifyInput = {
  proofBase64: string;
  /** The digest the proof commits to (the record's fingerprint digest). */
  digestHex: string;
  /** Block heights the proof reports (read from its bytes). */
  attestationBlockHeights: readonly number[];
};

export interface OtsChainVerifier {
  readonly kind: "none" | "bitcoind-rpc" | "test-double";
  verify(input: OtsChainVerifyInput): Promise<OtsChainCheck>;
}

export const DEFAULT_OTS_CHAIN_MIN_CONFIRMATIONS = 6;

export class OtsChainVerifierConfigError extends Error {
  constructor(message: string) {
    super(`OTS_CHAIN_VERIFIER_CONFIG: ${message}`);
    this.name = "OtsChainVerifierConfigError";
  }
}

export function readOtsChainMinConfirmations(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OTS_CHAIN_MIN_CONFIRMATIONS?.trim();
  if (!raw) return DEFAULT_OTS_CHAIN_MIN_CONFIRMATIONS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new OtsChainVerifierConfigError("OTS_CHAIN_MIN_CONFIRMATIONS must be an integer >= 1");
  }
  return n;
}

/** The verifier the environment configures. Never throws for "none". */
export function resolveOtsChainVerifier(env: NodeJS.ProcessEnv = process.env): OtsChainVerifier {
  const kind = (env.OTS_CHAIN_VERIFIER ?? "none").trim().toLowerCase() || "none";
  if (kind === "none") return NOT_CONFIGURED_VERIFIER;
  if (kind === "bitcoind-rpc") {
    const url = env.OTS_BITCOIN_NODE_URL?.trim();
    if (!url) throw new OtsChainVerifierConfigError('OTS_CHAIN_VERIFIER="bitcoind-rpc" requires OTS_BITCOIN_NODE_URL');
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new OtsChainVerifierConfigError("OTS_BITCOIN_NODE_URL is not a URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new OtsChainVerifierConfigError("OTS_BITCOIN_NODE_URL must be http(s)");
    }
    return createBitcoindRpcVerifier({
      nodeUrl: url,
      minConfirmations: readOtsChainMinConfirmations(env),
      otsBin: env.OTS_BIN?.trim() || "ots",
      timeoutMs: Number(env.OTS_TIMEOUT_MS) > 0 ? Number(env.OTS_TIMEOUT_MS) : 30_000,
    });
  }
  throw new OtsChainVerifierConfigError('OTS_CHAIN_VERIFIER must be "none" or "bitcoind-rpc"');
}

export const NOT_CONFIGURED_VERIFIER: OtsChainVerifier = {
  kind: "none",
  async verify() {
    return { status: "NOT_CONFIGURED", checkedAtUtc: new Date(), verifier: null };
  },
};

// ---------------------------------------------------------------------------
// bitcoind RPC verifier
// ---------------------------------------------------------------------------

type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

class RpcError extends Error {
  constructor(
    readonly code: number | null,
    message: string,
  ) {
    super(message);
  }
}

function makeRpc(nodeUrl: string, timeoutMs: number): RpcCall {
  const parsed = new URL(nodeUrl);
  const auth =
    parsed.username || parsed.password
      ? `Basic ${Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString("base64")}`
      : null;
  parsed.username = "";
  parsed.password = "";
  const endpoint = parsed.toString();
  return async (method, params) => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify({ jsonrpc: "1.0", id: "proovra-ots", method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => null)) as { result?: unknown; error?: { code?: number; message?: string } | null } | null;
    if (!body) throw new RpcError(null, `node answered HTTP ${res.status} without JSON`);
    if (body.error) throw new RpcError(typeof body.error.code === "number" ? body.error.code : null, String(body.error.message ?? "rpc error"));
    return body.result;
  };
}

/** bitcoind: -8 / -5 — the requested height or block does not exist. */
const RPC_NOT_FOUND = new Set([-8, -5]);

let otsVersionCache: Promise<string> | null = null;
async function otsClientVersion(otsBin: string): Promise<string> {
  otsVersionCache ??= execFileAsync(otsBin, ["--version"], { timeout: 10_000 })
    .then((r) => `${r.stdout}${r.stderr}`.trim().replace(/^v/, "") || "unknown")
    .catch(() => "unknown");
  return otsVersionCache;
}

const isUnreachable = (text: string) =>
  /could not connect to bitcoin node|connection refused|timed? ?out|name or service not known|network is unreachable|cookie file unusable|rpcpassword/i.test(
    text,
  );

export function createBitcoindRpcVerifier(opts: {
  nodeUrl: string;
  minConfirmations: number;
  otsBin: string;
  timeoutMs: number;
  /** Injected in tests; defaults to JSON-RPC over HTTP to `nodeUrl`. */
  rpc?: RpcCall;
  /** Injected in tests; defaults to running `ots --bitcoin-node … verify`. */
  runOtsVerify?: (args: { proofFile: string; digestHex: string }) => Promise<{ stdout: string; stderr: string; errored: boolean }>;
  now?: () => Date;
}): OtsChainVerifier {
  const rpc = opts.rpc ?? makeRpc(opts.nodeUrl, opts.timeoutMs);
  const now = opts.now ?? (() => new Date());
  const runOtsVerify =
    opts.runOtsVerify ??
    (async ({ proofFile, digestHex }) => {
      try {
        const r = await execFileAsync(
          opts.otsBin,
          ["--bitcoin-node", opts.nodeUrl, "verify", "-d", digestHex, proofFile],
          { timeout: opts.timeoutMs },
        );
        return { stdout: r.stdout?.toString() ?? "", stderr: r.stderr?.toString() ?? "", errored: false };
      } catch (error) {
        const e = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
        return { stdout: (e.stdout ?? "").toString(), stderr: (e.stderr ?? e.message ?? "").toString(), errored: true };
      }
    });

  return {
    kind: "bitcoind-rpc",
    async verify(input) {
      const checkedAtUtc = now();
      const verifier = `opentimestamps-client ${await otsClientVersion(opts.otsBin)} + bitcoind RPC (min ${opts.minConfirmations} confirmations)`;
      if (input.attestationBlockHeights.length === 0) {
        return { status: "FAILED", checkedAtUtc, verifier, failureCode: "NO_BITCOIN_ATTESTATION" };
      }
      const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "ots-chain-"));
      try {
        const proofFile = path.join(workDir, "proof.ots");
        await fs.writeFile(proofFile, Buffer.from(input.proofBase64, "base64"));
        const out = await runOtsVerify({ proofFile, digestHex: input.digestHex.toLowerCase() });
        // The node URL carries credentials: it is never part of a reason.
        const merged = `${out.stdout}\n${out.stderr}`.split(opts.nodeUrl).join("<node>");
        const parsed = parseOtsVerifyOutput(out.stdout, out.stderr);
        if (!parsed.verified) {
          if (isUnreachable(merged) || out.errored === false) {
            return { status: "UNAVAILABLE", checkedAtUtc, verifier, reason: "the Bitcoin node could not be reached or the check did not conclude" };
          }
          // The client ran against the node and refused the attestation.
          return /mismatch|does not match|invalid|failed|bad/i.test(merged)
            ? { status: "FAILED", checkedAtUtc, verifier, failureCode: "VERIFIER_REJECTED_PROOF" }
            : { status: "UNAVAILABLE", checkedAtUtc, verifier, reason: "the verifier did not reach a conclusion" };
        }
        const height = parsed.blockHeight;
        if (height === null || !input.attestationBlockHeights.includes(height)) {
          return { status: "FAILED", checkedAtUtc, verifier, failureCode: "BLOCK_HEIGHT_MISMATCH" };
        }
        let blockHash: string;
        let header: { time?: unknown; confirmations?: unknown; height?: unknown; hash?: unknown };
        try {
          blockHash = String(await rpc("getblockhash", [height]));
          header = (await rpc("getblockheader", [blockHash, true])) as typeof header;
        } catch (error) {
          if (error instanceof RpcError && error.code !== null && RPC_NOT_FOUND.has(error.code)) {
            return { status: "FAILED", checkedAtUtc, verifier, failureCode: "BLOCK_NOT_FOUND" };
          }
          return { status: "UNAVAILABLE", checkedAtUtc, verifier, reason: "the Bitcoin node RPC could not be reached" };
        }
        const confirmations = Number(header.confirmations);
        const time = Number(header.time);
        if (!/^[0-9a-f]{64}$/.test(blockHash) || header.hash !== blockHash || Number(header.height) !== height) {
          return { status: "FAILED", checkedAtUtc, verifier, failureCode: "BLOCK_NOT_FOUND" };
        }
        // A block no longer on the best chain reports confirmations = -1.
        if (!Number.isInteger(confirmations) || confirmations < 1) {
          return { status: "FAILED", checkedAtUtc, verifier, failureCode: "ATTESTATION_NOT_IN_CHAIN" };
        }
        if (!Number.isInteger(time) || time <= 0) {
          return { status: "UNAVAILABLE", checkedAtUtc, verifier, reason: "the node returned no block time" };
        }
        const blockTimeUtc = new Date(time * 1000);
        // `ots verify` reads the same header; a disagreement is not a verification.
        if (parsed.anchoredAtUtc && new Date(parsed.anchoredAtUtc).getTime() !== blockTimeUtc.getTime()) {
          return { status: "FAILED", checkedAtUtc, verifier, failureCode: "BLOCK_HEIGHT_MISMATCH" };
        }
        if (confirmations < opts.minConfirmations) {
          return {
            status: "INSUFFICIENT_CONFIRMATIONS",
            checkedAtUtc,
            verifier,
            blockHeight: height,
            confirmations,
            requiredConfirmations: opts.minConfirmations,
          };
        }
        return {
          status: "VERIFIED",
          checkedAtUtc,
          verifier,
          verifiedAtUtc: checkedAtUtc,
          blockHeight: height,
          blockHash,
          blockTimeUtc,
          confirmations,
        };
      } finally {
        await fs.rm(workDir, { recursive: true, force: true });
      }
    },
  };
}
