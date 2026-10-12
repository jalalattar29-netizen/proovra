/**
 * A REAL-SHAPED PENDING OPENTIMESTAMPS PROOF for the stamped content
 * (2026-10-12). Since every OTS boundary reads the digest a proof commits to
 * from its bytes, a doubled `ots stamp` must return bytes the product parser
 * reads: the OpenTimestamps header, a SHA-256 file-hash op over the content's
 * digest, and one pending calendar attestation — the exact serialization a
 * calendar returns before Bitcoin confirmation. Random bytes are, correctly,
 * refused as unreadable.
 */
import { createHash } from "node:crypto";

const MAGIC = Buffer.from([
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00, 0x00, 0x50, 0x72,
  0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
]);
const PENDING_TAG = Buffer.from("83dfe30d2ef90c8e", "hex");
const BITCOIN_TAG = Buffer.from("0588960d73d71901", "hex");

function varuint(n: number): Buffer {
  const out: number[] = [];
  for (;;) {
    const b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n === 0) {
      out.push(b);
      return Buffer.from(out);
    }
    out.push(b | 0x80);
  }
}
const varbytes = (b: Buffer) => Buffer.concat([varuint(b.length), b]);

export function sha256Hex(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** A pending proof committing to sha256(content), and that digest. */
export function pendingOtsProofFor(
  content: Buffer | string,
  calendar = "https://alice.btc.calendar.opentimestamps.org",
): { proofBase64: string; digestHex: string } {
  const digestHex = sha256Hex(content);
  const attestation = Buffer.concat([Buffer.from([0x00]), PENDING_TAG, varbytes(varbytes(Buffer.from(calendar, "ascii")))]);
  const bytes = Buffer.concat([MAGIC, varuint(1), Buffer.from([0x08]), Buffer.from(digestHex, "hex"), attestation]);
  return { proofBase64: bytes.toString("base64"), digestHex };
}

/**
 * A proof committing to a given SHA-256 digest: pending at its calendar, and —
 * with `bitcoinHeight` — also carrying a Bitcoin block-header attestation (the
 * serialization `ots upgrade` produces once the calendar commits to a block).
 */
export function otsProofForDigest(
  digestHex: string,
  opts: { bitcoinHeight?: number; calendar?: string } = {},
): string {
  const calendar = opts.calendar ?? "https://alice.btc.calendar.opentimestamps.org";
  const pending = Buffer.concat([Buffer.from([0x00]), PENDING_TAG, varbytes(varbytes(Buffer.from(calendar, "ascii")))]);
  const tree =
    opts.bitcoinHeight === undefined
      ? pending
      : Buffer.concat([Buffer.from([0xff, 0x00]), BITCOIN_TAG, varbytes(varuint(opts.bitcoinHeight)), pending]);
  return Buffer.concat([MAGIC, varuint(1), Buffer.from([0x08]), Buffer.from(digestHex, "hex"), tree]).toString("base64");
}

/** A complete recorded independent chain check (VERIFIED), as the worker writes it. */
export function verifiedChainColumns(blockHeight: number) {
  return {
    otsChainVerificationStatus: "VERIFIED",
    otsChainCheckedAtUtc: new Date("2026-09-21T10:00:00.000Z"),
    otsChainVerifiedAtUtc: new Date("2026-09-21T10:00:00.000Z"),
    otsChainBlockHeight: blockHeight,
    otsChainBlockHash: "00000000000000000001ec3f183cf87a623516376df048fed10a1696ed0f328f",
    otsChainBlockTimeUtc: new Date("2026-09-20T10:00:00.000Z"),
    otsChainConfirmations: 12,
    otsChainVerifier: "test-double/1",
  } as const;
}
