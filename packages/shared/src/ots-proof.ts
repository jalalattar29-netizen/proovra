/**
 * THE OPENTIMESTAMPS PROOF, READ AND EXECUTED FROM ITS BYTES (2026-10-13).
 *
 * Every boundary that accepts, persists, renders, packages or publishes an
 * OpenTimestamps proof asks the same questions of the proof itself, through
 * this one module (worker, API, report, package, Public Verify):
 *
 *   1. WHICH DIGEST DOES IT COMMIT TO? A detached timestamp opens with a fixed
 *      magic, a version, the file-hash operation and the file's digest.
 *   2. WHAT DOES IT ATTEST? The timestamp tree after the header is EXECUTED:
 *      starting from the committed digest, every operation (sha256, append,
 *      prepend, reverse, hexlify) is applied, so each attestation is bound to
 *      the exact message the proof path produces for it. A Bitcoin block-header
 *      attestation is valid only when that message is a 32-byte merkle root and
 *      its payload is exactly one block height. A path through an operation
 *      this module does not execute (sha1, ripemd160, keccak256) is parsed but
 *      never counted.
 *   3. WHICH BITCOIN TRANSACTION? Only when the executed path contains a
 *      message that parses strictly as a serialized Bitcoin transaction and is
 *      then hashed twice with SHA-256 (its transaction id), the way the
 *      reference client derives it.
 *
 * What it does NOT do: compare a merkle root with the Bitcoin chain. That needs
 * a Bitcoin node the reviewer trusts; the verification package explains how.
 *
 * Format (python-opentimestamps, `DetachedTimestampFile`):
 *   magic(31) varuint(major=1) file-hash-op(1) digest(n) timestamp-tree
 *   tree      := (0xff branch)* branch
 *   branch    := 0x00 attestation | op [varbytes arg] tree
 *   attestation := tag(8) varbytes(payload)
 */
import { sha256OfBytes } from "./canonical-digest.js";

const HEADER_MAGIC = [
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00, 0x00, 0x50, 0x72,
  0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
] as const;

/** Unary crypto ops that may open the file (tag → digest length). */
const FILE_HASH_OPS: Readonly<Record<number, { algorithm: OtsDigestAlgorithm; length: number }>> = {
  0x02: { algorithm: "sha1", length: 20 },
  0x03: { algorithm: "ripemd160", length: 20 },
  0x08: { algorithm: "sha256", length: 32 },
  0x67: { algorithm: "keccak256", length: 32 },
};
const OP_SHA256 = 0x08;
const OP_APPEND = 0xf0;
const OP_PREPEND = 0xf1;
const OP_REVERSE = 0xf2;
const OP_HEXLIFY = 0xf3;
/** Parsed, never executed: an attestation behind one of these is not counted. */
const NON_EXECUTED_OPS = new Set([0x02, 0x03, 0x67]);

const BITCOIN_TAG = "0588960d73d71901";
const LITECOIN_TAG = "06869a0d73d71b45";
const ETHEREUM_TAG = "30fe8087b5c7ead7";
const PENDING_TAG = "83dfe30d2ef90c8e";

/** Bounds that keep a hostile proof from exhausting the reader or the executor. */
const MAX_PROOF_BYTES = 256 * 1024;
const MAX_DEPTH = 512;
const MAX_VARBYTES = 64 * 1024;
/** python-opentimestamps' bound on any operation's result. */
const MAX_MESSAGE_BYTES = 4096;
const MAX_ATTESTATIONS = 1024;

/** The executor's identity, recorded with every validation result. */
export const OTS_PROOF_VALIDATOR = "proovra-ots-proof/2 (sha256, append, prepend, reverse, hexlify)";

export type OtsDigestAlgorithm = "sha1" | "ripemd160" | "sha256" | "keccak256";

export type OtsProofAttestation =
  | {
      kind: "BITCOIN";
      blockHeight: number;
      /** False when the path to it crosses an operation this module does not execute. */
      executed: boolean;
      /** Executed, a 32-byte message, and exactly one height in its payload. */
      valid: boolean;
      /** The merkle root the path produces (Bitcoin internal byte order), when executed. */
      merkleRootHex: string | null;
      /** The Bitcoin transaction id on the path, when the path contains one. */
      bitcoinTxid: string | null;
    }
  | { kind: "PENDING"; calendarUri: string }
  | { kind: "LITECOIN" | "ETHEREUM" | "UNKNOWN"; tag: string };

