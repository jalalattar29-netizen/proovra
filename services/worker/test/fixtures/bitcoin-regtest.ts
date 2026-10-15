/**
 * A DISPOSABLE regtest Bitcoin Core node, and OpenTimestamps proofs committed
 * in its real blocks. Test-only.
 *
 * TEST_BITCOIN_REGTEST_RPC_URL = http://<user>:<throwaway password>@127.0.0.1:<port>
 * (harness-owned, like TEST_DATABASE_URL; loopback only). The userinfo is split
 * off here: the Product configuration rejects a URL that carries credentials.
 *
 * The HARNESS RPC below shapes the chain with regtest-only methods
 * (generatetodescriptor, generateblock, getblock, invalidateblock,
 * reconsiderblock). It is never the Product client — that is what the tests
 * exercise.
 *
 * Proofs are built the way an OpenTimestamps calendar builds them: the digest
 * (plus a nonce) is committed in an OP_RETURN output of a transaction mined
 * into a real block, and the proof's operations replay
 * digest → leaf → transaction → txid → merkle root of [coinbase, tx].
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type RegtestTarget = { url: string; user: string; password: string };

export function regtestTarget(): RegtestTarget | null {
  const raw = process.env.TEST_BITCOIN_REGTEST_RPC_URL ?? "";
  if (!raw) return null;
  const u = new URL(raw);
  if (u.protocol !== "http:" || !/^(127\.0\.0\.1|localhost)$/.test(u.hostname) || !u.username || !u.password) return null;
  return { url: `http://${u.hostname}:${u.port}`, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
}

/** OP_TRUE: coinbase outputs anyone can spend with an empty scriptSig (regtest only). */
const OP_TRUE_DESCRIPTOR = "raw(51)";

export function regtestHarness(target: RegtestTarget) {
  let rpcId = 0;
  let descriptor = "";
  async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const res = await fetch(target.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${target.user}:${target.password}`).toString("base64")}`,
      },
      body: JSON.stringify({ jsonrpc: "1.0", id: `harness-${++rpcId}`, method, params }),
    });
    const body = (await res.json()) as { result: T; error: { code: number; message: string } | null };
    if (body.error) throw new Error(`${method}: ${body.error.code} ${body.error.message}`);
    return body.result;
  }
  async function ensureDescriptor(): Promise<string> {
    if (!descriptor) descriptor = (await rpc<{ descriptor: string }>("getdescriptorinfo", [OP_TRUE_DESCRIPTOR])).descriptor;
    return descriptor;
  }
  async function mine(n: number): Promise<string[]> {
    return rpc<string[]>("generatetodescriptor", [n, await ensureDescriptor()]);
  }
  const tipHeight = (): Promise<number> => rpc<number>("getblockcount");

  /**
   * Mine a block that commits `digest`, and return the OpenTimestamps proof for
   * it. Matures a fresh OP_TRUE coinbase first (100-block maturity), so every
   * call spends a coinbase no earlier call spent.
   */
  async function stamp(digest: Buffer): Promise<StampedProof> {
    const start = await tipHeight();
    await mine(Math.max(1, 101 - start + 1));
    const fundingHeight = (await tipHeight()) - 100;
    const funding = await rpc<{ tx: string[] }>("getblock", [await rpc<string>("getblockhash", [fundingHeight]), 1]);
    const nonce = randomBytes(16);
    const leaf = sha(Buffer.concat([digest, nonce]));
    const tx = commitmentTx(funding.tx[0]!, leaf);
    const { hash } = await rpc<{ hash: string }>("generateblock", [await ensureDescriptor(), [tx.hex]]);
    const block = await rpc<{ height: number; tx: string[]; merkleroot: string }>("getblock", [hash, 1]);
    if (block.tx.length !== 2 || block.tx[1] !== Buffer.from(tx.txidInternal).reverse().toString("hex")) {
      throw new Error("regtest harness: the commitment transaction was not mined as expected");
    }
    const proof = buildProof({ digest, nonce, tx, coinbaseTxidDisplay: block.tx[0]!, blockHeight: block.height });
    if (Buffer.from(proof.merkleRootInternal).reverse().toString("hex") !== block.merkleroot) {
      throw new Error("regtest harness: the constructed proof does not commit to the block's merkle root");
    }
    return { ...proof, blockHeight: block.height, blockHash: hash, coinbaseTxidDisplay: block.tx[0]!, txidDisplay: block.tx[1]! };
  }

  return { rpc, mine, tipHeight, stamp };
}

