/**
 * AUD-33 (2026-10-20) — the guards the audit's mutation run showed UNPINNED.
 *
 *   D  the seal verifier's REPORT_BOUND check: a validly signed seal that
 *      names a DIFFERENT report than the one embedded must fail;
 *   G  the EVIDENCE_ARCHIVED output restriction: an archived record is
 *      offered no report / package action.
 *
 * Real Ed25519 keys (node:crypto); no mocks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";

import {
  buildPackageSeal,
  outputBlockingRestriction,
  resolveEvidenceOutputActions,
  serializePackageSeal,
  verifySealedPackageEntries,
  PACKAGE_CHECKSUMS_FILE,
  PACKAGE_SEAL_FILE,
  PACKAGE_SEAL_SIGNATURE_FILE,
} from "../dist/index.js";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const REPORT = "reports/proovra-verification-report-v7.pdf";

/** A package whose seal is SIGNED over whatever the seal says (the attacker holds no key: the issuer did). */
function sealedPackage({ sealReportSha256, sealReportFile = REPORT, disclosureProfile, dropReport = false } = {}) {
  const entries = new Map();
  entries.set("evidence.jpg", Buffer.from("original evidence bytes"));
  if (!dropReport) entries.set(REPORT, Buffer.from("%PDF report v7"));
  entries.set("package-manifest-public-key.pem", Buffer.from(publicPem));
  const files = [...entries.entries()]
    .map(([path, bytes]) => ({ path, sizeBytes: bytes.length, sha256: sha(bytes) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const checksums = Buffer.from(JSON.stringify({ schema: "PROOVRA_PACKAGE_CHECKSUMS", files }, null, 2));
  entries.set(PACKAGE_CHECKSUMS_FILE, checksums);
  const seal = buildPackageSeal({
    evidenceId: "e1",
    reportVersion: 7,
    reportFile: sealReportFile,
    reportSha256: sealReportSha256 ?? sha(Buffer.from("%PDF report v7")),
    reportIssuedAtUtc: "2026-09-01T00:00:00.000Z",
    packageAssembledAtUtc: "2026-09-29T00:00:00.000Z",
    assembly: "AFTER_REPORT_ISSUE",
    custodyThroughSequence: 12,
    proofMaterialsObservedAtUtc: "2026-09-29T00:00:00.000Z",
    fileSha256: "a".repeat(64),
    fingerprintHash: "b".repeat(64),
    checksumsSha256: sha(checksums),
    fileCount: files.length,
    ...(disclosureProfile ? { disclosureProfile } : {}),
  });
  const sealBytes = Buffer.from(serializePackageSeal(seal), "utf8");
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
        signatureBase64: sign(null, Buffer.from(sealSha, "hex"), privateKey).toString("base64"),
        signingKeyId: "k",
        signingKeyVersion: "1",
        signingKeyFingerprint: null,
        publicKeyFile: "package-manifest-public-key.pem",
        signatureInput: "x",
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
const failedChecks = (res) => res.failures.map((f) => f.check);

test("D: the control — the matching seal verifies and passes REPORT_BOUND", () => {
  const res = verifySealedPackageEntries({ entries: sealedPackage(), ...crypto });
  assert.equal(res.ok, true, JSON.stringify(res.failures));
  assert.ok(res.passed.includes("REPORT_BOUND"));
});

test("D: a signed seal naming ANOTHER report digest than the embedded report fails REPORT_BOUND", () => {
  // Every other layer is intact: the index lists the embedded bytes, the seal
  // commits to that index and its signature is valid. Only the binding between
  // the seal's reportSha256 and the report actually shipped is wrong.
  const res = verifySealedPackageEntries({ entries: sealedPackage({ sealReportSha256: "c".repeat(64) }), ...crypto });
  assert.equal(res.ok, false);
  assert.deepEqual(failedChecks(res), ["REPORT_BOUND"]);
  assert.ok(!res.passed.includes("REPORT_BOUND"));
});

test("D: a seal naming a report the package does not carry fails REPORT_BOUND", () => {
  const res = verifySealedPackageEntries({ entries: sealedPackage({ dropReport: true }), ...crypto });
  assert.equal(res.ok, false);
  assert.ok(failedChecks(res).includes("REPORT_BOUND"));
});

function facts(over = {}) {
  return {
    record: "FINALIZED",
    reportEligibility: "ELIGIBLE",
    packageEligibility: "ELIGIBLE",
    latestReportVersion: 1,
    packageAtLatestReport: true,
    latestPackageVersion: 1,
    packageBlockedByGovernance: false,
    reportRequest: null,
    packageRequest: null,
    restrictions: {
      lifecycleState: "ACTIVE",
      legalHold: false,
      workspaceSuspended: false,
      workspaceClosed: false,
      workspaceResolved: true,
    },
    callerMayGenerate: true,
    callerMaySupersede: true,
    newVersionFitsStorage: true,
    ...over,
  };
}

test("G: an ARCHIVED record is restricted as EVIDENCE_ARCHIVED", () => {
  assert.equal(
    outputBlockingRestriction({ lifecycleState: "ARCHIVED", legalHold: false, workspaceSuspended: false, workspaceClosed: false, workspaceResolved: true }),
    "EVIDENCE_ARCHIVED",
  );
  assert.equal(
    outputBlockingRestriction({ lifecycleState: "ACTIVE", legalHold: false, workspaceSuspended: false, workspaceClosed: false, workspaceResolved: true }),
    null,
  );
});

test("G: an ARCHIVED record is offered no new report version and no first report", () => {
  const archived = { lifecycleState: "ARCHIVED", legalHold: false, workspaceSuspended: false, workspaceClosed: false, workspaceResolved: true };
  const issued = resolveEvidenceOutputActions(facts({ restrictions: archived }));
  const first = resolveEvidenceOutputActions(facts({ restrictions: archived, latestReportVersion: null, packageAtLatestReport: false, latestPackageVersion: null }));
  for (const decisions of [issued, first]) {
    for (const d of Object.values(decisions)) {
      if (!d || typeof d !== "object" || !("action" in d)) continue;
      assert.ok(d.action === "NONE" || d.action === "DOWNLOAD", `an archived record was offered ${d.action}`);
    }
  }
  assert.equal(first.report.action, "NONE");
  assert.equal(first.report.reason, "EVIDENCE_ARCHIVED");
  // The control: the same facts, ACTIVE, are offered the first report.
  assert.notEqual(resolveEvidenceOutputActions(facts({ latestReportVersion: null, packageAtLatestReport: false, latestPackageVersion: null })).report.action, "NONE");
});
