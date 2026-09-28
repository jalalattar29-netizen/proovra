/**
 * Format-5 package seal: a single modified byte in ANY entry — the embedded
 * report above all — must fail verification, and so must an entry the index
 * does not list. Uses real Ed25519 keys (node:crypto); no mocks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";

import {
  buildPackageSeal,
  serializePackageSeal,
  verifySealedPackageEntries,
  PACKAGE_SEAL_FILE,
  PACKAGE_SEAL_SIGNATURE_FILE,
  PACKAGE_CHECKSUMS_FILE,
} from "../dist/index.js";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

function buildPackage({ tamper } = {}) {
  const entries = new Map();
  entries.set("evidence.jpg", Buffer.from("original evidence bytes"));
  entries.set("reports/proovra-verification-report-v7.pdf", Buffer.from("%PDF report v7"));
  entries.set("custody.json", Buffer.from('{"events":[]}'));
  entries.set("package-manifest-public-key.pem", Buffer.from(publicPem));
  const files = [...entries.entries()]
    .map(([path, bytes]) => ({ path, sizeBytes: bytes.length, sha256: sha(bytes) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const checksums = Buffer.from(JSON.stringify({ schema: "PROOVRA_PACKAGE_CHECKSUMS", files }, null, 2));
  entries.set(PACKAGE_CHECKSUMS_FILE, checksums);
  const seal = buildPackageSeal({
    evidenceId: "e1",
    reportVersion: 7,
    reportFile: "reports/proovra-verification-report-v7.pdf",
    reportSha256: sha(entries.get("reports/proovra-verification-report-v7.pdf")),
    reportIssuedAtUtc: "2026-09-01T00:00:00.000Z",
    packageAssembledAtUtc: "2026-09-29T00:00:00.000Z",
    assembly: "AFTER_REPORT_ISSUE",
    custodyThroughSequence: 12,
    proofMaterialsObservedAtUtc: "2026-09-29T00:00:00.000Z",
    fileSha256: "a".repeat(64),
    fingerprintHash: "b".repeat(64),
    checksumsSha256: sha(checksums),
    fileCount: files.length,
  });
  const sealBytes = Buffer.from(serializePackageSeal(seal), "utf8");
  const sealSha = sha(sealBytes);
  const signature = sign(null, Buffer.from(sealSha, "hex"), privateKey).toString("base64");
  entries.set(PACKAGE_SEAL_FILE, sealBytes);
  entries.set(
    PACKAGE_SEAL_SIGNATURE_FILE,
    Buffer.from(
      JSON.stringify({
        schema: "PROOVRA_PACKAGE_SEAL_SIGNATURE",
        version: 1,
        signedFile: PACKAGE_SEAL_FILE,
        digestAlgorithm: "SHA-256",
        signatureAlgorithm: "ED25519",
        sealSha256: sealSha,
        signatureBase64: signature,
        signingKeyId: "k",
        signingKeyVersion: "1",
        signingKeyFingerprint: null,
        publicKeyFile: "package-manifest-public-key.pem",
        signatureInput: "x",
      }),
    ),
  );
  if (tamper) tamper(entries);
  return entries;
}

const crypto = {
  sha256Hex: (b) => sha(b),
  verifyEd25519: (msg, sigB64, pem) => verify(null, Buffer.from(msg), pem, Buffer.from(sigB64, "base64")),
  decodeUtf8: (b) => Buffer.from(b).toString("utf8"),
  hexToBytes: (h) => Buffer.from(h, "hex"),
};

test("an untouched sealed package verifies, and the seal names the certified report", () => {
  const res = verifySealedPackageEntries({ entries: buildPackage(), ...crypto });
  assert.equal(res.ok, true, JSON.stringify(res.failures));
  assert.equal(res.seal.reportVersion, 7);
  assert.equal(res.seal.assembly, "AFTER_REPORT_ISSUE");
});

test("replacing the embedded report fails even when its checksum line is rewritten", () => {
  const entries = buildPackage({
    tamper: (e) => {
      const forged = Buffer.from("%PDF forged report");
      e.set("reports/proovra-verification-report-v7.pdf", forged);
      // The format-4 attack: edit the unsigned index to match the forgery.
      const idx = JSON.parse(e.get(PACKAGE_CHECKSUMS_FILE).toString());
      for (const f of idx.files) if (f.path.startsWith("reports/")) { f.sha256 = sha(forged); f.sizeBytes = forged.length; }
      e.set(PACKAGE_CHECKSUMS_FILE, Buffer.from(JSON.stringify(idx, null, 2)));
    },
  });
  const res = verifySealedPackageEntries({ entries, ...crypto });
  assert.equal(res.ok, false);
  assert.ok(res.failures.some((f) => f.check === "CHECKSUM_INDEX_BOUND"));
});

test("one modified byte in any listed entry fails", () => {
  const entries = buildPackage({ tamper: (e) => e.set("custody.json", Buffer.from('{"events":[1]}')) });
  const res = verifySealedPackageEntries({ entries, ...crypto });
  assert.equal(res.ok, false);
  assert.ok(res.failures.some((f) => f.check === "ENTRIES_MATCH_INDEX"));
});

test("an entry the index does not list fails", () => {
  const entries = buildPackage({ tamper: (e) => e.set("extra/injected.txt", Buffer.from("x")) });
  const res = verifySealedPackageEntries({ entries, ...crypto });
  assert.ok(res.failures.some((f) => f.check === "NO_UNLISTED_ENTRIES"));
});

test("a rewritten seal fails its signature", () => {
  const entries = buildPackage({
    tamper: (e) => {
      const seal = JSON.parse(e.get(PACKAGE_SEAL_FILE).toString());
      seal.reportIssuedAtUtc = "2020-01-01T00:00:00.000Z"; // backdating
      e.set(PACKAGE_SEAL_FILE, Buffer.from(JSON.stringify(seal)));
    },
  });
  const res = verifySealedPackageEntries({ entries, ...crypto });
  assert.ok(res.failures.some((f) => f.check === "SIGNATURE_VALID"));
});

test("a format-4 package (no seal) is reported as unsealed, never as verified", () => {
  const entries = buildPackage({ tamper: (e) => { e.delete(PACKAGE_SEAL_FILE); e.delete(PACKAGE_SEAL_SIGNATURE_FILE); } });
  const res = verifySealedPackageEntries({ entries, ...crypto });
  assert.equal(res.ok, false);
  assert.equal(res.failures[0].check, "SEAL_PRESENT");
});
