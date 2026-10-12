/**
 * CANONICAL ARTIFACT FACTS — outputs are checked against the RECORD, not
 * against the projection that produced them (2026-10-07).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  TSA_VALIDATED_QUALIFICATION_STATEMENT,
  VERIFICATION_LIMITATION,
  VERIFICATION_MATRIX_SCHEMA,
  checkRenderedReportText,
  checkSealedPackageFacts,
  compareCanonicalFacts,
  deriveCanonicalArtifactFacts,
} from "../dist/index.js";

const SHA = "a".repeat(64);
const PROOFS = JSON.parse(readFileSync(new URL("./fixtures/ots-proofs.json", import.meta.url), "utf8"));
/** A complete, independently recorded chain check (test values, not a real verification). */
const CHAIN = {
  otsChainVerificationStatus: "VERIFIED",
  otsChainVerifiedAtUtc: "2026-10-01T03:00:00.000Z",
  otsChainBlockHeight: 970507,
  otsChainBlockHash: "00000000000000000001ec3f183cf87a623516376df048fed10a1696ed0f328f",
  otsChainBlockTimeUtc: "2026-10-01T01:24:48.000Z",
  otsChainConfirmations: 6,
  otsChainVerifier: "test-double/1",
};
const snapshotEvent = {
  eventType: "IDENTITY_SNAPSHOT_RECORDED",
  atUtc: "2026-10-01T00:00:00.000Z",
  payload: {
    identityLevelSnapshot: "VERIFIED_EMAIL",
    submittedByAuthProvider: "EMAIL",
    emailVerified: true,
    workspaceKind: "PERSONAL",
    actorKind: "ACCOUNT_USER",
    accountRole: "SUBMITTER",
  },
};
const record = (over = {}) =>
  deriveCanonicalArtifactFacts(
    {
      fileSha256: SHA,
      tsaStatus: "STAMPED",
      tsaValidatedAtUtc: "2026-10-01T00:00:01.000Z",
      tsaTokenPresent: true,
      otsStatus: "ANCHORED",
      otsAnchoredAtUtc: "2026-10-01T02:00:00.000Z",
      otsAnchorCheck: "PROOF_STRUCTURE",
      otsBitcoinTxid: "c".repeat(64),
      otsProofPresent: true,
      ...over,
    },
    [snapshotEvent],
  );

test("the record's facts come from the shared resolvers", () => {
  const f = record();
  assert.equal(f.tsaState, "PASSED");
  assert.equal(f.otsState, "PRESENT_NOT_INDEPENDENTLY_VERIFIED");
  assert.equal(f.acquisition.basis, "OBSERVED_AT_CAPTURE");
  assert.equal(f.acquisition.actorKind, "ACCOUNT_USER");
  assert.equal(f.evidenceFileSha256, SHA);
  // A chain check with no txid is never verified.
  assert.equal(record({ otsAnchorCheck: "BITCOIN_VERIFIED", otsBitcoinTxid: null }).otsState, "PRESENT_NOT_INDEPENDENTLY_VERIFIED");
  // A recorded chain check is PASSED only with its chain evidence recorded.
  assert.equal(record({ otsAnchorCheck: "BITCOIN_VERIFIED" }).otsState, "PRESENT_NOT_INDEPENDENTLY_VERIFIED");
  assert.equal(record({ otsAnchorCheck: "BITCOIN_VERIFIED", ...CHAIN }).otsState, "PASSED");
  assert.equal(record({ otsAnchorCheck: "BITCOIN_VERIFIED", ...CHAIN }).otsTruthState, "CHAIN_VERIFIED");
  assert.equal(f.otsTruthState, "ATTESTATION_PRESENT_NOT_VERIFIED");
  // A configured verifier that failed is FAILED; one that was unreachable is not a failure.
  assert.equal(record({ otsChainVerificationStatus: "FAILED", otsChainFailureCode: "ATTESTATION_NOT_IN_CHAIN" }).otsState, "FAILED");
  assert.equal(record({ otsChainVerificationStatus: "UNAVAILABLE" }).otsTruthState, "CHAIN_VERIFICATION_UNAVAILABLE");
  assert.equal(record({ otsChainVerificationStatus: "UNAVAILABLE" }).otsState, "PRESENT_NOT_INDEPENDENTLY_VERIFIED");
  // A STAMPED row without a validation time is not a validated timestamp.
  assert.notEqual(record({ tsaValidatedAtUtc: null }).tsaState, "PASSED");
});

