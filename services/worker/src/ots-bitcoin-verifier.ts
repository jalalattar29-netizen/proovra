/**
 * THE OPENTIMESTAMPS BITCOIN-CHAIN VERIFIER — worker side.
 *
 * Fetches, through the dedicated Bitcoin Core node, exactly the facts the pure
 * authority (packages/shared ots-chain-verification.ts) needs, and lets that
 * authority decide. Bitcoin Core RPC is the ONLY chain authority; the
 * official `ots` client is never asked to verify (it is used for stamp and
 * upgrade only).
 *
 * Per verification, in this order:
 *   1. readiness — network info, chain info and a genesis probe, evaluated
 *      against the policy NOW (never a cached boolean);
 *   2. every valid Bitcoin attestation of the stored proof, ascending height:
 *      getblockhash(height) → getblockheader(hash,false) [80 raw bytes] →
 *      getblockheader(hash,true) → verifyOtsChainCandidate;
 *   3. decideOtsChainVerification over the outcomes.
 *
 * Anything that stops a check (not ready, unauthorized, timeout, malformed
 * answer, misconfiguration) is UNAVAILABLE with a bounded code — retryable,
 * never a proof failure and never a verification.
 */
import {
  decideOtsChainVerification,
  evaluateOtsChainReadiness,
  formatOtsChainVerifier,
  orderOtsChainCandidates,
  verifyOtsChainCandidate,
  type OtsAnchoring,
  type OtsChainCandidateOutcome,
  type OtsChainDecision,
  type OtsChainFailureCode,
} from "@proovra/shared";

import { resolveOtsBitcoinVerifierConfig, rpcPassword, type OtsBitcoinVerifierConfig } from "./ots-bitcoin-config.js";
import { BtcRpcClient, BtcRpcError } from "./ots-bitcoin-rpc.js";

/** A block this far beyond the node's tip is not in the active chain; closer is "not yet". */
export const OTS_BLOCK_BEYOND_TIP_GRACE = 6;

export type OtsChainCheck =
  | { kind: "DISABLED" }
  | { kind: "UNAVAILABLE"; code: OtsChainFailureCode; detail: string; checkedAtUtc: Date }
  | {
      kind: "DECIDED";
      decision: OtsChainDecision;
      /** For ots_chain_verifier: bound to the proof and the policy. */
      verifier: string;
      checkedAtUtc: Date;
      tip: { chain: string; height: number; nodeVersion: number };
    };

export type OtsBitcoinVerifierReadiness = {
  enabled: boolean;
  ready: boolean | null;
  code: string | null;
  detail: string | null;
  observedAtUtc: string | null;
  chain: string | null;
  tipHeight: number | null;
  nodeVersion: number | null;
  endpoint: string | null;
};

let lastReadiness: OtsBitcoinVerifierReadiness = {
  enabled: false,
  ready: null,
  code: null,
  detail: null,
  observedAtUtc: null,
  chain: null,
  tipHeight: null,
  nodeVersion: null,
  endpoint: null,
};

/** The last readiness this process observed — for /health and telemetry. Never a secret. */
export function getOtsBitcoinVerifierReadiness(): OtsBitcoinVerifierReadiness {
  return { ...lastReadiness };
}

function remember(r: OtsBitcoinVerifierReadiness): void {
  lastReadiness = r;
}

export type OtsBitcoinVerifierDeps = {
  config?: OtsBitcoinVerifierConfig;
  client?: Pick<BtcRpcClient, "getNetworkInfo" | "getBlockchainInfo" | "getBlockHash" | "getBlockHeaderRaw" | "getBlockHeaderVerbose">;
  now?: () => Date;
};

function clientFor(config: Extract<OtsBitcoinVerifierConfig, { kind: "enabled" }>): BtcRpcClient {
  return new BtcRpcClient({
    url: config.rpcUrl,
    username: config.username,
    password: () => rpcPassword(config),
    timeoutMs: config.timeoutMs,
  });
}

function unavailable(code: OtsChainFailureCode, detail: string, now: Date): Extract<OtsChainCheck, { kind: "UNAVAILABLE" }> {
  return { kind: "UNAVAILABLE", code, detail: detail.slice(0, 200), checkedAtUtc: now };
}

function rpcFailure(err: unknown, now: Date): Extract<OtsChainCheck, { kind: "UNAVAILABLE" }> {
  if (err instanceof BtcRpcError) return unavailable(err.code, err.message, now);
  // The password became unavailable after configuration (a rotated or removed
  // secret / mount): a configuration fault, not a node outage.
  if (err instanceof Error && err.message.startsWith("BTC_RPC_MISCONFIGURED")) {
    return unavailable("BTC_RPC_MISCONFIGURED", "the Bitcoin RPC password is not available", now);
  }
  return unavailable("BTC_RPC_UNAVAILABLE", "verifier error", now);
}

