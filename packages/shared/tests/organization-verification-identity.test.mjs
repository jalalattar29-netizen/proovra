/**
 * AUD-016 — a VERIFIED_ORGANIZATION level is not organization verification.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  acquisitionIdentityLevelLabel,
  acquisitionOrganizationVerificationLabel,
  buildEvidenceTrustDecision,
  identityLevelLabel,
  isOrganizationVerifiedAtCapture,
  resolveAcquisitionIdentitySnapshot,
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

// ---------------------------------------------------------------- AUD-016

const legacyRow = (over = {}) =>
  resolveAcquisitionIdentitySnapshot({
    custodyEvents: [],
    row: { identityLevelSnapshot: "VERIFIED_ORGANIZATION", submittedByAuthProvider: "EMAIL", submittedByEmail: "a@example.com", organizationVerifiedSnapshot: true, ...over },
    acquisitionMode: "PROOVRA_WEB_UPLOAD",
  });
const snapshot = (payload) =>
  resolveAcquisitionIdentitySnapshot({
    custodyEvents: [{ eventType: "IDENTITY_SNAPSHOT_RECORDED", atUtc: "2026-10-01T00:00:00Z", payload }],
    acquisitionMode: "PROOVRA_WEB_UPLOAD",
  });

test("AUD-016: historical rows with a VERIFIED_ORGANIZATION level and no capture-time fact are not verified organizations", () => {
  const legacy = legacyRow();
  assert.equal(legacy.basis, "RECORDED_ON_RECORD");
  assert.equal(isOrganizationVerifiedAtCapture(legacy), false);
  assert.notEqual(acquisitionIdentityLevelLabel(legacy), "Verified organization");
  assert.equal(acquisitionOrganizationVerificationLabel(legacy), "Not established");
  // A capture-time snapshot naming the level without the fact.
  const noFact = snapshot({ identityLevelSnapshot: "VERIFIED_ORGANIZATION", submittedByAuthProvider: "EMAIL", workspaceKind: "SHARED" });
  assert.equal(isOrganizationVerifiedAtCapture(noFact), false);
  assert.equal(acquisitionIdentityLevelLabel(noFact), "Shared-workspace member account");
  // The canonical fact: "Verified organization".
  const verified = snapshot({ identityLevelSnapshot: "VERIFIED_ORGANIZATION", submittedByAuthProvider: "EMAIL", workspaceKind: "SHARED", organizationVerifiedSnapshot: true });
  assert.equal(isOrganizationVerifiedAtCapture(verified), true);
  assert.equal(acquisitionIdentityLevelLabel(verified), "Verified organization");
  // A level without any snapshot never reads as a verified organization.
  assert.doesNotMatch(identityLevelLabel("VERIFIED_ORGANIZATION"), /^Verified organization$/);
  assert.match(identityLevelLabel("VERIFIED_ORGANIZATION"), /not confirmed/);
});

test("AUD-016: the identity signal is PASSED only on the capture-time organization fact", () => {
  const id = (over) => decide(over).signals.find((s) => s.key === "identity");
  assert.notEqual(id({ identityLevelSnapshot: "VERIFIED_ORGANIZATION" }).state, "PASSED");
  assert.notEqual(id({ identityLevelSnapshot: "VERIFIED_ORGANIZATION", organizationVerifiedAtCapture: false }).state, "PASSED");
  assert.equal(id({ identityLevelSnapshot: "VERIFIED_ORGANIZATION", organizationVerifiedAtCapture: true }).state, "PASSED");
  // Workspace membership and email verification are distinct from it.
  assert.notEqual(id({ identityLevelSnapshot: "ORGANIZATION_ACCOUNT" }).state, "PASSED");
  assert.notEqual(id({ identityLevelSnapshot: "VERIFIED_EMAIL" }).state, "PASSED");
});