export type OtsBitcoinAttestation = {
  blockHeight: number;
  merkleRootHex: string;
  bitcoinTxid: string | null;
};

export type ParsedOtsProof = {
  majorVersion: number;
  fileDigestAlgorithm: OtsDigestAlgorithm;
  /** The digest this proof commits to, lower-case hex. */
  committedDigestHex: string;
  attestations: OtsProofAttestation[];
  /** The VALID Bitcoin attestations the executed proof path produces. */
  bitcoinAttestations: OtsBitcoinAttestation[];
  /** Distinct block heights of the valid Bitcoin attestations, ascending. */
  bitcoinBlockHeights: number[];
  /** Bitcoin attestations behind an operation this module does not execute. */
  unexecutedBitcoinAttestations: number;
  /** Executed Bitcoin attestations whose message or payload is malformed. */
  invalidBitcoinAttestations: number;
  pendingCalendars: string[];
};

export class OtsProofParseError extends Error {
  readonly code = "MALFORMED_PROOF" as const;
  constructor(detail: string) {
    super(`MALFORMED_PROOF: ${detail}`);
    this.name = "OtsProofParseError";
  }
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Strict base64 decode, portable to browsers and Node without Buffer. */
export function decodeOtsProofBase64(value: string): Uint8Array {
  const clean = value.replace(/\s+/g, "");
  if (clean.length === 0 || clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) {
    throw new OtsProofParseError("proof is not valid base64");
  }
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((clean.length / 4) * 3 - padding);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (B64.indexOf(clean[i]!) << 18) |
      (B64.indexOf(clean[i + 1]!) << 12) |
      ((clean[i + 2] === "=" ? 0 : B64.indexOf(clean[i + 2]!)) << 6) |
      (clean[i + 3] === "=" ? 0 : B64.indexOf(clean[i + 3]!));
    if (o < out.length) out[o++] = (n >> 16) & 0xff;
    if (o < out.length) out[o++] = (n >> 8) & 0xff;
    if (o < out.length) out[o++] = n & 0xff;
  }
  return out;
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** SHA-256 of the proof's bytes, lower-case hex — the proof's own identity. */
export function otsProofSha256Hex(proof: Uint8Array | string): string {
  return hex(sha256OfBytes(typeof proof === "string" ? decodeOtsProofBase64(proof) : proof));
}

class Reader {
  private pos = 0;
  constructor(private readonly bytes: Uint8Array) {}
  byte(): number {
    if (this.pos >= this.bytes.length) throw new OtsProofParseError("unexpected end of proof");
    return this.bytes[this.pos++]!;
  }
  take(n: number): Uint8Array {
    if (n < 0 || this.pos + n > this.bytes.length) throw new OtsProofParseError("unexpected end of proof");
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  varuint(): number {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      value += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 49) throw new OtsProofParseError("varuint too large");
    }
    return value;
  }
  varbytes(): Uint8Array {
    const n = this.varuint();
    if (n > MAX_VARBYTES) throw new OtsProofParseError("varbytes too large");
    return this.take(n);
  }
  done(): boolean {
    return this.pos === this.bytes.length;
  }
}

// ---------------------------------------------------------------------------
// Bitcoin transaction recognition (non-witness serialization), strict.
// ---------------------------------------------------------------------------

function readCompactSize(b: Uint8Array, p: { i: number }): number | null {
  if (p.i >= b.length) return null;
  const first = b[p.i++]!;
  if (first < 0xfd) return first;
  const width = first === 0xfd ? 2 : first === 0xfe ? 4 : 8;
  if (p.i + width > b.length) return null;
  let n = 0;
  for (let k = width - 1; k >= 0; k--) n = n * 256 + b[p.i + k]!;
  p.i += width;
  return n;
}

/** True when `b` is exactly one serialized Bitcoin transaction (no trailing bytes). */
export function isSerializedBitcoinTransaction(b: Uint8Array): boolean {
  if (b.length < 60) return false;
  const p = { i: 4 };
  const inputs = readCompactSize(b, p);
  if (inputs === null || inputs < 1 || inputs > 100) return false;
  for (let n = 0; n < inputs; n++) {
    p.i += 36;
    const script = readCompactSize(b, p);
    if (script === null || script > 10_000) return false;
    p.i += script + 4;
    if (p.i > b.length) return false;
  }
  const outputs = readCompactSize(b, p);
  if (outputs === null || outputs < 1 || outputs > 1000) return false;
  for (let n = 0; n < outputs; n++) {
    p.i += 8;
    const script = readCompactSize(b, p);
    if (script === null || script > 10_000) return false;
    p.i += script;
    if (p.i > b.length) return false;
  }
  return p.i + 4 === b.length;
}

