/**
 * AUD-014 — storage protection: only a confirmed read of the object is verified.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEvidenceTrustDecision,
  buildVerificationMatrix,
  resolveStorageProtectionVerification,
} from "../dist/index.js";

const decide = (over) =>
  buildEvidenceTrustDecision({
    evidence: {
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
      fileSha256: "a".repeat(64),
      fingerprintHash: "b".repeat(64),
      signatureBase64: "c2ln",
      signingKeyId: "k1",
      publicKeyPem: "-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----",
      signatureVerified: true,
      custodyChainValid: true,
      otsProofBase64: null,
      ...over,
    },
    custodyEvents: [],
  });
const sig = (d) => d.signals.find((s) => s.key === "signature");

// ---------------------------------------------------------------- AUD-014

const FUTURE = "2036-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";

test("AUD-014: only a successful OBSERVED read with COMPLIANCE in force is verified", () => {
  const v = (input) => resolveStorageProtectionVerification(input, new Date("2026-10-15T00:00:00Z"));
  assert.deepEqual(
    [v({ mode: "COMPLIANCE", retainUntil: FUTURE, source: "OBSERVED" }).state, v({ mode: "COMPLIANCE", retainUntil: FUTURE, source: "OBSERVED" }).verified],
    ["STORAGE_CONFIRMED", true],
  );
  assert.equal(v({ mode: "COMPLIANCE", retainUntil: FUTURE, source: "RECORDED" }).state, "RECORDED");
  assert.equal(v({ mode: "COMPLIANCE", retainUntil: FUTURE, source: "RECORDED" }).verified, false);
  // Unknown provenance is a snapshot, never verified.
  assert.equal(v({ mode: "COMPLIANCE", retainUntil: FUTURE }).state, "RECORDED");
  // A failed read beside a recorded snapshot: still only RECORDED.
  assert.equal(v({ mode: "COMPLIANCE", retainUntil: FUTURE, source: "RECORDED", readFailed: true }).state, "RECORDED");
  assert.equal(v({ source: "OBSERVED", readFailed: true }).state, "UNAVAILABLE");
  // Expired, GOVERNANCE, or a read that shows no lock: FAILED.
  assert.equal(v({ mode: "COMPLIANCE", retainUntil: PAST, source: "OBSERVED" }).state, "FAILED");
  assert.equal(v({ mode: "COMPLIANCE", retainUntil: PAST, source: "RECORDED" }).state, "FAILED");
  assert.equal(v({ mode: "GOVERNANCE", retainUntil: FUTURE, source: "OBSERVED" }).state, "FAILED");
  assert.equal(v({ source: "OBSERVED" }).state, "FAILED");
  // The custody chain's STORAGE_PROTECTION_UNAVAILABLE: not confirmed, unless a read confirms it now.
  assert.equal(v({ mode: "COMPLIANCE", retainUntil: FUTURE, source: "RECORDED", protectionUnavailableRecorded: true }).state, "UNAVAILABLE");
  assert.equal(v({ mode: "COMPLIANCE", retainUntil: FUTURE, source: "OBSERVED", protectionUnavailableRecorded: true }).state, "STORAGE_CONFIRMED");
  // Nothing known: the platform's configured policy is CONFIGURED, not verified.
  assert.equal(v({ source: null, platformCompliancePolicyConfigured: true }).state, "CONFIGURED");
  assert.equal(v({ source: null }).state, "UNAVAILABLE");
  assert.equal(v({ storedObjectExists: false }).state, "NOT_APPLICABLE");
  assert.equal(v(null).state, "UNAVAILABLE");
});

test("AUD-014: the storage signal is PASSED only for STORAGE_CONFIRMED; a recorded snapshot says recorded", () => {
  const storage = (over) => decide(over).signals.find((s) => s.key === "immutable_storage");
  const recorded = storage({ storageImmutable: true, storageObjectLockMode: "COMPLIANCE", storageObjectLockRetainUntilUtc: FUTURE });
  assert.equal(recorded.state, "PRESENT_NOT_INDEPENDENTLY_VERIFIED");
  assert.equal(recorded.summary, "Immutable retention recorded");
  const confirmed = storage({ storageObjectLockMode: "COMPLIANCE", storageObjectLockRetainUntilUtc: FUTURE, storageProtectionVerification: "STORAGE_CONFIRMED" });
  assert.equal(confirmed.state, "PASSED");
  assert.equal(confirmed.summary, "Immutable retention verified");
  assert.equal(storage({ storageProtectionVerification: "UNAVAILABLE" }).state, "UNAVAILABLE");
  assert.equal(storage({ storageProtectionVerification: "FAILED" }).state, "FAILED");
  const m = buildVerificationMatrix({ signals: decide({ storageImmutable: true, storageObjectLockMode: "COMPLIANCE", storageObjectLockRetainUntilUtc: FUTURE }).signals, identity: null, acquisitionMode: null, packageSeal: { kind: "SELF" }, publication: { kind: "DOCUMENT" } });
  assert.notEqual(m.rows.find((r) => r.key === "storage_protection").status, "VERIFIED");
});
