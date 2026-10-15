/**
 * AUD-013 — record-signature validity: active, rotated, revoked, mismatched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEvidenceTrustDecision,
  buildVerificationMatrix,
  resolveRecordSignatureValidity,
} from "../dist/index.js";

// ---------------------------------------------------------------- AUD-013

test("AUD-013: signature validity — active, rotated, revoked, mismatched, invalid", () => {
  const base = { signed: true, cryptoValid: true, keyMatchesRecord: true };
  const active = resolveRecordSignatureValidity({ ...base, key: { revokedAt: null, supersededByVersion: null } });
  assert.deepEqual([active.state, active.presentlyTrusted, active.cryptographicallyValid], ["VALID", true, true]);
  // Rotated (a later version exists) but never revoked: history stays valid.
  const rotated = resolveRecordSignatureValidity({ ...base, key: { revokedAt: null, supersededByVersion: 2 } });
  assert.deepEqual([rotated.state, rotated.presentlyTrusted], ["VALID_SUPERSEDED_KEY", true]);
  // Revoked: still mathematically valid, never presently trusted.
  const revoked = resolveRecordSignatureValidity({ ...base, key: { revokedAt: new Date("2026-10-01T00:00:00Z"), supersededByVersion: 2 } });
  assert.deepEqual([revoked.state, revoked.presentlyTrusted, revoked.cryptographicallyValid], ["REVOKED_KEY", false, true]);
  assert.equal(revoked.revokedAtUtc, "2026-10-01T00:00:00.000Z");
  // A legacy record without the key binding (null) is not a mismatch.
  assert.equal(resolveRecordSignatureValidity({ ...base, keyMatchesRecord: null, key: { revokedAt: null } }).state, "VALID");
  assert.equal(resolveRecordSignatureValidity({ ...base, keyMatchesRecord: false, key: { revokedAt: null } }).state, "KEY_MISMATCH");
  assert.equal(resolveRecordSignatureValidity({ ...base, cryptoValid: false, key: { revokedAt: null } }).state, "INVALID");
  assert.equal(resolveRecordSignatureValidity({ ...base, key: null }).state, "KEY_NOT_REGISTERED");
  assert.equal(resolveRecordSignatureValidity({ ...base, signed: false, key: null }).state, "NOT_SIGNED");
});

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

test("AUD-013: a revoked key's signature is never PASSED, and the matrix row is never VERIFIED", () => {
  const revoked = decide({ signatureVerified: false, signatureValidity: { state: "REVOKED_KEY", revokedAtUtc: "2026-10-01T00:00:00.000Z" } });
  assert.equal(sig(revoked).state, "FAILED");
  assert.match(sig(revoked).summary, /revoked at 2026-10-01T00:00:00.000Z/);
  assert.match(sig(revoked).detail, /mathematically/);
  // Even a caller that (wrongly) passed signatureVerified: true cannot pass it.
  assert.equal(sig(decide({ signatureVerified: true, signatureValidity: { state: "REVOKED_KEY", revokedAtUtc: null } })).state, "FAILED");
  const matrix = buildVerificationMatrix({ signals: revoked.signals, identity: null, acquisitionMode: null, packageSeal: { kind: "SELF" }, publication: { kind: "DOCUMENT" } });
  assert.notEqual(matrix.rows.find((r) => r.key === "record_signature").status, "VERIFIED");
  // A rotated key stays PASSED.
  assert.equal(sig(decide({ signatureValidity: { state: "VALID_SUPERSEDED_KEY", revokedAtUtc: null } })).state, "PASSED");
  assert.equal(sig(decide({ signatureValidity: { state: "VALID", revokedAtUtc: null } })).state, "PASSED");
});
