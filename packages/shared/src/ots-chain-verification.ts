/**
 * OPENTIMESTAMPS — INDEPENDENT BITCOIN-CHAIN VERIFICATION (pure authority).
 *
 * A stored OpenTimestamps proof that executes from the record's digest to a
 * Bitcoin block-height attestation only NAMES a block (ots-proof.ts). Whether
 * the commitment it produces is that block's merkle root in the Bitcoin main
 * chain is a separate fact, established here from Bitcoin Core RPC results
 * the worker fetched — and only here. No network call, no database, no UI.
 *
 * The comparison is the reference client's (opentimestamps 0.4.5,
 * BitcoinBlockHeaderAttestation.verify_against_blockheader): the replayed
 * message must equal the header's hashMerkleRoot byte for byte, in Bitcoin
 * INTERNAL byte order — raw header bytes 36..68. The verbose RPC `merkleroot`
 * is display order (reversed) and is used only as a consistency check.
 *
 * Persisted vocabulary (evidence.ots_chain_verification_status, migration
 * 20281012000000_evidence_ots_truth_columns, CHECK constrained):
 *
 *   NOT_CONFIGURED              live checking is off; nothing was checked
 *   UNAVAILABLE                 the verifier could not check (node down,
 *                               unauthorized, not ready, stale, wrong chain…)
 *   INSUFFICIENT_CONFIRMATIONS  the proof matches an active-chain block that
 *                               is not yet deep enough for the policy
 *   FAILED                      the proof does not match the referenced
 *                               active-chain block (root mismatch, invalid
 *                               header, not in the active chain, reorged)
 *   VERIFIED                    the proof matches a sufficiently confirmed
 *                               block of the node's active main chain
 *
 * Only VERIFIED may ever be presented as a verified, passed or green signal.
 */
import { sha256OfBytes } from "./canonical-digest.js";

export const OTS_CHAIN_STATUSES = [
  "NOT_CONFIGURED",
  "UNAVAILABLE",
  "INSUFFICIENT_CONFIRMATIONS",
  "FAILED",
  "VERIFIED",
] as const;
export type OtsChainStatus = (typeof OTS_CHAIN_STATUSES)[number];

/** Bounded failure / unavailability codes (ots_chain_failure_code, VARCHAR(64)). */
export const OTS_CHAIN_FAILURE_CODES = [
  // the verifier could not check — retryable, never a proof failure
  "BTC_RPC_TIMEOUT",
  "BTC_RPC_UNAUTHORIZED",
  "BTC_RPC_FORBIDDEN",
  "BTC_RPC_UNAVAILABLE",
  "BTC_RPC_ERROR",
  "BTC_RPC_MALFORMED_RESPONSE",
  "BTC_RPC_MISCONFIGURED",
  "BLOCK_BEYOND_TIP",
  "WRONG_CHAIN",
  "INITIAL_BLOCK_DOWNLOAD",
  "NODE_STALE",
  "HEADER_LAG",
  "NODE_WARNINGS",
  "UNSUPPORTED_NODE_VERSION",
  "GENESIS_MISMATCH",
  // the chain contradicts the proof — a verification failure
  "INVALID_HEADER",
  "ROOT_MISMATCH",
  "NOT_IN_ACTIVE_CHAIN",
  "REORGED",
  // depth
  "INSUFFICIENT_CONFIRMATIONS",
  // the proof's own attestations cannot be checked
  "INVALID_ATTESTATION",
  "NO_BITCOIN_ATTESTATION",
] as const;
export type OtsChainFailureCode = (typeof OTS_CHAIN_FAILURE_CODES)[number];

/** Codes that mean "could not check": retryable, never FAILED. */
export const OTS_CHAIN_UNAVAILABLE_CODES: ReadonlySet<OtsChainFailureCode> = new Set([
  "BTC_RPC_TIMEOUT",
  "BTC_RPC_UNAUTHORIZED",
  "BTC_RPC_FORBIDDEN",
  "BTC_RPC_UNAVAILABLE",
  "BTC_RPC_ERROR",
  "BTC_RPC_MALFORMED_RESPONSE",
  "BTC_RPC_MISCONFIGURED",
  "BLOCK_BEYOND_TIP",
  "WRONG_CHAIN",
  "INITIAL_BLOCK_DOWNLOAD",
  "NODE_STALE",
  "HEADER_LAG",
  "NODE_WARNINGS",
  "UNSUPPORTED_NODE_VERSION",
  "GENESIS_MISMATCH",
]);

