/**
 * AUD-34 (2026-10-20) — THE CANONICAL SEAL VERIFIER BINDS THE SHIPPED KEY.
 *
 * A package carries the public key its seal verifies with. Before this fix the
 * canonical verifier trusted that PEM as shipped: anyone could alter an entry,
 * rebuild the index and seal, sign with their own key, ship their own PEM —
 * and every check passed. A caller that knows PROOVRA's recorded fingerprint
 * now passes it, with the fingerprint function, and the shipped key must BE
 * that key (and the key the signature file names). Without them the verifier
 * behaves as before, and says it did not bind the key: KEY_FINGERPRINT_BOUND
 * is neither passed nor failed.
 *
 * And ONE revoked-key wording: the record page's matrix row and the package
 * page state the same sentence, which says "after issuance" only when the
 * revocation is in fact later than the issue.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

import {
  buildPackageSeal,
  buildVerificationMatrix,
  serializePackageSeal,
  verifySealedPackageEntries,
  packageSealKeyRevokedStatement,
  PUBLIC_PACKAGE_KEY_BINDING_TEXT,
  PACKAGE_SEAL_FILE,
  PACKAGE_SEAL_SIGNATURE_FILE,
  PACKAGE_CHECKSUMS_FILE,
} from "../dist/index.js";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const fingerprintOfPem = (pemBytes) =>
  sha(createPublicKey(Buffer.from(pemBytes).toString("utf8")).export({ type: "spki", format: "der" }));

const proovra = generateKeyPairSync("ed25519");
const attacker = generateKeyPairSync("ed25519");
const pemOf = (k) => k.publicKey.export({ type: "spki", format: "pem" }).toString();
const PROOVRA_FP = fingerprintOfPem(Buffer.from(pemOf(proovra)));

function sealedPackage({ signer, evidence = "original evidence bytes", namedFingerprint }) {
  const entries = new Map();
  entries.set("evidence.jpg", Buffer.from(evidence));
  entries.set("reports/report-v1.pdf", Buffer.from("%PDF report v1"));
  entries.set("keys/package-seal-public-key.pem", Buffer.from(pemOf(signer)));
  const files = [...entries.entries()].map(([path, bytes]) => ({ path, sizeBytes: bytes.length, sha256: sha(bytes) }));
  const checksums = Buffer.from(JSON.stringify({ schema: "PROOVRA_PACKAGE_CHECKSUMS", files }));
  entries.set(PACKAGE_CHECKSUMS_FILE, checksums);
  const seal = buildPackageSeal({
    evidenceId: "e1",
    reportVersion: 1,
    reportFile: "reports/report-v1.pdf",
    reportSha256: sha(entries.get("reports/report-v1.pdf")),
    reportIssuedAtUtc: "2026-10-01T00:00:00.000Z",
    packageAssembledAtUtc: "2026-10-01T00:00:00.000Z",
    assembly: "WITH_REPORT_ISSUE",
    custodyThroughSequence: 3,
    proofMaterialsObservedAtUtc: "2026-10-01T00:00:00.000Z",
    fileSha256: sha(Buffer.from(evidence)),
    fingerprintHash: "b".repeat(64),
    checksumsSha256: sha(checksums),
    fileCount: files.length,
  });
  const sealBytes = Buffer.from(serializePackageSeal(seal));
  const sealSha = sha(sealBytes);
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
        signatureBase64: sign(null, Buffer.from(sealSha, "hex"), signer.privateKey).toString("base64"),
        signingKeyId: "pkg-seal",
        signingKeyVersion: "1",
        signingKeyFingerprint: namedFingerprint === undefined ? fingerprintOfPem(Buffer.from(pemOf(signer))) : namedFingerprint,
        publicKeyFile: "keys/package-seal-public-key.pem",
        signatureInput: "SHA-256(package-seal.json) raw bytes",
      }),
    ),
  );
  return entries;
}

const crypto = {
  sha256Hex: (b) => sha(b),
  verifyEd25519: (msg, sigB64, pem) => verify(null, Buffer.from(msg), pem, Buffer.from(sigB64, "base64")),
  decodeUtf8: (b) => Buffer.from(b).toString("utf8"),
  hexToBytes: (h) => Buffer.from(h, "hex"),
};
const binding = { publicKeyFingerprint: fingerprintOfPem, expectedKeyFingerprint: PROOVRA_FP };

test("characterization: without a key binding, a resealed package with the attacker's own PEM passes every check", () => {
  const forged = sealedPackage({ signer: attacker, evidence: "ALTERED evidence bytes" });
  const res = verifySealedPackageEntries({ entries: forged, ...crypto });
  assert.equal(res.ok, true);
  assert.ok(!res.passed.includes("KEY_FINGERPRINT_BOUND"), "an unbound check never claims the key was bound");
  assert.ok(!res.failures.some((f) => f.check === "KEY_FINGERPRINT_BOUND"));
});

test("with PROOVRA's recorded fingerprint, the resealed package fails KEY_FINGERPRINT_BOUND", () => {
  const forged = sealedPackage({ signer: attacker, evidence: "ALTERED evidence bytes" });
  const res = verifySealedPackageEntries({ entries: forged, ...crypto, ...binding });
  assert.equal(res.ok, false);
  assert.deepEqual(
    res.failures.map((f) => f.check),
    ["KEY_FINGERPRINT_BOUND"],
  );
  assert.match(res.failures[0].detail, /not the key PROOVRA recorded/);
});

test("the genuine package binds: KEY_FINGERPRINT_BOUND passes and the result is ok", () => {
  const res = verifySealedPackageEntries({ entries: sealedPackage({ signer: proovra }), ...crypto, ...binding });
  assert.equal(res.ok, true, JSON.stringify(res.failures));
  assert.ok(res.passed.includes("KEY_FINGERPRINT_BOUND"));
});

test("a signature file naming another key than the one shipped fails, even with no recorded fingerprint", () => {
  const entries = sealedPackage({ signer: proovra, namedFingerprint: "0".repeat(64) });
  const res = verifySealedPackageEntries({ entries, ...crypto, publicKeyFingerprint: fingerprintOfPem });
  assert.equal(res.ok, false);
  assert.deepEqual(res.failures.map((f) => f.check), ["KEY_FINGERPRINT_BOUND"]);
  assert.match(res.failures[0].detail, /package-seal\.sig names/);
});

test("an unreadable shipped PEM is not bound", () => {
  const entries = sealedPackage({ signer: proovra });
  const res = verifySealedPackageEntries({
    entries,
    ...crypto,
    publicKeyFingerprint: () => {
      throw new Error("not a PEM");
    },
    expectedKeyFingerprint: PROOVRA_FP,
  });
  assert.equal(res.ok, false);
  assert.ok(res.failures.some((f) => f.check === "KEY_FINGERPRINT_BOUND"));
});

const matrixRows = (packageSeal) => {
  const m = buildVerificationMatrix({ signals: [], identity: null, acquisitionMode: null, packageSeal, publication: { kind: "DOCUMENT" } });
  return {
    signature: m.rows.find((r) => r.key === "package_signature"),
    completeness: m.rows.find((r) => r.key === "package_completeness"),
  };
};

test("one revoked-key wording: the record matrix row states the package page's sentence", () => {
  const after = matrixRows({ kind: "KEY_REVOKED", revokedAtUtc: "2026-10-10T00:00:00.000Z", revokedAfterIssuance: true });
  assert.equal(after.signature.status, "FAILED");
  assert.equal(after.signature.statement, PUBLIC_PACKAGE_KEY_BINDING_TEXT.BOUND_KEY_REVOKED);
  assert.equal(after.completeness.status, "NOT_CHECKED");
  const before = matrixRows({ kind: "KEY_REVOKED", revokedAtUtc: "2026-09-01T00:00:00.000Z", revokedAfterIssuance: false });
  assert.equal(before.signature.status, "FAILED");
  assert.equal(before.signature.statement, PUBLIC_PACKAGE_KEY_BINDING_TEXT.KEY_REVOKED_BEFORE_ISSUE);
  assert.notEqual(after.signature.statement, LEGACY_UNBOUND_TEXT());
});

test("'after issuance' is said only for a revocation later than the issue", () => {
  assert.match(packageSealKeyRevokedStatement(true), /after this package was issued/);
  assert.doesNotMatch(packageSealKeyRevokedStatement(false), /after/);
  assert.match(packageSealKeyRevokedStatement(false), /before this package was issued/);
  assert.doesNotMatch(packageSealKeyRevokedStatement(null), /after|before/);
});

function LEGACY_UNBOUND_TEXT() {
  return matrixRows({ kind: "LEGACY_UNBOUND" }).signature.statement;
}
