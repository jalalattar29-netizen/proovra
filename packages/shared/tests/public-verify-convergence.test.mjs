/**
 * PUBLIC VERIFY CONVERGENCE (2026-10-18) — the shared contract.
 *
 *   - the disclosure vocabulary reads a stored policy fail closed;
 *   - a qualifier never upgrades a status;
 *   - a timestamp validated later from the token retained at intake is
 *     VERIFIED and says how; a FAILED timestamp with no token stays as it was;
 *   - OpenTimestamps: ATTESTATION_RECORDED and an unavailable verifier are
 *     NOT_CHECKED; only CHAIN_VERIFIED is VERIFIED;
 *   - the legacy snapshot normalizer compares states, never words, and states
 *     an old artifact's issue-time anchoring from its own Bitcoin signal;
 *   - reference issuance and disclosure changes are administrative custody.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  WITHHELD_BY_DISCLOSURE_POLICY,
  buildEvidenceTrustDecision,
  buildVerificationMatrix,
  comparableSignalOf,
  describeVerificationDisclosure,
  genericItemLabel,
  isAdministrativeCustodyEventType,
  isForensicIntegrityCustodyEventType,
  multipartRecordKindLabel,
  otsAdvanceSinceIssue,
  parseVerificationDisclosurePolicy,
  signalMovement,
  snapshotAnchoringAtIssue,
  toVerificationStatus,
  VERIFICATION_QUALIFIERS,
} from "../dist/index.js";

test("a stored disclosure policy is read fail closed", () => {
  assert.deepEqual(parseVerificationDisclosurePolicy(null), { mode: "VERIFICATION_ONLY", showRecordedLocation: false });
  assert.deepEqual(parseVerificationDisclosurePolicy({ verificationDisclosureMode: "PUBLISHED" }), { mode: "VERIFICATION_ONLY", showRecordedLocation: false });
  // Location counts only with content preview.
  assert.deepEqual(parseVerificationDisclosurePolicy({ verificationDisclosureMode: "VERIFICATION_ONLY", showRecordedLocation: true }), {
    mode: "VERIFICATION_ONLY",
    showRecordedLocation: false,
  });
  assert.deepEqual(parseVerificationDisclosurePolicy({ verificationDisclosureMode: "CONTENT_PREVIEW", showRecordedLocation: true }), {
    mode: "CONTENT_PREVIEW",
    showRecordedLocation: true,
  });
  assert.deepEqual(parseVerificationDisclosurePolicy({ verificationDisclosureMode: "CONTENT_PREVIEW", showRecordedLocation: "yes" }), {
    mode: "CONTENT_PREVIEW",
    showRecordedLocation: false,
  });
});

test("the withheld sentence, generic labels and multipart description are fixed", () => {
  assert.equal(WITHHELD_BY_DISCLOSURE_POLICY, "Withheld by the record’s disclosure policy");
  assert.equal(genericItemLabel(0), "Item 1");
  assert.equal(genericItemLabel(5), "Item 6");
  assert.equal(multipartRecordKindLabel(6), "Multipart package · 6 items");
});

test("the visitor preview never promises downloads and names location only when enabled", () => {
  const vo = describeVerificationDisclosure({ mode: "VERIFICATION_ONLY", showRecordedLocation: false });
  assert.ok(vo.withheld.some((w) => /file names/.test(w)));
  assert.ok(vo.never.some((n) => /Original file downloads/.test(n)));
  const cpNoLoc = describeVerificationDisclosure({ mode: "CONTENT_PREVIEW", showRecordedLocation: false });
  assert.deepEqual(cpNoLoc.withheld, ["Recorded location"]);
  const cpLoc = describeVerificationDisclosure({ mode: "CONTENT_PREVIEW", showRecordedLocation: true });
  assert.ok(cpLoc.shown.some((s) => /Recorded \(device-reported\) location/.test(s)));
  assert.equal(JSON.stringify(cpLoc).includes("verified location"), false);
});

const BASE = {
  verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
  recordedIntegrityVerifiedAtUtc: "2026-10-01T00:00:00.000Z",
  fileSha256: "a".repeat(64),
  fingerprintHash: "b".repeat(64),
  signatureBase64: "c2ln",
  signingKeyId: "k",
  publicKeyPem: "pem",
  otsProofBase64: null,
  signatureVerified: true,
  custodyChainValid: true,
};
const tsaRowOf = (evidence) =>
  buildVerificationMatrix({
    signals: buildEvidenceTrustDecision({ evidence: { ...BASE, ...evidence }, custodyEvents: [] }).signals,
    identity: null,
    acquisitionMode: null,
    packageSeal: { kind: "NONE" },
    publication: { kind: "DOCUMENT" },
  }).rows.find((r) => r.key === "tsa_token");

test("TSA: a token validated later from the copy retained at intake is VERIFIED and says so, with its validation time", () => {
  const row = tsaRowOf({ tsaStatus: "STAMPED", tsaValidatedAtUtc: "2026-10-12T08:00:00.000Z", tsaTokenPresent: true, tsaValidatedFromRetainedToken: true });
  assert.equal(row.status, "VERIFIED");
  assert.equal(row.statusLabel, "Verified — validated from the timestamp token retained at intake");
  assert.deepEqual(row.qualifiers, ["VALIDATED_FROM_RETAINED_TOKEN"]);
  assert.equal(row.measuredAtUtc, "2026-10-12T08:00:00.000Z");
});

test("TSA: a kept token not yet validated is NOT_CHECKED with TOKEN_KEPT_NOT_VALIDATED; FAILED with no token stays FAILED-not-obtained", () => {
  const kept = tsaRowOf({ tsaStatus: "FAILED", tsaTokenPresent: true, tsaFailureCode: "tsa_trust_anchor_not_configured" });
  assert.equal(kept.status, "NOT_CHECKED");
  assert.deepEqual(kept.qualifiers, ["TOKEN_KEPT_NOT_VALIDATED"]);
  const none = tsaRowOf({ tsaStatus: "FAILED", tsaTokenPresent: false });
  assert.notEqual(none.status, "VERIFIED");
  assert.equal(none.qualifiers, undefined);
  // The retained-token marker cannot upgrade a token that was never validated.
  const marker = tsaRowOf({ tsaStatus: "FAILED", tsaTokenPresent: true, tsaValidatedFromRetainedToken: true });
  assert.equal(marker.status, "NOT_CHECKED");
});

test("a qualifier never changes a status: the status is the state's projection alone", () => {
  assert.deepEqual([...VERIFICATION_QUALIFIERS].sort(), [
    "ATTESTATION_RECORDED",
    "LEGACY_SEAL",
    "PENDING",
    "TOKEN_KEPT_NOT_VALIDATED",
    "VALIDATED_FROM_RETAINED_TOKEN",
    "VERIFIER_UNAVAILABLE",
  ]);
  const forged = buildVerificationMatrix({
    signals: [{ key: "bitcoin_anchoring", state: "PRESENT_NOT_INDEPENDENTLY_VERIFIED", qualifiers: ["VALIDATED_FROM_RETAINED_TOKEN"] }],
    identity: null,
    acquisitionMode: null,
    packageSeal: { kind: "NONE" },
    publication: { kind: "DOCUMENT" },
  }).rows.find((r) => r.key === "ots_anchoring");
  assert.equal(forged.status, "NOT_CHECKED");
  assert.equal(toVerificationStatus("PRESENT_NOT_INDEPENDENTLY_VERIFIED"), "NOT_CHECKED");
});

test("comparison reads canonical states, never words", () => {
  const before = { key: "core_integrity", state: "PASSED", status: "passed", summary: "Core integrity verified", detail: "old words" };
  const after = { key: "core_integrity", state: "PASSED", status: "passed", summary: "File integrity verified", detail: "new words", tone: "success" };
  assert.equal(signalMovement(before, after), "SAME");
  // Legacy shapes: passed → VERIFIED, partial → NOT_CHECKED.
  assert.equal(comparableSignalOf({ key: "signature", status: "passed" }).status, "VERIFIED");
  assert.equal(comparableSignalOf({ key: "signature", status: "partial" }).status, "NOT_CHECKED");
  // A kept token validated later is an advance, not an alarm.
  assert.equal(
    signalMovement({ key: "trusted_timestamp", state: "PRESENT_NOT_INDEPENDENTLY_VERIFIED" }, { key: "trusted_timestamp", state: "PASSED" }),
    "ADVANCED",
  );
  // A failure now is the only regression.
  assert.equal(signalMovement({ key: "core_integrity", state: "PASSED" }, { key: "core_integrity", state: "FAILED" }), "REGRESSED");
  // OTS: an attestation recorded then and an unavailable verifier now are the same progress.
  assert.equal(
    signalMovement(
      { key: "bitcoin_anchoring", status: "passed", summary: "Anchored" },
      { key: "bitcoin_anchoring", state: "PRESENT_NOT_INDEPENDENTLY_VERIFIED", otsVerification: "CHAIN_UNAVAILABLE" },
    ),
    "SAME",
  );
  assert.equal(
    signalMovement({ key: "bitcoin_anchoring", status: "passed" }, { key: "bitcoin_anchoring", state: "PASSED", otsVerification: "CHAIN_VERIFIED" }),
    "ADVANCED",
  );
});

test("issue-time anchoring: recorded otsState first, then the snapshot's own Bitcoin signal, never the record now", () => {
  assert.deepEqual(snapshotAnchoringAtIssue({ otsState: "PENDING" }, null), { otsState: "PENDING", otsVerification: "PENDING", source: "SNAPSHOT_OTS_STATE" });
  const legacy = snapshotAnchoringAtIssue({ provider: "opentimestamps" }, { signals: [{ key: "bitcoin_anchoring", status: "passed", summary: "Anchored" }] });
  assert.deepEqual(legacy, { otsState: "ANCHORED", otsVerification: "ATTESTATION_RECORDED", source: "SNAPSHOT_BITCOIN_SIGNAL" });
  assert.deepEqual(snapshotAnchoringAtIssue({ otsStatus: "CONFIRMED" }, { signals: [] }), {
    otsState: "ANCHORED",
    otsVerification: "ATTESTATION_RECORDED",
    source: "SNAPSHOT_OTS_STATUS",
  });
  assert.equal(snapshotAnchoringAtIssue(null, null).otsState, "UNAVAILABLE");
});

test("an attestation already recorded at issue did not advance since; a chain verification did", () => {
  assert.equal(otsAdvanceSinceIssue("ATTESTATION_RECORDED", "ATTESTATION_RECORDED"), "NONE");
  assert.equal(otsAdvanceSinceIssue("ATTESTATION_RECORDED", "CHAIN_UNAVAILABLE"), "NONE");
  assert.equal(otsAdvanceSinceIssue("ATTESTATION_RECORDED", "CHAIN_VERIFIED"), "CHAIN_VERIFIED_SINCE_ISSUE");
  assert.equal(otsAdvanceSinceIssue("PENDING", "ATTESTATION_RECORDED"), "ATTESTATION_RECORDED_SINCE_ISSUE");
  assert.equal(otsAdvanceSinceIssue("CHAIN_VERIFIED", "ATTESTATION_RECORDED"), "NONE");
});

test("reference issuance and disclosure changes are administrative, never forensic-integrity changes", () => {
  for (const t of ["VERIFICATION_REFERENCE_ISSUED", "VERIFICATION_DISCLOSURE_CHANGED", "VERIFICATION_ACCESS_WITHDRAWN", "PUBLIC_VERIFY_PUBLISHED"]) {
    assert.equal(isAdministrativeCustodyEventType(t), true, t);
    assert.equal(isForensicIntegrityCustodyEventType(t), false, t);
  }
  assert.equal(isForensicIntegrityCustodyEventType("SIGNATURE_APPLIED"), true);
  assert.equal(isForensicIntegrityCustodyEventType("VERIFY_VIEWED"), false);
});