test("BEFORE RENDERING: a payload that disagrees with the record is refused", () => {
  assert.deepEqual(compareCanonicalFacts(record(), record()), []);
  const findings = compareCanonicalFacts(record(), record({ otsAnchorCheck: "BITCOIN_VERIFIED", ...CHAIN }));
  assert.ok(findings.some((f) => f.check === "OTS_STATE"));
  const identity = compareCanonicalFacts(record(), { ...record(), acquisition: { ...record().acquisition, identityLevel: "ORGANIZATION_ACCOUNT" } });
  assert.ok(identity.some((f) => f.check === "IDENTITY"));
});

const goodText = (facts) =>
  [
    "PROOVRA Verification Report v1",
    `SHA-256 ${SHA}`,
    facts.tsaState === "PASSED" ? `RFC 3161 timestamp validated. ${TSA_VALIDATED_QUALIFICATION_STATEMENT}` : "Timestamp token obtained; not validated",
    // The OTS card of an attested, not independently verified proof.
    "OpenTimestamps Attestation recorded Independent Bitcoin verification was not performed.",
    VERIFICATION_LIMITATION,
  ].join("\n");

test("AFTER RENDERING: the PDF text states the facts and nothing stronger", () => {
  const f = record();
  assert.deepEqual(checkRenderedReportText(goodText(f), f, { reportVersion: 1 }), []);
  // An anchor not chain-checked may never read as verified.
  const over = checkRenderedReportText(`${goodText(f)}\nBitcoin attestation independently verified`, f, { reportVersion: 1 });
  assert.ok(over.some((x) => x.check === "OTS_OVERCLAIM"));
  // The retired "anchored" wording is refused in every state, verified included.
  const verified = record({ otsAnchorCheck: "BITCOIN_VERIFIED", ...CHAIN });
  for (const retired of ["OpenTimestamps proof anchored to a Bitcoin block", "OTS ANCHORED AT (UTC)", "Anchored in Bitcoin", "not independently chain-verified"]) {
    assert.ok(checkRenderedReportText(`${goodText(f)} ${retired}`, f, { reportVersion: 1 }).some((x) => x.check === "OTS_RETIRED_WORDING"), retired);
    assert.ok(checkRenderedReportText(`${goodText(verified)} ${retired}`, verified, { reportVersion: 1 }).some((x) => x.check === "OTS_RETIRED_WORDING"), retired);
  }
  // A validated timestamp must carry the qualification boundary.
  const missing = checkRenderedReportText(goodText(f).replace(TSA_VALIDATED_QUALIFICATION_STATEMENT, ""), f, { reportVersion: 1 });
  assert.ok(missing.some((x) => x.check === "TSA_VALIDATED"));
  // An unvalidated timestamp may never read as validated.
  const unvalidated = record({ tsaValidatedAtUtc: null, tsaStatus: "FAILED", tsaFailureCode: "tsa_trust_anchor_not_configured" });
  const tsaOver = checkRenderedReportText(`${goodText(unvalidated)}\nRFC 3161 timestamp validated`, unvalidated, { reportVersion: 1 });
  assert.ok(tsaOver.some((x) => x.check === "TSA_OVERCLAIM"));
  // Raw codes, storage keys, a missing digest or version are findings.
  const raw = checkRenderedReportText(`${goodText(f)}\nORGANIZATION_ACCOUNT reports/00000000-0000-4000-8000-000000000000/v1/x.pdf`, f, { reportVersion: 1 });
  assert.ok(raw.some((x) => x.check === "RAW_CODE"));
  assert.ok(raw.some((x) => x.check === "INFRASTRUCTURE"));
  assert.ok(checkRenderedReportText("nothing", f, { reportVersion: 3 }).some((x) => x.check === "REPORT_VERSION"));
  // A score, a weighted point or an overall verdict is a finding; so is a
  // report without the verification limitation.
  for (const claim of ["Score 96/100", "STRONGLY_VERIFIED", "Reviewer reliance: High", "Passed signals: Core integrity"]) {
    assert.ok(checkRenderedReportText(`${goodText(f)}\n${claim}`, f, { reportVersion: 1 }).some((x) => x.check === "FORBIDDEN_CLAIM"), claim);
  }
  assert.ok(checkRenderedReportText(goodText(f).replace(VERIFICATION_LIMITATION, ""), f, { reportVersion: 1 }).some((x) => x.check === "LIMITATION"));
});