// ---------------------------------------------------------------------------
// The executor.
// ---------------------------------------------------------------------------

type PathState = {
  /** The current message, or null once the path crossed a non-executed op. */
  msg: Uint8Array | null;
  /** The previous op hashed a serialized transaction once (awaiting the second hash). */
  txFirstHash: boolean;
  /** The transaction id found on this path, if any. */
  txid: string | null;
};

function bounded(msg: Uint8Array): Uint8Array {
  if (msg.length > MAX_MESSAGE_BYTES) throw new OtsProofParseError("operation result exceeds 4096 bytes");
  return msg;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function applyOp(tag: number, arg: Uint8Array | null, state: PathState): PathState {
  if (state.msg === null || NON_EXECUTED_OPS.has(tag)) return { msg: null, txFirstHash: false, txid: state.txid };
  const msg = state.msg;
  switch (tag) {
    case OP_SHA256: {
      const out = sha256OfBytes(msg);
      if (state.txFirstHash) {
        // The second SHA-256 of a serialized transaction: its id, displayed reversed.
        return { msg: out, txFirstHash: false, txid: hex(out.slice().reverse()) };
      }
      return { msg: out, txFirstHash: isSerializedBitcoinTransaction(msg), txid: state.txid };
    }
    case OP_APPEND:
      return { msg: bounded(concat(msg, arg!)), txFirstHash: false, txid: state.txid };
    case OP_PREPEND:
      return { msg: bounded(concat(arg!, msg)), txFirstHash: false, txid: state.txid };
    case OP_REVERSE:
      return { msg: msg.slice().reverse(), txFirstHash: false, txid: state.txid };
    case OP_HEXLIFY:
      return { msg: bounded(new TextEncoder().encode(hex(msg))), txFirstHash: false, txid: state.txid };
    default:
      throw new OtsProofParseError(`unknown operation 0x${tag.toString(16)}`);
  }
}

function readAttestation(r: Reader, state: PathState): OtsProofAttestation {
  const tag = hex(r.take(8));
  const payload = new Reader(r.varbytes());
  if (tag === BITCOIN_TAG) {
    const blockHeight = payload.varuint();
    const executed = state.msg !== null;
    const valid = executed && state.msg!.length === 32 && payload.done();
    return {
      kind: "BITCOIN",
      blockHeight,
      executed,
      valid,
      merkleRootHex: executed ? hex(state.msg!) : null,
      bitcoinTxid: valid ? state.txid : null,
    };
  }
  if (tag === PENDING_TAG) {
    const uri = payload.varbytes();
    let text = "";
    for (const b of uri) {
      if (b < 0x20 || b > 0x7e) throw new OtsProofParseError("pending attestation URI is not printable ASCII");
      text += String.fromCharCode(b);
    }
    return { kind: "PENDING", calendarUri: text };
  }
  if (tag === LITECOIN_TAG) return { kind: "LITECOIN", tag };
  if (tag === ETHEREUM_TAG) return { kind: "ETHEREUM", tag };
  return { kind: "UNKNOWN", tag };
}

function readTree(r: Reader, state: PathState, out: OtsProofAttestation[], depth: number): void {
  if (depth > MAX_DEPTH) throw new OtsProofParseError("timestamp tree too deep");
  let tag = r.byte();
  while (tag === 0xff) {
    readBranch(r, r.byte(), state, out, depth);
    tag = r.byte();
  }
  readBranch(r, tag, state, out, depth);
}

function readBranch(r: Reader, tag: number, state: PathState, out: OtsProofAttestation[], depth: number): void {
  if (tag === 0x00) {
    if (out.length >= MAX_ATTESTATIONS) throw new OtsProofParseError("too many attestations");
    out.push(readAttestation(r, state));
    return;
  }
  const binary = tag === OP_APPEND || tag === OP_PREPEND;
  if (!binary && tag !== OP_SHA256 && tag !== OP_REVERSE && tag !== OP_HEXLIFY && !NON_EXECUTED_OPS.has(tag)) {
    throw new OtsProofParseError(`unknown operation 0x${tag.toString(16)}`);
  }
  const arg = binary ? r.varbytes() : null;
  readTree(r, applyOp(tag, arg, state), out, depth + 1);
}

/** Parse AND execute a detached OpenTimestamps proof. Throws `OtsProofParseError` on any defect. */
export function parseOtsProof(proof: Uint8Array | string): ParsedOtsProof {
  const bytes = typeof proof === "string" ? decodeOtsProofBase64(proof) : proof;
  if (bytes.length > MAX_PROOF_BYTES) throw new OtsProofParseError("proof exceeds the size bound");
  const r = new Reader(bytes);
  const magic = r.take(HEADER_MAGIC.length);
  if (HEADER_MAGIC.some((b, i) => magic[i] !== b)) throw new OtsProofParseError("not an OpenTimestamps proof (header)");
  const majorVersion = r.varuint();
  if (majorVersion !== 1) throw new OtsProofParseError(`unsupported proof version ${majorVersion}`);
  const op = FILE_HASH_OPS[r.byte()];
  if (!op) throw new OtsProofParseError("unsupported file hash operation");
  const digest = r.take(op.length);
  const committedDigestHex = hex(digest);
  const attestations: OtsProofAttestation[] = [];
  readTree(r, { msg: op.algorithm === "sha256" ? digest.slice() : null, txFirstHash: false, txid: null }, attestations, 0);
  if (!r.done()) throw new OtsProofParseError("trailing bytes after the timestamp");
  const bitcoin = attestations.filter((a): a is Extract<OtsProofAttestation, { kind: "BITCOIN" }> => a.kind === "BITCOIN");
  const bitcoinAttestations = bitcoin
    .filter((a) => a.valid)
    .map((a) => ({ blockHeight: a.blockHeight, merkleRootHex: a.merkleRootHex!, bitcoinTxid: a.bitcoinTxid }));
  return {
    majorVersion,
    fileDigestAlgorithm: op.algorithm,
    committedDigestHex,
    attestations,
    bitcoinAttestations,
    bitcoinBlockHeights: [...new Set(bitcoinAttestations.map((a) => a.blockHeight))].sort((a, b) => a - b),
    unexecutedBitcoinAttestations: bitcoin.filter((a) => !a.executed).length,
    invalidBitcoinAttestations: bitcoin.filter((a) => a.executed && !a.valid).length,
    pendingCalendars: [...new Set(attestations.flatMap((a) => (a.kind === "PENDING" ? [a.calendarUri] : [])))],
  };
}

// ===========================================================================
// DIGEST BINDING — the release-blocking check at every OTS boundary
// ===========================================================================

/**
 * Does this proof commit to THIS record's fingerprint digest?
 *
 *   MATCH       the proof commits (SHA-256) to the fingerprint digest, and the
 *               record's stored OTS hash, when present, is that same digest.
 *               It carries the executed proof's attestations.
 *   MISMATCH    the proof, or the record's OTS hash, names another digest.
 *               Nothing may call such a proof anchored, and no package may
 *               carry it.
 *   UNREADABLE  the bytes are not a readable OpenTimestamps proof, or the
 *               record has no fingerprint digest to bind them to.
 *   ABSENT      there is no proof to bind (lifecycle decides what that means).
 */
export type OtsDigestBinding =
  | {
      kind: "MATCH";
      committedDigestHex: string;
      bitcoinAttestations: OtsBitcoinAttestation[];
      bitcoinBlockHeights: number[];
      unexecutedBitcoinAttestations: number;
      invalidBitcoinAttestations: number;
      pendingCalendars: string[];
    }
  | {
      kind: "MISMATCH";
      code: "PROOF_HASH_MISMATCH";
      committedDigestHex: string | null;
      expectedDigestHex: string;
      /** Which comparison failed. */
      reason: "PROOF_COMMITS_TO_OTHER_DIGEST" | "OTS_HASH_IS_NOT_FINGERPRINT" | "PROOF_DIGEST_NOT_SHA256";
    }
  | { kind: "UNREADABLE"; code: "MALFORMED_PROOF" | "NO_FINGERPRINT"; detail: string }
  | { kind: "ABSENT" };

const HEX64 = /^[0-9a-f]{64}$/;

export function checkOtsDigestBinding(input: {
  proofBase64: string | null | undefined;
  /** evidence.fingerprint_hash — the canonical digest every proof must commit to. */
  fingerprintHash: string | null | undefined;
  /** evidence.ots_hash — the digest the record says was stamped. */
  otsHash?: string | null;
}): OtsDigestBinding {
  const proof = typeof input.proofBase64 === "string" ? input.proofBase64.trim() : "";
  if (!proof) return { kind: "ABSENT" };
  const expected = String(input.fingerprintHash ?? "").trim().toLowerCase();
  if (!HEX64.test(expected)) {
    return { kind: "UNREADABLE", code: "NO_FINGERPRINT", detail: "the record has no SHA-256 fingerprint digest to bind" };
  }
  const otsHash = typeof input.otsHash === "string" ? input.otsHash.trim().toLowerCase() : "";
  let parsed: ParsedOtsProof;
  try {
    parsed = parseOtsProof(proof);
  } catch (error) {
    return {
      kind: "UNREADABLE",
      code: "MALFORMED_PROOF",
      detail: error instanceof Error ? error.message : "unreadable proof",
    };
  }
  if (parsed.fileDigestAlgorithm !== "sha256") {
    return {
      kind: "MISMATCH",
      code: "PROOF_HASH_MISMATCH",
      committedDigestHex: parsed.committedDigestHex,
      expectedDigestHex: expected,
      reason: "PROOF_DIGEST_NOT_SHA256",
    };
  }
  if (parsed.committedDigestHex !== expected) {
    return {
      kind: "MISMATCH",
      code: "PROOF_HASH_MISMATCH",
      committedDigestHex: parsed.committedDigestHex,
      expectedDigestHex: expected,
      reason: "PROOF_COMMITS_TO_OTHER_DIGEST",
    };
  }
  if (otsHash && otsHash !== expected) {
    return {
      kind: "MISMATCH",
      code: "PROOF_HASH_MISMATCH",
      committedDigestHex: parsed.committedDigestHex,
      expectedDigestHex: expected,
      reason: "OTS_HASH_IS_NOT_FINGERPRINT",
    };
  }
  return {
    kind: "MATCH",
    committedDigestHex: parsed.committedDigestHex,
    bitcoinAttestations: parsed.bitcoinAttestations,
    bitcoinBlockHeights: parsed.bitcoinBlockHeights,
    unexecutedBitcoinAttestations: parsed.unexecutedBitcoinAttestations,
    invalidBitcoinAttestations: parsed.invalidBitcoinAttestations,
    pendingCalendars: parsed.pendingCalendars,
  };
}

/** Thrown by a boundary that must refuse a proof bound to another digest. */
export class OtsDigestBindingError extends Error {
  readonly code: "OTS_PROOF_DIGEST_MISMATCH" | "OTS_PROOF_UNREADABLE";
  /** The same bytes fail the same way: a refusal, never a retry. */
  readonly retriable = false;
  constructor(binding: Exclude<OtsDigestBinding, { kind: "MATCH" } | { kind: "ABSENT" }>, boundary: string) {
    const code = binding.kind === "MISMATCH" ? "OTS_PROOF_DIGEST_MISMATCH" : "OTS_PROOF_UNREADABLE";
    super(
      binding.kind === "MISMATCH"
        ? `${code}: ${boundary} refused an OpenTimestamps proof (${binding.reason}); it does not commit to the record's fingerprint digest.`
        : `${code}: ${boundary} refused an OpenTimestamps proof that could not be read.`,
    );
    this.name = "OtsDigestBindingError";
    this.code = code;
  }
}

/**
 * The stored proof, only when it commits to the record's fingerprint digest.
 * A proof bound to another digest, or unreadable, is never presented as
 * attached — Public Verify neither counts nor serves it.
 */
export function boundOtsProofBase64(input: Parameters<typeof checkOtsDigestBinding>[0]): string | null {
  if (!input.proofBase64) return null;
  const kind = checkOtsDigestBinding(input).kind;
  return kind === "MISMATCH" || kind === "UNREADABLE" ? null : input.proofBase64;
}

/** Throws unless the proof is ABSENT or bound to the fingerprint digest. */
export function assertOtsDigestBinding(
  input: Parameters<typeof checkOtsDigestBinding>[0],
  boundary: string,
): Extract<OtsDigestBinding, { kind: "MATCH" } | { kind: "ABSENT" }> {
  const binding = checkOtsDigestBinding(input);
  if (binding.kind === "MISMATCH" || binding.kind === "UNREADABLE") throw new OtsDigestBindingError(binding, boundary);
  return binding;
}
