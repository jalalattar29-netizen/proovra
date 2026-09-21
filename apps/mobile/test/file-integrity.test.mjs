/**
 * FILE INTEGRITY CODECS — behavioural.
 *
 * The native digest itself is the platform's (expo-crypto → CommonCrypto /
 * MessageDigest) and is proven on device. What this file proves is everything
 * AROUND it that used to be hand-rolled and is easy to get subtly wrong: the
 * base64 encoder that replaced `globalThis.btoa`, the streaming decoder that
 * writes chunks into one pre-allocated buffer, and the hex/base64 conversions
 * that carry the digest to the server.
 *
 * These run real inputs through the real functions and check the real outputs
 * against RFC 4648 vectors and against Node's own crypto/Buffer. They are not
 * source-text assertions: change the algorithm and they fail.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../src/upload-utils.ts");

/**
 * Load only the PURE codecs. The module's top-level imports are native-only
 * (expo-file-system / expo-crypto), so the pure functions are extracted and
 * evaluated on their own — the alternative would be mocking the native layer,
 * which would prove less.
 */
const source = readFileSync(SRC, "utf8");
function extract(name) {
  const re = new RegExp(`export (?:const|function) ${name}[\\s\\S]*?\\n}`, "m");
  const m = source.match(re);
  assert.ok(m, `could not extract ${name} from upload-utils.ts`);
  return m[0];
}
const B64_TABLES = source.match(/const B64_CHARS[\s\S]*?\n\}\)\(\);/)[0];
const js = ts.transpileModule(
  [
    B64_TABLES,
    extract("bytesToBase64"),
    extract("decodeBase64Into"),
    extract("bytesToHex"),
    extract("hexToBase64"),
  ].join("\n\n"),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText;
const { bytesToBase64, decodeBase64Into, bytesToHex, hexToBase64 } = await import(
  `data:text/javascript,${encodeURIComponent(js)}`
);

const enc = (s) => new Uint8Array(Buffer.from(s, "utf8"));

/* --------------------------------------------------------------- base64 out */

test("bytesToBase64 matches the RFC 4648 test vectors", () => {
  assert.equal(bytesToBase64(enc("")), "");
  assert.equal(bytesToBase64(enc("f")), "Zg==");
  assert.equal(bytesToBase64(enc("fo")), "Zm8=");
  assert.equal(bytesToBase64(enc("foo")), "Zm9v");
  assert.equal(bytesToBase64(enc("foob")), "Zm9vYg==");
  assert.equal(bytesToBase64(enc("fooba")), "Zm9vYmE=");
  assert.equal(bytesToBase64(enc("foobar")), "Zm9vYmFy");
});

test("bytesToBase64 agrees with Node for random binary of every length mod 3", () => {
  for (let n = 0; n < 40; n += 1) {
    const b = randomBytes(n);
    assert.equal(bytesToBase64(new Uint8Array(b)), b.toString("base64"), `length ${n}`);
  }
});

test("bytesToBase64 handles high bytes (0x80–0xFF) without sign errors", () => {
  const b = Buffer.from([0x00, 0x7f, 0x80, 0xff, 0xfe, 0x81]);
  assert.equal(bytesToBase64(new Uint8Array(b)), b.toString("base64"));
});

/* ---------------------------------------------------------------- base64 in */

test("decodeBase64Into reproduces the original bytes at the given offset", () => {
  const payload = randomBytes(300);
  const b64 = payload.toString("base64");
  const out = new Uint8Array(1000);
  const written = decodeBase64Into(b64, out, 100);
  assert.equal(written, 300);
  assert.deepEqual(Buffer.from(out.subarray(100, 400)), payload);
  // Nothing outside the written window was touched.
  assert.ok(out.subarray(0, 100).every((v) => v === 0));
  assert.ok(out.subarray(400).every((v) => v === 0));
});

test("decodeBase64Into ignores whitespace/newlines a platform may insert", () => {
  const payload = randomBytes(90);
  const wrapped = payload.toString("base64").replace(/(.{8})/g, "$1\n");
  const out = new Uint8Array(90);
  assert.equal(decodeBase64Into(wrapped, out, 0), 90);
  assert.deepEqual(Buffer.from(out), payload);
});

test("chunked decode assembles byte-identically to a single decode", () => {
  // The real read path: 3-byte-aligned chunks decoded into one buffer.
  const payload = randomBytes(9001);
  const CHUNK = 3 * 64; // base64-aligned, like READ_CHUNK_BYTES
  const out = new Uint8Array(payload.length);
  let offset = 0;
  while (offset < payload.length) {
    const len = Math.min(CHUNK, payload.length - offset);
    const slice = payload.subarray(offset, offset + len).toString("base64");
    offset += decodeBase64Into(slice, out, offset);
  }
  assert.equal(offset, payload.length);
  assert.deepEqual(Buffer.from(out), payload);
});

/* ------------------------------------------------------------------- digest */

test("bytesToHex produces the canonical lowercase hex digest", () => {
  const digest = createHash("sha256").update("proovra").digest();
  assert.equal(bytesToHex(new Uint8Array(digest)), digest.toString("hex"));
  assert.match(bytesToHex(new Uint8Array(digest)), /^[0-9a-f]{64}$/);
});

test("a SHA-256 digest survives the hex and base64 encodings the server expects", () => {
  const digest = createHash("sha256").update(randomBytes(512)).digest();
  const bytes = new Uint8Array(digest);
  assert.equal(bytesToHex(bytes), digest.toString("hex"));
  assert.equal(bytesToBase64(bytes), digest.toString("base64"));
  // The declaration sends hex; the storage header sends base64. Both must
  // describe the SAME digest, or storage accepts bytes the server then rejects.
  assert.equal(hexToBase64(bytesToHex(bytes)), bytesToBase64(bytes));
});

test("hexToBase64 converts the platform's MD5 hex to the Content-MD5 header form", () => {
  const md5 = createHash("md5").update("proovra evidence").digest();
  assert.equal(hexToBase64(md5.toString("hex")), md5.toString("base64"));
  assert.equal(hexToBase64(md5.toString("hex").toUpperCase()), md5.toString("base64"));
});

test("hexToBase64 refuses a malformed digest instead of declaring something untrue", () => {
  assert.throws(() => hexToBase64("abc"), /Invalid hex/);
  assert.throws(() => hexToBase64("zz00"), /Invalid hex/);
});

/* -------------------------------------------------------------------- guard */

/**
 * A static regression guard, not a behaviour proof. These two globals are
 * FATAL on React Native and cannot be caught by any Node test (Node has both),
 * so the only cheap defence is refusing their reintroduction. The behavioural
 * proof of the digest path is the physical-device acceptance matrix.
 */
test("no browser-only crypto global returns to the native integrity path", () => {
  const live = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(live, /crypto\.subtle/, "crypto.subtle is not available on React Native");
  assert.doesNotMatch(live, /globalThis\.(atob|btoa)/, "atob/btoa are not guaranteed on Hermes");
});

test("the hand-rolled MD5 is gone — MD5 comes from the platform", () => {
  assert.doesNotMatch(source, /function md5ArrayBuffer/, "duplicate MD5 implementation returned");
  assert.match(source, /getInfoAsync\([^)]*md5:\s*true/, "MD5 must be computed natively over the file");
});