test("AFTER SEALING: sealed documents that disagree with the record are findings", () => {
  const f = record();
  const docs = new Map([
    ["package-manifest.json", { publicAnchoringVerified: false, evidenceFileSha256: SHA }],
    ["trust-decision.json", { schema: VERIFICATION_MATRIX_SCHEMA, rows: [{ key: "ots_anchoring", label: "OTS", status: "NOT_CHECKED", statement: "", measuredAtUtc: null }, { key: "tsa_token", label: "TSA", status: "VERIFIED", statement: "", measuredAtUtc: null }], summary: "", limitation: "" }],
    ["timestamp-validation.json", { trustState: "PASSED" }],
    ["case-metadata.json", { submitter: { acquisitionIdentity: { basis: "OBSERVED_AT_CAPTURE", actorKind: "ACCOUNT_USER", accountRole: "SUBMITTER", workspaceKind: "PERSONAL", emailVerified: true, organizationVerified: null } } }],
  ]);
  assert.deepEqual(checkSealedPackageFacts(docs, f), []);
  // The documents agree with each other but not with the record: caught.
  const wrong = new Map(docs);
  wrong.set("package-manifest.json", { publicAnchoringVerified: true, evidenceFileSha256: SHA });
  wrong.set("trust-decision.json", { schema: VERIFICATION_MATRIX_SCHEMA, rows: [{ key: "ots_anchoring", label: "OTS", status: "VERIFIED", statement: "", measuredAtUtc: null }, { key: "tsa_token", label: "TSA", status: "VERIFIED", statement: "", measuredAtUtc: null }], summary: "", limitation: "" });
  const findings = checkSealedPackageFacts(wrong, f);
  assert.ok(findings.filter((x) => x.check === "OTS_STATE").length >= 2);
  const identity = new Map(docs);
  identity.set("case-metadata.json", { submitter: { acquisitionIdentity: { basis: "OBSERVED_AT_CAPTURE", actorKind: "INTAKE_CONTRIBUTOR", accountRole: "SUBMITTER", workspaceKind: "PERSONAL", emailVerified: true, organizationVerified: null } } });
  assert.ok(checkSealedPackageFacts(identity, f).some((x) => x.check === "IDENTITY"));
});

test("DIGEST BINDING from real proof bytes: only a proof committing to the fingerprint digest is usable", () => {
  const base = { fingerprintHash: PROOFS.boundFingerprintHash, otsHash: PROOFS.boundFingerprintHash };
  const bound = record({ ...base, otsProofBase64: PROOFS.boundProofBase64 });
  assert.equal(bound.otsDigestBinding, "MATCH");
  assert.equal(bound.otsTruthState, "ATTESTATION_PRESENT_NOT_VERIFIED");
  // A real proof that commits to another digest is PROOF_INVALID whatever the
  // status column claims — never anchored, attested or verified.
  for (const over of [{}, { otsAnchorCheck: "BITCOIN_VERIFIED", ...CHAIN }]) {
    const other = record({ ...base, ...over, otsProofBase64: PROOFS.otherProofBase64 });
    assert.equal(other.otsDigestBinding, "MISMATCH");
    assert.equal(other.otsTruthState, "PROOF_INVALID");
    assert.equal(other.otsState, "FAILED");
  }
  // The record's OTS hash naming another digest is a mismatch too.
  assert.equal(
    record({ fingerprintHash: PROOFS.boundFingerprintHash, otsHash: PROOFS.otherDigest, otsProofBase64: PROOFS.boundProofBase64 }).otsDigestBinding,
    "MISMATCH",
  );
  // Unreadable bytes are invalid; no bytes supplied is "not evaluated".
  assert.equal(record({ ...base, otsProofBase64: "cHJvb2Y=" }).otsTruthState, "PROOF_INVALID");
  assert.equal(record().otsDigestBinding, "NOT_EVALUATED");
});
