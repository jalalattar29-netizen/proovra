#!/usr/bin/env node
/**
 * AUDIT-ONLY independent verification of a PROOVRA verification package.
 * Uses only node:crypto / node:zlib — no product code — so the result does not
 * depend on the implementation it checks. Reference values come from the
 * record's Public Verify answer captured during journey J01.
 *
 *   node recompute-package.mjs <package.zip> <journeys-raw.json> <out.json>
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const [zipPath, journeysPath, outPath] = process.argv.slice(2);
const zip = readFileSync(zipPath);
const sha = (b) => createHash("sha256").update(b).digest("hex");

// Minimal ZIP central-directory reader (stored + deflate).
function readZip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i += 1) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString("utf8");
    const lnlen = buf.readUInt16LE(lho + 26);
    const lelen = buf.readUInt16LE(lho + 28);
    const data = buf.slice(lho + 30 + lnlen + lelen, lho + 30 + lnlen + lelen + csize);
    files.set(name, method === 0 ? data : inflateRawSync(data));
    p += 46 + nlen + elen + clen;
  }
  return files;
}

const ref = JSON.parse(readFileSync(journeysPath, "utf8")).journeys.find((j) => j.id.startsWith("J01")).observations.publicVerify.basicVerification;
const F = readZip(zip);
const read = (n) => {
  const b = F.get(n);
  if (!b) throw new Error(`missing ${n}`);
  return b;
};
const checks = [];
const check = (name, ok, detail = null) => checks.push({ name, ok: Boolean(ok), detail });

check("0. sha256(zip) equals Public Verify package.packageSha256", sha(zip) === ref.package.packageSha256, sha(zip));

const sealBytes = read("package-seal.json");
const sig = JSON.parse(read("package-seal.sig").toString("utf8"));
check("1a. sha256(package-seal.json) equals seal signature's sealSha256", sha(sealBytes) === sig.sealSha256);
const sealPub = createPublicKey(read(sig.publicKeyFile ?? "package-manifest-public-key.pem"));
check("1b. seal signature verifies (Ed25519 over sealSha256)", verify(null, Buffer.from(sig.sealSha256, "hex"), sealPub, Buffer.from(sig.signatureBase64, "base64")));
const sealFp = sha(sealPub.export({ type: "spki", format: "der" }));
check("1c. seal key SPKI fingerprint equals the signature file and Public Verify", sealFp === sig.signingKeyFingerprint && sealFp === ref.package.sealKeyFingerprint, sealFp);

const seal = JSON.parse(sealBytes.toString("utf8"));
const checksumsBytes = read("package-checksums.json");
check("2a. sha256(package-checksums.json) equals seal.checksumsSha256", sha(checksumsBytes) === seal.checksumsSha256);
const index = JSON.parse(checksumsBytes.toString("utf8"));
const listed = new Set();
let bad = [];
for (const f of index.files) {
  listed.add(f.path);
  const b = F.get(f.path);
  if (!b || b.length !== f.sizeBytes || sha(b) !== f.sha256) bad.push(f.path);
}
check("2b. every indexed file present with matching size and SHA-256", bad.length === 0, bad);
const unlisted = [...F.keys()].filter((n) => !listed.has(n) && !["package-checksums.json", "package-seal.json", "package-seal.sig"].includes(n));
check("2c. no ZIP entry outside the index (except the three seal files)", unlisted.length === 0, unlisted);
if (seal.reportFile) check("2d. report bytes equal seal.reportSha256", sha(read(seal.reportFile)) === seal.reportSha256);

const fpBytes = read("fingerprint.json");
const fingerprintHash = sha(fpBytes);
check("3. sha256(fingerprint.json) equals seal.fingerprintHash and Public Verify", fingerprintHash === seal.fingerprintHash && fingerprintHash === ref.original.fingerprintHash, fingerprintHash);
const fp = JSON.parse(fpBytes.toString("utf8"));

const evPub = createPublicKey(read("public-key.pem"));
check("4. evidence signature verifies over the fingerprint hash", verify(null, Buffer.from(fingerprintHash, "hex"), evPub, Buffer.from(read("signature.txt").toString("utf8").trim(), "base64")));

const originalName = [...F.keys()].find((n) => /^digital-evidence-record-.*\.(png|jpg|jpeg|pdf|mp4|bin)$/.test(n));
const origSha = originalName ? sha(read(originalName)) : null;
const signedSha = fp?.file?.sha256 ?? fp?.fileSha256 ?? null;
check("5. original bytes hash to the SIGNED fingerprint's file digest and to Public Verify", origSha && origSha === signedSha && origSha === ref.original.fileSha256, { originalName, origSha, signedSha });

const canon = (v) =>
  v === null || v === undefined
    ? "null"
    : Array.isArray(v)
      ? `[${v.map(canon).join(",")}]`
      : typeof v === "object"
        ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`
        : JSON.stringify(v);
const custodyRaw = JSON.parse(read("custody.json").toString("utf8"));
const events = (Array.isArray(custodyRaw) ? custodyRaw : custodyRaw.events ?? []).slice().sort((a, b) => a.sequence - b.sequence);
let prev = null;
let chainOk = events.length > 0;
let firstBad = null;
for (const e of events) {
  const h = sha(
    canon({ v: 1, evidenceId: seal.evidenceId, sequence: e.sequence, eventType: e.eventType, atUtc: new Date(e.atUtc).toISOString(), payload: e.payload ?? null, prevEventHash: prev }),
  );
  if ((e.prevEventHash ?? null) !== prev || h !== e.eventHash) {
    chainOk = false;
    firstBad = { sequence: e.sequence, eventType: e.eventType };
    break;
  }
  prev = h;
}
check("6. custody hash chain replays from genesis", chainOk, { events: events.length, firstBad });

// Negative controls: the same checks must FAIL on altered inputs.
const flipped = Buffer.from(read(originalName));
flipped[flipped.length - 1] ^= 0xff;
check("N1. a single flipped byte in the original no longer matches the signed digest", sha(flipped) !== signedSha);
const forged = Buffer.from(sig.signatureBase64, "base64");
forged[0] ^= 0x01;
check("N2. a one-bit change to the seal signature fails verification", !verify(null, Buffer.from(sig.sealSha256, "hex"), sealPub, forged));

const result = {
  tool: "node:crypto only (independent of product code)",
  evidenceId: seal.evidenceId,
  packageSha256: sha(zip),
  entries: F.size,
  passed: checks.filter((c) => c.ok).length,
  total: checks.length,
  checks,
};
writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ok ? "" : `  ${JSON.stringify(c.detail)}`}`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