/** Readiness only (the periodic probe and the reconciliation gate). */
export async function probeOtsBitcoinVerifierReadiness(deps: OtsBitcoinVerifierDeps = {}): Promise<OtsBitcoinVerifierReadiness> {
  const config = deps.config ?? resolveOtsBitcoinVerifierConfig();
  const now = (deps.now ?? (() => new Date()))();
  if (config.kind === "disabled") {
    // Disabled reports nothing about a node: no chain, tip or endpoint left
    // over from an earlier enabled probe.
    const r: OtsBitcoinVerifierReadiness = {
      enabled: false, ready: null, code: null, detail: null, observedAtUtc: now.toISOString(),
      chain: null, tipHeight: null, nodeVersion: null, endpoint: null,
    };
    remember(r);
    return r;
  }
  if (config.kind === "misconfigured") {
    const r: OtsBitcoinVerifierReadiness = {
      enabled: true, ready: false, code: "BTC_RPC_MISCONFIGURED", detail: config.reason, observedAtUtc: now.toISOString(),
      chain: null, tipHeight: null, nodeVersion: null, endpoint: null,
    };
    remember(r);
    return r;
  }
  const client = deps.client ?? clientFor(config);
  const base = { enabled: true, observedAtUtc: now.toISOString(), endpoint: config.rpcEndpointLabel };
  try {
    const network = await client.getNetworkInfo();
    const chain = await client.getBlockchainInfo();
    const genesisHash = await client.getBlockHash(0);
    const genesisRaw = genesisHash ? await client.getBlockHeaderRaw(genesisHash) : "";
    const ready = evaluateOtsChainReadiness(
      { network, chain, genesis: { hash: genesisHash ?? "", rawHeaderHex: genesisRaw } },
      config.policy,
      Math.floor(now.getTime() / 1000),
    );
    const r: OtsBitcoinVerifierReadiness = ready.ready
      ? { ...base, ready: true, code: null, detail: null, chain: ready.chain, tipHeight: ready.tipHeight, nodeVersion: ready.nodeVersion }
      : { ...base, ready: false, code: ready.code, detail: ready.detail, chain: chain.chain.slice(0, 16), tipHeight: chain.blocks, nodeVersion: network.version };
    remember(r);
    return r;
  } catch (err) {
    const f = rpcFailure(err, now);
    const r: OtsBitcoinVerifierReadiness = { ...base, ready: false, code: f.code, detail: f.detail, chain: null, tipHeight: null, nodeVersion: null };
    remember(r);
    return r;
  }
}

/**
 * Check ONE resolved ANCHORED proof against the active Bitcoin main chain.
 * Pure decisions; this function only fetches. Never throws.
 */
export async function checkOtsProofAgainstBitcoin(
  anchoring: Pick<OtsAnchoring, "state" | "bitcoinAttestations" | "proofSha256">,
  deps: OtsBitcoinVerifierDeps = {},
): Promise<OtsChainCheck> {
  const config = deps.config ?? resolveOtsBitcoinVerifierConfig();
  const clock = deps.now ?? (() => new Date());
  if (config.kind === "disabled") return { kind: "DISABLED" };
  const now = clock();
  if (config.kind === "misconfigured") return unavailable("BTC_RPC_MISCONFIGURED", config.reason, now);
  if (anchoring.state !== "ANCHORED" || !anchoring.proofSha256) {
    return unavailable("NO_BITCOIN_ATTESTATION", "the stored proof carries no Bitcoin attestation", now);
  }
  const client = deps.client ?? clientFor(config);
  const readiness = await probeOtsBitcoinVerifierReadiness({ config, client, now: () => now });
  if (!readiness.ready) return unavailable((readiness.code as OtsChainFailureCode) ?? "BTC_RPC_UNAVAILABLE", readiness.detail ?? "not ready", now);

  const tipHeight = readiness.tipHeight ?? 0;
  const outcomes: OtsChainCandidateOutcome[] = [];
  let beyondTipWithinGrace = false;
  try {
    for (const c of orderOtsChainCandidates(anchoring.bitcoinAttestations.map((a) => ({ blockHeight: a.blockHeight, merkleRootInternalHex: a.merkleRootHex })))) {
      if (c.blockHeight > tipHeight) {
        if (c.blockHeight - tipHeight <= OTS_BLOCK_BEYOND_TIP_GRACE) {
          beyondTipWithinGrace = true;
          continue;
        }
        outcomes.push(verifyOtsChainCandidate(c, { found: false }, config.policy));
        continue;
      }
      const blockHash = await client.getBlockHash(c.blockHeight);
      if (!blockHash) {
        outcomes.push(verifyOtsChainCandidate(c, { found: false }, config.policy));
        continue;
      }
      const rawHeaderHex = await client.getBlockHeaderRaw(blockHash);
      const verbose = await client.getBlockHeaderVerbose(blockHash);
      const outcome = verifyOtsChainCandidate(c, { found: true, blockHash, rawHeaderHex, verbose }, config.policy);
      outcomes.push(outcome);
      if (outcome.status === "VERIFIED") break;
    }
  } catch (err) {
    return rpcFailure(err, now);
  }
  const decision = decideOtsChainVerification(outcomes);
  if (decision.status !== "VERIFIED" && decision.status !== "INSUFFICIENT_CONFIRMATIONS" && beyondTipWithinGrace) {
    return unavailable("BLOCK_BEYOND_TIP", "the named block is not yet in the node's active chain", now);
  }
  return {
    kind: "DECIDED",
    decision,
    verifier: formatOtsChainVerifier({
      nodeVersion: readiness.nodeVersion,
      minConfirmations: config.policy.minConfirmations,
      proofSha256: anchoring.proofSha256,
    }),
    checkedAtUtc: now,
    tip: { chain: readiness.chain ?? config.policy.expectedChain, height: tipHeight, nodeVersion: readiness.nodeVersion ?? 0 },
  };
}
