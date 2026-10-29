/**
 * STREAMING native file digest (2026-10-29).
 *
 * A single-file screen recording is up to 512 MB; the JS integrity path holds
 * the whole file in memory once to hash it (expo-crypto has no incremental
 * digest) — a likely out-of-memory crash. Native builds now expose `hashFile`
 * (1 MiB chunks into incremental SHA-256 + MD5, off the JS/main thread) and
 * `computeFileIntegrity` uses it whenever the binary has it.
 *
 * 1. BEHAVIOURAL: the real `chooseIntegrityPath` decides native / JS / refuse.
 * 2. SOURCE STRUCTURE (Swift/Kotlin cannot run here; native-build.yml compiles
 *    them and runs FileDigestTest on the JVM): the digest is chunked, never a
 *    whole-file read, and runs off the JS/main thread.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(HERE, rel), "utf8");
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const uploadUtils = read("../src/upload-utils.ts");
const swift = strip(read("../modules/proovra-screen-capture/ios/ProovraFileDigest.swift"));
const iosModule = strip(read("../modules/proovra-screen-capture/ios/ProovraScreenCaptureModule.swift"));
const KT = "../modules/proovra-screen-capture/android/src/main/java/com/proovra/screencapture";
const kotlin = strip(read(`${KT}/FileDigest.kt`));
const ktModule = strip(read(`${KT}/ProovraScreenCaptureModule.kt`));
const binding = read("../modules/proovra-screen-capture/index.ts");

// Load the REAL decision function (the module's imports are native-only).
const fn = uploadUtils.match(/export function chooseIntegrityPath\([\s\S]*?\n\}/)?.[0];
assert.ok(fn, "chooseIntegrityPath not found in upload-utils.ts");
const maxJs = uploadUtils.match(/export const JS_INTEGRITY_MAX_BYTES = ([^;]+);/)?.[1];
assert.ok(maxJs, "JS_INTEGRITY_MAX_BYTES not found");
const js = ts.transpileModule(`const JS_INTEGRITY_MAX_BYTES = ${maxJs};\nexport { JS_INTEGRITY_MAX_BYTES };\n${fn}`, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { chooseIntegrityPath, JS_INTEGRITY_MAX_BYTES } = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const MB = 1024 * 1024;

test("the native streaming digest is used whenever the binary has it — at any size", () => {
  for (const size of [0, 1, 10 * MB, 512 * MB]) assert.equal(chooseIntegrityPath(true, size, false), "native", `size ${size}`);
});

test("an older binary (no native digest) uses the JS path — the only one it has", () => {
  for (const size of [0, 10 * MB, 512 * MB]) assert.equal(chooseIntegrityPath(false, size, false), "js", `size ${size}`);
});

test("after a native failure the JS path is used ONLY for a small file; a large one is refused, never loaded into JS", () => {
  assert.equal(JS_INTEGRITY_MAX_BYTES, 64 * MB);
  assert.equal(chooseIntegrityPath(true, 5 * MB, true), "js");
  assert.equal(chooseIntegrityPath(true, JS_INTEGRITY_MAX_BYTES, true), "js");
  assert.equal(chooseIntegrityPath(true, JS_INTEGRITY_MAX_BYTES + 1, true), "refuse");
  assert.equal(chooseIntegrityPath(true, 512 * MB, true), "refuse");
});

test("computeFileIntegrity tries the native digest FIRST and only then the whole-file JS read", () => {
  const body = uploadUtils.match(/export async function computeFileIntegrity\([\s\S]*?\n\}/)[0];
  const nativeAt = body.indexOf("hashFileNative(fileUri)");
  const jsAt = body.indexOf("readFileBytes(fileUri, sizeBytes)");
  assert.ok(nativeAt > 0 && jsAt > nativeAt, "the native digest must come before the JS read");
  assert.match(body, /if \(chooseIntegrityPath\(isNativeFileHashAvailable\(\), statSize, false\) === "native"\)/);
  assert.match(body, /if \(chooseIntegrityPath\(true, statSize, true\) === "refuse"\) throw err;/);
  assert.match(body, /if \(d\.sizeBytes !== statSize\) throw new Error/);
  // Every capture upload (the single-file recording included) goes through it.
  assert.match(read("../src/direct-capture.ts"), /const integrity = await computeFileIntegrityBase64\(item\.uri\);/);
  assert.match(uploadUtils, /: await computeFileIntegrity\(params\.uri\);/);
});

test("iOS: FileHandle chunked reads into incremental CryptoKit SHA-256 + MD5, off the main thread", () => {
  assert.match(swift, /static let chunkBytes = 1 << 20/);
  assert.match(swift, /try handle\.read\(upToCount: chunkBytes\)/);
  assert.match(swift, /var sha = SHA256\(\)[\s\S]*?var md5 = Insecure\.MD5\(\)/);
  assert.match(swift, /sha\.update\(data: data\)\s*md5\.update\(data: data\)/);
  assert.ok(!/readDataToEndOfFile|readToEnd\(|Data\(contentsOf:/.test(swift), "a whole-file read is back");
  assert.match(swift, /throw Failure\.notFound/);
  assert.match(iosModule, /AsyncFunction\("hashFile"\) \{ \(uri: String, promise: Promise\) in\s*DispatchQueue\.global\(qos: \.utility\)\.async/);
  assert.match(iosModule, /promise\.reject\("FILE_NOT_FOUND"/);
});

test("Android: FileInputStream chunks into MessageDigest SHA-256 + MD5 on a background executor", () => {
  assert.match(kotlin, /internal const val HASH_CHUNK_BYTES = 1 shl 20/);
  assert.match(kotlin, /val n = input\.read\(buffer\)/);
  assert.match(kotlin, /MessageDigest\.getInstance\("SHA-256"\)[\s\S]*?MessageDigest\.getInstance\("MD5"\)/);
  assert.ok(!/readBytes\(\)|readAllBytes|Files\.readAll/.test(kotlin), "a whole-file read is back");
  assert.match(ktModule, /AsyncFunction\("hashFile"\) \{ uri: String, promise: Promise ->\s*hashExecutor\.execute \{/);
  assert.match(ktModule, /promise\.reject\(CodedException\(HASH_FILE_NOT_FOUND,/);
  assert.match(kotlin, /if \(uri\.startsWith\("file:"\)\) \{\s*return try \{ URI\(uri\)\.path \}/);
});

test("the JS binding exposes the native digest and a capability probe for older binaries", () => {
  assert.match(binding, /export type NativeFileDigest = \{ sha256Hex: string; md5Base64: string; sizeBytes: number \};/);
  assert.match(binding, /export function isNativeFileHashAvailable\(\): boolean/);
  assert.match(binding, /export async function hashFileNative\(uri: string\): Promise<NativeFileDigest>/);
});
