/**
 * DISCLOSURE PROFILES, THE WITHHELD-REPORT SEAL, AND THE RFC 3161 VALIDATION
 * RECORD — pure contracts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import {
  buildDisclosureManifest,
  buildPackageSeal,
  buildTimestampValidationRecord,
  parseTsaValidationEvidence,
  projectJsonForDisclosure,
  serializePackageSeal,
  verifySealedPackageEntries,
} from "../dist/index.js";

const sha = (b) => createHash("sha256").update(b).digest("hex");

test("FULL_FORENSIC is the identity projection", () => {
  const doc = { submittedByEmail: "a@b.test", lat: 52.123456 };
  const r = projectJsonForDisclosure("FULL_FORENSIC", "case-metadata.json", doc);
  assert.deepEqual(r.value, doc);
  assert.equal(r.records.length, 0);
});

test("EXTERNAL_DISCLOSURE removes identifiers and infrastructure, coarsens coordinates, keeps commitments", () => {
  const doc = {
    evidenceId: "e1",
    submitter: { submittedByEmail: "a@b.test", ownerUserId: "u1", teamId: "t1" },
    storage: { storageBucket: "prod-bucket", storageKey: "evidence/e1/parts/0", storageVersionId: "v9", kmsKeyArn: "arn:aws:kms:eu:123456789012:key/x" },
    gps: { lat: 52.123456, lng: -1.987654, accuracyMeters: 5 },
    events: [
      { sequence: 1, eventType: "EVIDENCE_CREATED", eventHash: "h1", prevEventHash: null, payload: { ip: "10.0.0.1", userAgent: "UA" } },
      { sequence: 2, eventType: "UPLOAD_AUTHORIZED", eventHash: "h2", prevEventHash: "h1", payload: { key: "evidence/e1/x", bucket: "b" } },
    ],
    signals: [{ key: "core_integrity", state: "PASSED" }],
    fileSha256: "a".repeat(64),
  };
  const { value, records } = projectJsonForDisclosure("EXTERNAL_DISCLOSURE", "x.json", doc);
  const text = JSON.stringify(value);
  for (const leak of ["a@b.test", "u1", "t1", "prod-bucket", "evidence/e1/parts/0", "v9", "arn:aws", "123456789012", "10.0.0.1", "UA", "52.123456"]) {
    assert.ok(!text.includes(leak), leak);
  }
  assert.equal(value.gps.lat, 52.12);
  assert.equal(value.gps.lng, -1.99);
  // Commitments and structure are untouched.
  assert.equal(value.fileSha256, doc.fileSha256);
  assert.equal(value.events[1].eventHash, "h2");
  assert.equal(value.events[1].prevEventHash, "h1");
  assert.equal(value.signals[0].key, "core_integrity");
  assert.ok(records.length >= 10);
  const m = buildDisclosureManifest({
    packageId: "p-ext",
    profile: "EXTERNAL_DISCLOSURE",
    sourceFullPackageId: "p-full",
    records,
    withheldFiles: [{ file: "evidence.txt", sha256: "b".repeat(64), reason: "ORIGINAL_CONTENT" }],
  });
  assert.equal(m.completeForensicPackage, false);
  assert.match(m.statement, /NOT the complete forensic package/);
  assert.ok(m.fields.some((f) => f.path === "$.events[*].payload.ip"));
  assert.ok(m.fields.every((f) => f.reasonText.length > 10));
});

function sealedEntries(sealInput, files) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const entries = new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]));
  const index = { schema: "PROOVRA_PACKAGE_CHECKSUMS", files: [...entries].map(([path, b]) => ({ path, sizeBytes: b.length, sha256: sha(b) })) };
  const indexBytes = Buffer.from(JSON.stringify(index));
  entries.set("package-checksums.json", indexBytes);
  const seal = buildPackageSeal({ ...sealInput, checksumsSha256: sha(indexBytes), fileCount: index.files.length });
  const sealBytes = Buffer.from(serializePackageSeal(seal));
  const sealSha = sha(sealBytes);
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  entries.set("package-seal.json", sealBytes);
  entries.set("key.pem", Buffer.from(pem));
  index.files.push({ path: "key.pem", sizeBytes: Buffer.byteLength(pem), sha256: sha(Buffer.from(pem)) });
  entries.set("package-seal.sig", Buffer.from(JSON.stringify({ sealSha256: sealSha, signatureBase64: sign(null, Buffer.from(sealSha, "hex"), privateKey).toString("base64"), publicKeyFile: "key.pem" })));
  return entries;
}

const verifyEntries = (entries) =>
  verifySealedPackageEntries({
    entries,
    sha256Hex: (b) => sha(b),
    verifyEd25519: (m, s, pem) => verify(null, m, pem, Buffer.from(s, "base64")),
    decodeUtf8: (b) => Buffer.from(b).toString("utf8"),
    hexToBytes: (h) => Buffer.from(h, "hex"),
  });

const base = {
  evidenceId: "e1",
  reportVersion: 2,
  reportSha256: "c".repeat(64),
  reportIssuedAtUtc: "2026-10-07T00:00:00.000Z",
  packageAssembledAtUtc: "2026-10-07T00:00:01.000Z",
  assembly: "WITH_REPORT_ISSUE",
  custodyThroughSequence: 9,
  proofMaterialsObservedAtUtc: "2026-10-07T00:00:00.000Z",
  fileSha256: "a".repeat(64),
  fingerprintHash: "b".repeat(64),
};

test("an EXTERNAL_DISCLOSURE seal commits to the withheld report; nothing else may omit it", () => {
  const ext = verifyEntries(
    sealedEntries({ ...base, packageId: "p-ext", disclosureProfile: "EXTERNAL_DISCLOSURE", reportFile: null }, { "README.txt": "x" }),
  );
  assert.ok(ext.passed.includes("REPORT_COMMITTED_WITHHELD"), JSON.stringify(ext.failures));
  assert.equal(ext.seal.packageId, "p-ext");
  const fullWithoutReport = verifyEntries(
    sealedEntries({ ...base, packageId: "p-full", disclosureProfile: "FULL_FORENSIC", reportFile: null }, { "README.txt": "x" }),
  );
  assert.ok(fullWithoutReport.failures.some((f) => f.check === "REPORT_BOUND"));
});

test("TSA record: a validated token states each check; qualified status is never claimed", () => {
  const evidence = parseTsaValidationEvidence({ trustAnchorSha256: ["d".repeat(64)], tokenCertificateSha256: ["e".repeat(64)], nonceChecked: true, policyAllowlistEnforced: false });
  const r = buildTimestampValidationRecord({
    tsaStatus: "STAMPED",
    tsaValidatedAtUtc: "2026-10-07T00:00:02Z",
    tsaFailureCode: null,
    tokenIncluded: true,
    tokenSha256: "f".repeat(64),
    tsaHashAlgorithm: "SHA-256",
    tsaMessageImprint: "A".repeat(64),
    tsaInputDigestHex: "a".repeat(64),
    evidenceDigestHex: "a".repeat(64),
    tsaSerialNumber: "0x03",
    tsaGenTimeUtc: "2026-10-07T00:00:01Z",
    tsaPolicyOid: "1.2.3.4",
    tsaSignerCertSha256: "e".repeat(64),
    tokenPresent: true,
    evidence,
  });
  assert.equal(r.status, "VALIDATED");
  assert.equal(r.trustState, "PASSED");
  assert.equal(r.imprintMatchesEvidenceDigest, true);
  assert.deepEqual(r.checks, { signature: "PASSED", certificateChain: "PASSED", signerValidityAtGenTime: "PASSED", messageImprint: "PASSED", nonce: "PASSED", policy: "NOT_EVALUATED" });
  assert.equal(r.qualifiedStatus.evaluated, false);
  assert.doesNotMatch(JSON.stringify(r), /"qualified":\s*true|is qualified/i);
  assert.deepEqual(r.trustAnchor.sha256, ["d".repeat(64)]);
});

test("TSA record: every failure names its check and leaves the others unevaluated", () => {
  const make = (overrides) =>
    buildTimestampValidationRecord({
      tsaStatus: "FAILED",
      tsaValidatedAtUtc: null,
      tsaFailureCode: null,
      tokenIncluded: false,
      tokenSha256: null,
      tsaHashAlgorithm: "SHA-256",
      tsaMessageImprint: "a".repeat(64),
      tsaInputDigestHex: "a".repeat(64),
      evidenceDigestHex: "a".repeat(64),
      tsaSerialNumber: null,
      tsaGenTimeUtc: null,
      tsaPolicyOid: null,
      tsaSignerCertSha256: null,
      tokenPresent: true,
      evidence: null,
      ...overrides,
    });
  for (const [code, check, state] of [
    ["tsa_message_imprint_mismatch", "messageImprint", "FAILED"],
    ["tsa_token_untrusted", "certificateChain", "FAILED"], // untrusted chain / expired signer at genTime
    ["tsa_policy_not_accepted", "policy", "FAILED"],
    ["tsa_nonce_mismatch", "nonce", "FAILED"],
    ["tsa_token_signature_invalid", "signature", "FAILED"],
    ["tsa_trust_anchor_not_configured", "certificateChain", "UNAVAILABLE"], // missing trust material
  ]) {
    const r = make({ tsaFailureCode: code });
    assert.equal(r.checks[check], state, code);
    assert.notEqual(r.trustState, "PASSED", code);
    assert.equal(r.validatedAtUtc, null, code);
    for (const [k, v] of Object.entries(r.checks)) if (k !== check) assert.equal(v, "NOT_EVALUATED", `${code} ${k}`);
  }
  // A legacy token recorded but never validated.
  const legacy = make({ tsaStatus: "STAMPED", tsaFailureCode: null });
  assert.equal(legacy.status, "RECORDED_NOT_VALIDATED");
  assert.equal(legacy.trustState, "PRESENT_NOT_INDEPENDENTLY_VERIFIED");
  assert.ok(Object.values(legacy.checks).every((v) => v === "NOT_EVALUATED"));
  // A validated row without recorded validation evidence says so.
  const noEvidence = make({ tsaStatus: "STAMPED", tsaValidatedAtUtc: "2026-10-07T00:00:02Z" });
  assert.equal(noEvidence.checks.nonce, "NOT_RECORDED");
  assert.equal(noEvidence.trustAnchor.sha256, null);
});
