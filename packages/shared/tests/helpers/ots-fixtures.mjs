/**
 * OpenTimestamps proof fixtures for tests (2026-10-13).
 *
 * The base is the REAL proof `opentimestamps-client 0.7.2` produced with
 * `ots stamp` (tests/fixtures/ots-proofs.json): magic, version, the SHA-256
 * file-hash op, the digest, and its calendar branches ending in pending
 * attestations. An upgraded proof is that proof with one more branch — the
 * path `ots upgrade` adds — serialized in the same binary format:
 *
 *   append nonce · sha256                         (the calendar's leaf)
 *   prepend tx-prefix · append tx-suffix          (the serialized transaction,
 *                                                  the leaf in an OP_RETURN)
 *   sha256 · sha256                               (the txid, internal order)
 *   (append|prepend sibling · sha256 · sha256)*   (the block's merkle path)
 *   0x00 · BITCOIN tag · varbytes(varuint height) (the block-header attestation)
 *
 * Expected values (txid, merkle root) are computed here independently with
 * node:crypto, so a test compares the parser against a second implementation.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REAL = JSON.parse(readFileSync(path.join(here, "..", "fixtures", "ots-proofs.json"), "utf8"));

const BITCOIN_TAG = Buffer.from("0588960d73d71901", "hex");
const HEADER_LENGTH = 31 + 1 + 1 + 32; // magic, version, file-hash op, digest

const sha = (b) => createHash("sha256").update(b).digest();
const varuint = (n) => {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
};
const varbytes = (b) => Buffer.concat([varuint(b.length), b]);
const op = (tag, arg) => (arg ? Buffer.concat([Buffer.from([tag]), varbytes(arg)]) : Buffer.from([tag]));

/** A one-input, one-output transaction carrying `leaf` in an OP_RETURN output. */
export function txAround(leaf) {
  const prefix = Buffer.concat([
    Buffer.from("01000000", "hex"), // version
    Buffer.from([1]), // one input
    Buffer.alloc(32, 0x11), // previous txid
    Buffer.from("00000000", "hex"), // previous index
    Buffer.from([0]), // empty scriptSig
    Buffer.from("ffffffff", "hex"), // sequence
    Buffer.from([1]), // one output
    Buffer.alloc(8, 0), // value
    Buffer.from([34, 0x6a, 0x20]), // script: OP_RETURN PUSH32
  ]);
  const suffix = Buffer.from("00000000", "hex"); // locktime
  return { prefix, suffix, tx: Buffer.concat([prefix, leaf, suffix]) };
}

/**
 * The real stamped proof plus a Bitcoin branch.
 * @param {object} o
 * @param {string} [o.base64]  the real proof to upgrade (default: the bound fixture)
 * @param {number} [o.blockHeight]
 * @param {boolean} [o.withTransaction] include the transaction step (txid derivable)
 * @param {number} [o.merkleLevels]
 * @param {Buffer} [o.trailingPayload] extra attestation payload bytes (an invalid encoding)
 * @param {number|null} [o.unexecutedOp] a non-executed op (e.g. 0x02 sha1) placed before the attestation
 * @param {boolean} [o.keepCalendars] keep the original pending branches (default true)
 */
export function upgradedProof(o = {}) {
  const real = Buffer.from(o.base64 ?? REAL.boundProofBase64, "base64");
  const header = real.subarray(0, HEADER_LENGTH);
  const digest = real.subarray(HEADER_LENGTH - 32, HEADER_LENGTH);
  const oldTree = real.subarray(HEADER_LENGTH);
  const blockHeight = o.blockHeight ?? 842_105;
  const merkleLevels = o.merkleLevels ?? 3;
  const withTransaction = o.withTransaction ?? true;

  const nonce = Buffer.alloc(16, 0x5a);
  let msg = sha(Buffer.concat([digest, nonce]));
  const parts = [op(0xf0, nonce), op(0x08)];

  let txid = null;
  if (withTransaction) {
    const { prefix, suffix, tx } = txAround(msg);
    parts.push(op(0xf1, prefix), op(0xf0, suffix), op(0x08), op(0x08));
    msg = sha(sha(tx));
    txid = Buffer.from(msg).reverse().toString("hex");
  }
  for (let level = 0; level < merkleLevels; level++) {
    const sibling = sha(Buffer.from(`sibling-${level}`));
    const left = level % 2 === 0;
    parts.push(op(left ? 0xf0 : 0xf1, sibling), op(0x08), op(0x08));
    msg = sha(sha(left ? Buffer.concat([msg, sibling]) : Buffer.concat([sibling, msg])));
  }
  if (o.unexecutedOp != null) parts.push(op(o.unexecutedOp));
  const payload = Buffer.concat([varuint(blockHeight), o.trailingPayload ?? Buffer.alloc(0)]);
  parts.push(Buffer.from([0x00]), BITCOIN_TAG, varbytes(payload));
  const bitcoinBranch = Buffer.concat(parts);

  const tree = o.keepCalendars === false ? bitcoinBranch : Buffer.concat([Buffer.from([0xff]), bitcoinBranch, oldTree]);
  const bytes = Buffer.concat([header, tree]);
  return {
    base64: bytes.toString("base64"),
    bytes,
    digestHex: digest.toString("hex"),
    blockHeight,
    txid,
    merkleRootHex: o.unexecutedOp != null ? null : msg.toString("hex"),
    proofSha256: sha(bytes).toString("hex"),
  };
}

/** SHA-256 hex of base64 proof bytes, computed independently of the parser. */
export function proofSha256(base64) {
  return sha(Buffer.from(base64, "base64")).toString("hex");
}

/** The real proof with its last `n` bytes cut off. */
export function truncated(base64 = REAL.boundProofBase64, n = 7) {
  const b = Buffer.from(base64, "base64");
  return b.subarray(0, b.length - n).toString("base64");
}

/** The real proof with its magic header damaged. */
export function badMagic(base64 = REAL.boundProofBase64) {
  const b = Buffer.from(base64, "base64");
  b[1] ^= 0xff;
  return b.toString("base64");
}

/** A proof whose tree nests deeper than the parser's bound (complexity limit). */
export function tooDeep(depth = 600) {
  const real = Buffer.from(REAL.boundProofBase64, "base64");
  const header = real.subarray(0, HEADER_LENGTH);
  const ops = Buffer.alloc(depth, 0x08);
  return Buffer.concat([header, ops, Buffer.from([0x00]), BITCOIN_TAG, varbytes(varuint(1))]).toString("base64");
}

/** A proof larger than the parser's size bound. */
export function tooLarge() {
  const real = Buffer.from(REAL.boundProofBase64, "base64");
  return Buffer.concat([real, Buffer.alloc(300 * 1024, 0)]).toString("base64");
}
