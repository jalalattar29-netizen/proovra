/**
 * THE OPENTIMESTAMPS PROOF, READ FROM ITS BYTES (2026-10-12).
 *
 * Every boundary that accepts, persists, renders, packages or publishes an
 * OpenTimestamps proof asks the same question first: WHICH DIGEST DOES THIS
 * PROOF COMMIT TO? The answer is in the proof itself — a detached timestamp
 * file opens with a fixed magic, a version, the hash operation applied to the
 * timestamped file and that file's digest — so it is read here, from the
 * bytes, by one parser shared by the worker, the API, the report, the package
 * and Public Verify. A stored flag, a txid, a status string or an `ots` CLI
 * line is never the authority for it.
 *
 * The timestamp tree after the header is walked to list the attestations the
 * proof carries (Bitcoin block heights, pending calendars). Operations are
 * skipped, not executed: this module states what the proof CLAIMS. Whether a
 * Bitcoin attestation is real is a separate, independent chain verification
 * (`OtsChainVerification`), never inferred from the structure read here.
 *
 * Format (python-opentimestamps, `DetachedTimestampFile`):
 *   magic(31) varuint(major=1) file-hash-op(1) digest(n) timestamp-tree
 *   tree      := (0xff branch)* branch
 *   branch    := 0x00 attestation | op [varbytes arg] tree
 *   attestation := tag(8) varbytes(payload)
 */

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
const UNARY_OPS = new Set([0x02, 0x03, 0x08, 0x67, 0xf2, 0xf3]);
const BINARY_OPS = new Set([0xf0, 0xf1]);

const BITCOIN_TAG = "0588960d73d71901";
const LITECOIN_TAG = "06869a0d73d71b45";
const ETHEREUM_TAG = "30fe8087b5c7ead7";
const PENDING_TAG = "83dfe30d2ef90c8e";

/** Bounds that keep a hostile proof from exhausting the reader. */
const MAX_PROOF_BYTES = 256 * 1024;
const MAX_DEPTH = 512;
const MAX_VARBYTES = 64 * 1024;

export type OtsDigestAlgorithm = "sha1" | "ripemd160" | "sha256" | "keccak256";

export type OtsProofAttestation =
  | { kind: "BITCOIN"; blockHeight: number }
  | { kind: "PENDING"; calendarUri: string }
  | { kind: "LITECOIN" | "ETHEREUM" | "UNKNOWN"; tag: string };

export type ParsedOtsProof = {
  majorVersion: number;
  fileDigestAlgorithm: OtsDigestAlgorithm;
  /** The digest this proof commits to, lower-case hex. */
  committedDigestHex: string;
  attestations: OtsProofAttestation[];
  /** Distinct Bitcoin block heights the proof's attestations REPORT (unverified). */
  bitcoinBlockHeights: number[];
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

function readAttestation(r: Reader): OtsProofAttestation {
  const tag = hex(r.take(8));
  const payload = new Reader(r.varbytes());
  if (tag === BITCOIN_TAG) return { kind: "BITCOIN", blockHeight: payload.varuint() };
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

function readTree(r: Reader, out: OtsProofAttestation[], depth: number): void {
  if (depth > MAX_DEPTH) throw new OtsProofParseError("timestamp tree too deep");
  let tag = r.byte();
  while (tag === 0xff) {
    readBranch(r, r.byte(), out, depth);
    tag = r.byte();
  }
  readBranch(r, tag, out, depth);
}

function readBranch(r: Reader, tag: number, out: OtsProofAttestation[], depth: number): void {
  if (tag === 0x00) {
    out.push(readAttestation(r));
    return;
  }
  if (BINARY_OPS.has(tag)) r.varbytes();
  else if (!UNARY_OPS.has(tag)) throw new OtsProofParseError(`unknown operation 0x${tag.toString(16)}`);
  readTree(r, out, depth + 1);
}

/** Parse a detached OpenTimestamps proof. Throws `OtsProofParseError` on any defect. */
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
  const committedDigestHex = hex(r.take(op.length));
  const attestations: OtsProofAttestation[] = [];
  readTree(r, attestations, 0);
  if (!r.done()) throw new OtsProofParseError("trailing bytes after the timestamp");
  const heights = [
    ...new Set(attestations.flatMap((a) => (a.kind === "BITCOIN" ? [a.blockHeight] : []))),
  ].sort((a, b) => a - b);
  const pending = [...new Set(attestations.flatMap((a) => (a.kind === "PENDING" ? [a.calendarUri] : [])))];
  return {
    majorVersion,
    fileDigestAlgorithm: op.algorithm,
    committedDigestHex,
    attestations,
    bitcoinBlockHeights: heights,
    pendingCalendars: pending,
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
 *   MISMATCH    the proof, or the record's OTS hash, names another digest.
 *               Nothing may call such a proof anchored, attested or verified,
 *               and no package may carry it.
 *   UNREADABLE  the bytes are not a readable OpenTimestamps proof.
 *   ABSENT      there is no proof to bind (lifecycle decides what that means).
 */
export type OtsDigestBinding =
  | {
      kind: "MATCH";
      committedDigestHex: string;
      bitcoinBlockHeights: number[];
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
  | { kind: "UNREADABLE"; code: "MALFORMED_PROOF"; detail: string }
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
    return { kind: "UNREADABLE", code: "MALFORMED_PROOF", detail: "the record has no SHA-256 fingerprint digest to bind" };
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
    bitcoinBlockHeights: parsed.bitcoinBlockHeights,
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
 * (2026-10-12) The stored proof, only when it commits to the record's
 * fingerprint digest. A proof bound to another digest, or unreadable, is never
 * presented as attached — Public Verify neither counts nor serves it.
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