/** Codes that are a verification FAILURE of the proof's chain claim. */
export const OTS_CHAIN_FAILED_CODES: ReadonlySet<OtsChainFailureCode> = new Set([
  "INVALID_HEADER",
  "ROOT_MISMATCH",
  "NOT_IN_ACTIVE_CHAIN",
  "REORGED",
  "INVALID_ATTESTATION",
  "NO_BITCOIN_ATTESTATION",
]);

export function parseOtsChainStatus(value: unknown): OtsChainStatus | null {
  const v = typeof value === "string" ? value.trim().toUpperCase() : "";
  return (OTS_CHAIN_STATUSES as readonly string[]).includes(v) ? (v as OtsChainStatus) : null;
}

export function parseOtsChainFailureCode(value: unknown): OtsChainFailureCode | null {
  const v = typeof value === "string" ? value.trim().toUpperCase() : "";
  return (OTS_CHAIN_FAILURE_CODES as readonly string[]).includes(v) ? (v as OtsChainFailureCode) : null;
}

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

const HEX = /^[0-9a-f]*$/;

function hexToBytes(hex: string): Uint8Array | null {
  const h = hex.trim().toLowerCase();
  if (h.length % 2 !== 0 || !HEX.test(h)) return null;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Reverse a hex byte string (Bitcoin internal ↔ display order). */
export function reverseHexBytes(hex: string): string {
  const b = hexToBytes(hex);
  return b ? toHex(b.slice().reverse()) : "";
}

/** Double SHA-256 of a raw header, in DISPLAY order (the RPC block hash). */
export function bitcoinHeaderHashDisplayHex(rawHeader: Uint8Array): string {
  return toHex(sha256OfBytes(sha256OfBytes(rawHeader)).slice().reverse());
}

/** Bitcoin main-network genesis block (height 0). */
export const BITCOIN_MAINNET_GENESIS_HASH = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";
export const BITCOIN_MAINNET_GENESIS_HEADER_HEX =
  "0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c";

export type ParsedBitcoinHeader = {
  /** Display-order block hash recomputed from the raw bytes. */
  hashHex: string;
  /** Internal-order merkle root: raw bytes 36..68. */
  merkleRootInternalHex: string;
  /** Header nTime (seconds, little-endian at 68..72). */
  timeSeconds: number;
};

/** Parse exactly 80 raw header bytes. null when the bytes are not a header. */
export function parseBitcoinHeader(rawHeaderHex: string): ParsedBitcoinHeader | null {
  const raw = hexToBytes(rawHeaderHex);
  if (!raw || raw.length !== 80) return null;
  const time = raw[68]! | (raw[69]! << 8) | (raw[70]! << 16) | (raw[71]! * 2 ** 24);
  return {
    hashHex: bitcoinHeaderHashDisplayHex(raw),
    merkleRootInternalHex: toHex(raw.slice(36, 68)),
    timeSeconds: time >>> 0,
  };
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export type OtsChainPolicy = {
  expectedChain: string;
  minConfirmations: number;
  maxTipAgeSeconds: number;
  maxHeaderLag: number;
  minNodeVersion: number;
  /** verificationprogress must be at least this. */
  minVerificationProgress: number;
};

export const OTS_CHAIN_POLICY_DEFAULTS: OtsChainPolicy = {
  expectedChain: "main",
  minConfirmations: 6,
  maxTipAgeSeconds: 7200,
  maxHeaderLag: 2,
  minNodeVersion: 270000,
  minVerificationProgress: 0.9999,
};

// ---------------------------------------------------------------------------
// Readiness — evaluated per verification, never cached as a boolean
// ---------------------------------------------------------------------------

export type BitcoinNetworkInfoFacts = { version: number; subversion: string };
export type BitcoinChainInfoFacts = {
  chain: string;
  blocks: number;
  headers: number;
  initialblockdownload: boolean;
  verificationprogress: number;
  /** Block time of the active tip (seconds). */
  time: number;
  bestblockhash: string;
  warnings: string | string[];
};
export type BitcoinGenesisProbe = { hash: string; rawHeaderHex: string };

export type OtsChainReadiness =
  | { ready: true; chain: string; tipHeight: number; tipHash: string; nodeVersion: number; nodeSubversion: string }
  | { ready: false; code: OtsChainFailureCode; detail: string };

/** Bounded, credential-free description of a value (never echoes it). */
function boundedText(v: unknown, max = 80): string {
  const s = String(v ?? "").replace(/[^\x20-\x7e]/g, "?");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** How far the reported header tip may transiently sit BELOW the validated tip (one day of blocks). */
export const OTS_HEADER_TIP_TRANSIENT_TOLERANCE = 144;

export function evaluateOtsChainReadiness(
  facts: { network: BitcoinNetworkInfoFacts; chain: BitcoinChainInfoFacts; genesis: BitcoinGenesisProbe },
  policy: OtsChainPolicy,
  nowSeconds: number,
): OtsChainReadiness {
  const { network, chain, genesis } = facts;
  if (!(network.version >= policy.minNodeVersion)) {
    return { ready: false, code: "UNSUPPORTED_NODE_VERSION", detail: `node version ${network.version} < ${policy.minNodeVersion}` };
  }
  if (chain.chain !== policy.expectedChain) {
    return { ready: false, code: "WRONG_CHAIN", detail: `chain=${boundedText(chain.chain, 16)} expected=${policy.expectedChain}` };
  }
  if (chain.initialblockdownload !== false) {
    return { ready: false, code: "INITIAL_BLOCK_DOWNLOAD", detail: "node is in initial block download" };
  }
  if (!(chain.verificationprogress >= policy.minVerificationProgress)) {
    return { ready: false, code: "INITIAL_BLOCK_DOWNLOAD", detail: `verificationprogress ${chain.verificationprogress}` };
  }
  // headers − blocks. Positive: the node knows of blocks it has not validated
  // (behind the network). A SMALL negative is transient and harmless — right
  // after a reorg Core can report a header tip below its validated tip — and
  // is not "behind"; a large negative is an inconsistent node and refused.
  const lag = chain.headers - chain.blocks;
  if (!(lag >= -OTS_HEADER_TIP_TRANSIENT_TOLERANCE && lag <= policy.maxHeaderLag)) {
    return { ready: false, code: "HEADER_LAG", detail: `headers-blocks=${lag} max=${policy.maxHeaderLag}` };
  }
  const tipAge = nowSeconds - chain.time;
  if (!(tipAge <= policy.maxTipAgeSeconds)) {
    return { ready: false, code: "NODE_STALE", detail: `tip age ${tipAge}s max=${policy.maxTipAgeSeconds}s` };
  }
  const warnings = Array.isArray(chain.warnings) ? chain.warnings.filter((w) => String(w).trim()).join(" | ") : String(chain.warnings ?? "").trim();
  if (warnings) {
    return { ready: false, code: "NODE_WARNINGS", detail: `node warnings: ${boundedText(warnings)}` };
  }
  if (policy.expectedChain === "main") {
    const header = parseBitcoinHeader(genesis.rawHeaderHex);
    if (genesis.hash !== BITCOIN_MAINNET_GENESIS_HASH || !header || header.hashHex !== BITCOIN_MAINNET_GENESIS_HASH) {
      return { ready: false, code: "GENESIS_MISMATCH", detail: "genesis block does not match Bitcoin mainnet" };
    }
  } else {
    const header = parseBitcoinHeader(genesis.rawHeaderHex);
    if (!header || header.hashHex !== genesis.hash) {
      return { ready: false, code: "GENESIS_MISMATCH", detail: "genesis header does not hash to the reported genesis hash" };
    }
  }
  return {
    ready: true,
    chain: chain.chain,
    tipHeight: chain.blocks,
    tipHash: chain.bestblockhash,
    nodeVersion: network.version,
    nodeSubversion: boundedText(network.subversion, 40),
  };
}

// ---------------------------------------------------------------------------
// One candidate attestation against one active-chain header
// ---------------------------------------------------------------------------

export type OtsChainCandidate = {
  blockHeight: number;
  /** The replayed commitment, Bitcoin internal byte order (ots-proof merkleRootHex). */
  merkleRootInternalHex: string;
};

export type BitcoinHeaderLookup =
  /** getblockhash(height) failed with -8: height beyond the active tip. */
  | { found: false }
  | {
      found: true;
      /** getblockhash(height), display order. */
      blockHash: string;
      /** getblockheader(hash, false). */
      rawHeaderHex: string;
      /** getblockheader(hash, true). */
      verbose: { height: number; confirmations: number; merkleroot: string; hash?: string };
    };

export type OtsChainCandidateOutcome =
  | {
      status: "VERIFIED" | "INSUFFICIENT_CONFIRMATIONS";
      blockHeight: number;
      blockHash: string;
      blockTimeUtc: string;
      confirmations: number;
    }
  | { status: "FAILED"; code: "INVALID_HEADER" | "ROOT_MISMATCH" | "NOT_IN_ACTIVE_CHAIN"; blockHeight: number; detail: string };

/** The full per-candidate contract. Pure: the caller fetched `lookup`. */
export function verifyOtsChainCandidate(
  candidate: OtsChainCandidate,
  lookup: BitcoinHeaderLookup,
  policy: Pick<OtsChainPolicy, "minConfirmations">,
): OtsChainCandidateOutcome {
  const h = candidate.blockHeight;
  if (!lookup.found) return { status: "FAILED", code: "NOT_IN_ACTIVE_CHAIN", blockHeight: h, detail: `height ${h} is beyond the active tip` };
  const header = parseBitcoinHeader(lookup.rawHeaderHex);
  const hash = String(lookup.blockHash ?? "").trim().toLowerCase();
  if (!header || !/^[0-9a-f]{64}$/.test(hash) || header.hashHex !== hash) {
    return { status: "FAILED", code: "INVALID_HEADER", blockHeight: h, detail: "raw header does not hash to the returned block hash" };
  }
  if (lookup.verbose.hash !== undefined && String(lookup.verbose.hash).toLowerCase() !== hash) {
    return { status: "FAILED", code: "INVALID_HEADER", blockHeight: h, detail: "verbose header names another block" };
  }
  if (lookup.verbose.height !== h) {
    return { status: "FAILED", code: "INVALID_HEADER", blockHeight: h, detail: "header height differs from the attested height" };
  }
  if (!Number.isInteger(lookup.verbose.confirmations) || lookup.verbose.confirmations < 1) {
    return { status: "FAILED", code: "NOT_IN_ACTIVE_CHAIN", blockHeight: h, detail: `confirmations=${lookup.verbose.confirmations}` };
  }
  const root = candidate.merkleRootInternalHex.trim().toLowerCase();
  if (header.merkleRootInternalHex !== root) {
    return { status: "FAILED", code: "ROOT_MISMATCH", blockHeight: h, detail: "replayed commitment is not the block's merkle root" };
  }
  // Consistency only: the verbose display-order root must be the raw root reversed.
  if (reverseHexBytes(String(lookup.verbose.merkleroot ?? "")) !== header.merkleRootInternalHex) {
    return { status: "FAILED", code: "INVALID_HEADER", blockHeight: h, detail: "verbose merkleroot disagrees with the raw header" };
  }
  const blockTimeUtc = new Date(header.timeSeconds * 1000).toISOString();
  return {
    status: lookup.verbose.confirmations >= policy.minConfirmations ? "VERIFIED" : "INSUFFICIENT_CONFIRMATIONS",
    blockHeight: h,
    blockHash: hash,
    blockTimeUtc,
    confirmations: lookup.verbose.confirmations,
  };
}

// ---------------------------------------------------------------------------
// The decision over every candidate
// ---------------------------------------------------------------------------

export type OtsChainDecision =
  | {
      status: "VERIFIED" | "INSUFFICIENT_CONFIRMATIONS";
      failureCode: "INSUFFICIENT_CONFIRMATIONS" | null;
      blockHeight: number;
      blockHash: string;
      blockTimeUtc: string;
      confirmations: number;
      /** Bounded diagnostics for candidates that did not establish verification. */
      rejected: Array<{ blockHeight: number; code: string }>;
    }
  | {
      status: "FAILED" | "UNAVAILABLE";
      failureCode: OtsChainFailureCode;
      blockHeight: number | null;
      blockHash: null;
      blockTimeUtc: null;
      confirmations: null;
      rejected: Array<{ blockHeight: number; code: string }>;
    };

/** Deterministic candidate order: ascending height, then root. */
export function orderOtsChainCandidates(candidates: ReadonlyArray<OtsChainCandidate>): OtsChainCandidate[] {
  const seen = new Set<string>();
  return [...candidates]
    .filter((c) => {
      const k = `${c.blockHeight}:${c.merkleRootInternalHex}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.blockHeight - b.blockHeight || a.merkleRootInternalHex.localeCompare(b.merkleRootInternalHex));
}

/**
 * The record's chain verification from per-candidate outcomes (in candidate
 * order). The FIRST candidate that passes the full active-chain contract
 * establishes VERIFIED; otherwise the most advanced non-verified outcome is
 * stated: insufficient confirmations, then a chain contradiction.
 */
export function decideOtsChainVerification(outcomes: ReadonlyArray<OtsChainCandidateOutcome>): OtsChainDecision {
  const rejected: Array<{ blockHeight: number; code: string }> = [];
  type BlockOutcome = { blockHeight: number; blockHash: string; blockTimeUtc: string; confirmations: number };
  let pending: BlockOutcome | null = null;
  let firstFailure: { blockHeight: number; code: "INVALID_HEADER" | "ROOT_MISMATCH" | "NOT_IN_ACTIVE_CHAIN" } | null = null;
  for (const o of outcomes) {
    if (o.status === "FAILED") {
      rejected.push({ blockHeight: o.blockHeight, code: o.code });
      firstFailure ??= { blockHeight: o.blockHeight, code: o.code };
      continue;
    }
    if (o.status === "VERIFIED") {
      return { status: "VERIFIED", failureCode: null, blockHeight: o.blockHeight, blockHash: o.blockHash, blockTimeUtc: o.blockTimeUtc, confirmations: o.confirmations, rejected: rejected.slice(0, 16) };
    }
    rejected.push({ blockHeight: o.blockHeight, code: "INSUFFICIENT_CONFIRMATIONS" });
    pending ??= { blockHeight: o.blockHeight, blockHash: o.blockHash, blockTimeUtc: o.blockTimeUtc, confirmations: o.confirmations };
  }
  if (pending) {
    return { status: "INSUFFICIENT_CONFIRMATIONS", failureCode: "INSUFFICIENT_CONFIRMATIONS", blockHeight: pending.blockHeight, blockHash: pending.blockHash, blockTimeUtc: pending.blockTimeUtc, confirmations: pending.confirmations, rejected: rejected.slice(0, 16) };
  }
  if (firstFailure) {
    return { status: "FAILED", failureCode: firstFailure.code, blockHeight: firstFailure.blockHeight, blockHash: null, blockTimeUtc: null, confirmations: null, rejected: rejected.slice(0, 16) };
  }
  return { status: "FAILED", failureCode: "NO_BITCOIN_ATTESTATION", blockHeight: null, blockHash: null, blockTimeUtc: null, confirmations: null, rejected };
}

/**
 * A later check that no longer confirms a block an earlier check VERIFIED is
 * a reorg, not a first-time "not in active chain" — and not a proof defect.
 *
 * The same proof bytes (the chain record is bound to the proof sha) once
 * matched the header at that height, so a different header there now — which
 * the candidate check sees as ROOT_MISMATCH, because the replacement block has
 * another merkle root — means the block was reorganized away. Reading it as
 * ROOT_MISMATCH would make it terminal, and a record could never recover when
 * the original chain is restored. A record already REORGED stays REORGED
 * (re-checked, never terminal) until the block is back or the check passes.
 */
export function reclassifyAfterPriorVerification(
  decision: OtsChainDecision,
  prior: { status: OtsChainStatus | null; blockHash: string | null; failureCode?: string | null },
): OtsChainDecision {
  const onceMatched = prior.status === "VERIFIED" || (prior.status === "FAILED" && prior.failureCode === "REORGED");
  if (
    onceMatched &&
    decision.status === "FAILED" &&
    (decision.failureCode === "NOT_IN_ACTIVE_CHAIN" || decision.failureCode === "INVALID_HEADER" || decision.failureCode === "ROOT_MISMATCH")
  ) {
    return { ...decision, failureCode: "REORGED" };
  }
  return decision;
}

// ---------------------------------------------------------------------------
// The persisted record and its binding to the stored proof
// ---------------------------------------------------------------------------

/**
 * Verifier identity (ots_chain_verifier, VARCHAR(120)):
 * "proovra-ots-chain/1;core=<node version>;min=<policy confirmations>;proof=<proof sha256 prefix 16>".
 * It binds the stored chain fact to the exact proof bytes it was established
 * for, and records the confirmation policy in force. No URL, user or secret.
 */
export const OTS_CHAIN_VERIFIER_NAME = "proovra-ots-chain/1";

export function formatOtsChainVerifier(params: { nodeVersion: number | null; minConfirmations: number; proofSha256: string }): string {
  const proof = params.proofSha256.trim().toLowerCase().slice(0, 16);
  const core = params.nodeVersion != null && Number.isSafeInteger(params.nodeVersion) ? String(params.nodeVersion) : "unknown";
  const min = Number.isSafeInteger(params.minConfirmations) ? params.minConfirmations : 0;
  return `${OTS_CHAIN_VERIFIER_NAME};core=${core};min=${min};proof=${proof}`;
}

export type ParsedOtsChainVerifier = { name: string; core: string | null; minConfirmations: number | null; proofPrefix: string | null };

export function parseOtsChainVerifier(value: unknown): ParsedOtsChainVerifier | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parts = value.trim().split(";");
  const out: ParsedOtsChainVerifier = { name: parts[0]!, core: null, minConfirmations: null, proofPrefix: null };
  for (const p of parts.slice(1)) {
    const [k, v] = p.split("=");
    if (k === "core" && v && /^[0-9a-z.]{1,16}$/.test(v)) out.core = v;
    if (k === "min" && v && /^[0-9]{1,3}$/.test(v)) out.minConfirmations = Number(v);
    if (k === "proof" && v && /^[0-9a-f]{16}$/.test(v)) out.proofPrefix = v;
  }
  return out.name === OTS_CHAIN_VERIFIER_NAME ? out : null;
}

/** The chain columns as stored (evidence.ots_chain_*). */
export type OtsChainRecord = {
  status: string | null | undefined;
  checkedAtUtc?: Date | string | null;
  verifiedAtUtc?: Date | string | null;
  blockHeight?: number | null;
  blockHash?: string | null;
  blockTimeUtc?: Date | string | null;
  confirmations?: number | null;
  verifier?: string | null;
  failureCode?: string | null;
};

/** The bounded, credential-free chain fact every surface reads. */
export type OtsChainFacts = {
  status: OtsChainStatus;
  failureCode: OtsChainFailureCode | null;
  checkedAtUtc: string | null;
  verifiedAtUtc: string | null;
  blockHeight: number | null;
  blockHash: string | null;
  blockTimeUtc: string | null;
  confirmations: number | null;
  /** The confirmation policy the verifier applied, when recorded. */
  minConfirmations: number | null;
  verifier: string | null;
};

const isoOf = (v: Date | string | null | undefined): string | null => {
  if (v == null || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};

/**
 * The stored chain fact, ONLY when it is about THIS proof: the verifier
 * identity names the proof's SHA-256 prefix and, for a block outcome, the
 * block height is one of the proof's own Bitcoin attestations. Anything else
 * (no record, a record about an earlier proof, an inconsistent VERIFIED) is
 * null — "not checked" — never promoted.
 */
export function bindOtsChainRecord(
  record: OtsChainRecord | null | undefined,
  proof: { proofSha256: string | null; attestedHeights: readonly number[] },
): OtsChainFacts | null {
  if (!record) return null;
  const status = parseOtsChainStatus(record.status);
  if (!status) return null;
  const verifier = typeof record.verifier === "string" && record.verifier.trim() ? record.verifier.trim().slice(0, 120) : null;
  const facts: OtsChainFacts = {
    status,
    failureCode: parseOtsChainFailureCode(record.failureCode),
    checkedAtUtc: isoOf(record.checkedAtUtc),
    verifiedAtUtc: isoOf(record.verifiedAtUtc),
    blockHeight: typeof record.blockHeight === "number" && Number.isSafeInteger(record.blockHeight) ? record.blockHeight : null,
    blockHash: typeof record.blockHash === "string" && /^[0-9a-f]{64}$/.test(record.blockHash) ? record.blockHash : null,
    blockTimeUtc: isoOf(record.blockTimeUtc),
    confirmations: typeof record.confirmations === "number" && Number.isSafeInteger(record.confirmations) ? record.confirmations : null,
    minConfirmations: null,
    verifier,
  };
  if (status === "NOT_CONFIGURED") return facts;
  const parsed = parseOtsChainVerifier(verifier);
  facts.minConfirmations = parsed?.minConfirmations ?? null;
  const proofPrefix = proof.proofSha256 ? proof.proofSha256.toLowerCase().slice(0, 16) : null;
  if (!parsed || !proofPrefix || parsed.proofPrefix !== proofPrefix) return null;
  if (status === "VERIFIED" || status === "INSUFFICIENT_CONFIRMATIONS") {
    const complete =
      facts.blockHeight != null &&
      facts.blockHash != null &&
      facts.blockTimeUtc != null &&
      facts.confirmations != null &&
      facts.confirmations > 0 &&
      facts.checkedAtUtc != null &&
      (status !== "VERIFIED" || facts.verifiedAtUtc != null);
    if (!complete || !proof.attestedHeights.includes(facts.blockHeight!)) return null;
  }
  if (status === "FAILED" && facts.blockHeight != null && !proof.attestedHeights.includes(facts.blockHeight)) return null;
  return facts;
}