export type StampedProof = BuiltProof & { blockHeight: number; blockHash: string; coinbaseTxidDisplay: string; txidDisplay: string };

// ---------------------------------------------------------------------------
// OpenTimestamps proof construction (the calendar's side of the protocol)
// ---------------------------------------------------------------------------
export const sha = (b: Buffer): Buffer => createHash("sha256").update(b).digest();
const sha2 = (b: Buffer): Buffer => sha(sha(b));
export const reverseHex = (hex: string): Buffer => Buffer.from(hex, "hex").reverse();
const varuint = (n: number): Buffer => {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
};
const varbytes = (b: Buffer): Buffer => Buffer.concat([varuint(b.length), b]);
const OP = { SHA256: 0x08, APPEND: 0xf0, PREPEND: 0xf1 } as const;
const op = (tag: number, arg?: Buffer): Buffer => (arg ? Buffer.concat([Buffer.from([tag]), varbytes(arg)]) : Buffer.from([tag]));
const OTS_MAGIC = Buffer.from("004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294", "hex");
const BITCOIN_ATTESTATION_TAG = Buffer.from("0588960d73d71901", "hex");

/** A legacy (non-witness) tx spending an OP_TRUE coinbase, committing `leaf` in OP_RETURN. */
function commitmentTx(prevTxidDisplay: string, leaf: Buffer): { prefix: Buffer; suffix: Buffer; hex: string; txidInternal: Buffer } {
  const prefix = Buffer.concat([
    Buffer.from("01000000", "hex"), // version 1
    Buffer.from([1]), // one input
    reverseHex(prevTxidDisplay), // previous txid (internal order)
    Buffer.from("00000000", "hex"), // vout 0
    Buffer.from([0]), // empty scriptSig (OP_TRUE needs none)
    Buffer.from("ffffffff", "hex"), // sequence
    Buffer.from([1]), // one output
    Buffer.alloc(8, 0), // value 0 (the whole coinbase is the fee)
    Buffer.from([34, 0x6a, 0x20]), // script: OP_RETURN PUSH32
  ]);
  const suffix = Buffer.from("00000000", "hex"); // locktime
  const tx = Buffer.concat([prefix, leaf, suffix]);
  return { prefix, suffix, hex: tx.toString("hex"), txidInternal: sha2(tx) };
}

export type BuiltProof = { base64: string; digestHex: string; merkleRootInternal: Buffer };

function buildProof(params: {
  digest: Buffer;
  nonce: Buffer;
  tx: { prefix: Buffer; suffix: Buffer };
  coinbaseTxidDisplay: string;
  blockHeight: number;
}): BuiltProof {
  const { digest, nonce, tx, coinbaseTxidDisplay, blockHeight } = params;
  const cb = reverseHex(coinbaseTxidDisplay);
  const parts = [
    op(OP.APPEND, nonce), op(OP.SHA256), // leaf = sha256(digest || nonce)
    op(OP.PREPEND, tx.prefix), op(OP.APPEND, tx.suffix), op(OP.SHA256), op(OP.SHA256), // txid
    op(OP.PREPEND, cb), op(OP.SHA256), op(OP.SHA256), // merkle root of [coinbase, tx]
    Buffer.from([0x00]), BITCOIN_ATTESTATION_TAG, varbytes(varuint(blockHeight)),
  ];
  const bytes = Buffer.concat([OTS_MAGIC, Buffer.from([0x01]), op(OP.SHA256), digest, ...parts]);
  const leaf = sha(Buffer.concat([digest, nonce]));
  const txid = sha2(Buffer.concat([tx.prefix, leaf, tx.suffix]));
  return { base64: bytes.toString("base64"), digestHex: digest.toString("hex"), merkleRootInternal: sha2(Buffer.concat([cb, txid])) };
}

/**
 * The production password path: a read-only mounted FILE (a temp file outside
 * the repository). Never an environment variable. `dispose()` removes it.
 */
export function passwordFiles() {
  const dir = mkdtempSync(join(tmpdir(), "proovra-regtest-"));
  return {
    write(name: string, value: string): string {
      const p = join(dir, name);
      writeFileSync(p, `${value}\n`, { mode: 0o400 });
      return p;
    },
    dispose(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
