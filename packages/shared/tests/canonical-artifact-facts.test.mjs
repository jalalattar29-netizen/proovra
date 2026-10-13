/**
 * CANONICAL ARTIFACT FACTS — outputs are checked against the RECORD, not
 * against the projection that produced them (2026-10-07). OpenTimestamps facts
 * come from real proof bytes (2026-10-13): the state is what the stored proof
 * executes to against the fingerprint digest.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  OTS_ANCHORED_BOUNDARY,
  OTS_STATE_SENTENCES,
  TSA_VALIDATED_QUALIFICATION_STATEMENT,
  VERIFICATION_LIMITATION,
  VERIFICATION_MATRIX_SCHEMA,
  checkRenderedReportText,
  checkSealedPackageFacts,
  compareCanonicalFacts,
  deriveCanonicalArtifactFacts,
} from "../dist/index.js";
import { REAL, proofSha256, upgradedProof } from "./helpers/ots-fixtures.mjs";

const SHA = "a".repeat(64);
const FP = REAL.boundFingerprintHash;
/** A real `ots stamp` proof upgraded with a Bitcoin branch: ANCHORED. */
const ANCHORED_PROOF = upgradedProof();
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
      fingerprintHash: FP,
      otsHash: FP,
      otsProofBase64: ANCHORED_PROOF.base64,
      ...over,
    },
    [snapshotEvent],
  );
/** The same record while its proof is still the real pending one. */
const pendingRecord = (over = {}) =>
  record({ otsStatus: "PENDING", otsAnchoredAtUtc: null, otsProofBase64: REAL.boundProofBase64, ...over });

test("the record's facts come from the shared resolvers", () => {
  const f = record();
  assert.equal(f.tsaState, "PASSED");
  assert.equal(f.otsState, "ANCHORED");
  assert.equal(f.otsProofSha256, ANCHORED_PROOF.proofSha256);
  assert.equal(f.otsFailureCode, null);
  assert.equal(f.acquisition.basis, "OBSERVED_AT_CAPTURE");
  assert.equal(f.acquisition.actorKind, "ACCOUNT_USER");
  assert.equal(f.evidenceFileSha256, SHA);
  // A txid-less upgraded proof is still ANCHORED: the proof decides, not a txid.
  assert.equal(record({ otsProofBase64: upgradedProof({ withTransaction: false }).base64 }).otsState, "ANCHORED");
  // Status ANCHORED over the real pending proof is PENDING — never inferred from status or time.
  const pending = record({ otsProofBase64: REAL.boundProofBase64 });
  assert.equal(pending.otsState, "PENDING");
  assert.equal(pending.otsProofSha256, proofSha256(REAL.boundProofBase64));
  // A proof that commits to another digest is FAILED; missing proof material is UNAVAILABLE.
  const other = record({ otsProofBase64: REAL.otherProofBase64 });
  assert.equal(other.otsState, "FAILED");
  assert.equal(other.otsFailureCode, "PROOF_HASH_MISMATCH");
  const missing = record({ otsProofBase64: null });
  assert.equal(missing.otsState, "UNAVAILABLE");
  assert.equal(missing.otsFailureCode, "PROOF_MATERIAL_MISSING");
  assert.equal(record({ otsStatus: null, otsProofBase64: null }).otsState, "NOT_REQUESTED");
  // A STAMPED row without a validation time is not a validated timestamp.
  assert.notEqual(record({ tsaValidatedAtUtc: null }).tsaState, "PASSED");
});

test("BEFORE RENDERING: a payload that disagrees with the record is refused", () => {
  assert.deepEqual(compareCanonicalFacts(record(), record()), []);
  // The payload says pending while the record's proof is anchored (and vice versa).
  assert.ok(compareCanonicalFacts(record(), pendingRecord()).some((f) => f.check === "OTS_STATE"));
  assert.ok(compareCanonicalFacts(pendingRecord(), record()).some((f) => f.check === "OTS_STATE"));
  // Same state, another proof: the payload's proof is not the record's.
  const otherAnchor = record({ otsProofBase64: upgradedProof({ blockHeight: 900_000 }).base64 });
  assert.equal(otherAnchor.otsState, "ANCHORED");
  const proof = compareCanonicalFacts(record(), otherAnchor);
  assert.ok(proof.some((f) => f.check === "OTS_PROOF"));
  assert.ok(!proof.some((f) => f.check === "OTS_STATE"));
  const identity = compareCanonicalFacts(record(), { ...record(), acquisition: { ...record().acquisition, identityLevel: "ORGANIZATION_ACCOUNT" } });
  assert.ok(identity.some((f) => f.check === "IDENTITY"));
});

/** The Bitcoin anchoring card as the report prints it for each state. */
const otsCard = (facts) =>
  facts.otsState === "ANCHORED"
    ? `Bitcoin anchoring Anchored ${OTS_STATE_SENTENCES.ANCHORED} ${OTS_ANCHORED_BOUNDARY}`
    : `Bitcoin anchoring Pending ${OTS_STATE_SENTENCES[facts.otsState]}`;

const goodText = (facts) =>
  [
    "PROOVRA Verification Report v1",
    `SHA-256 ${SHA}`,
    facts.tsaState === "PASSED" ? `RFC 3161 timestamp verified. ${TSA_VALIDATED_QUALIFICATION_STATEMENT}` : "Timestamp token obtained; not validated",
    otsCard(facts),
    VERIFICATION_LIMITATION,
  ].join("\n");

test("AFTER RENDERING: the PDF text states the facts and nothing stronger", () => {
  const f = record();
  const pending = pendingRecord();
  assert.deepEqual(checkRenderedReportText(goodText(f), f, { reportVersion: 1 }), []);
  assert.deepEqual(checkRenderedReportText(goodText(pending), pending, { reportVersion: 1 }), []);
  // ANCHORED requires "Bitcoin anchoring", the anchored sentence and the boundary.
  const noSentence = checkRenderedReportText(goodText(f).replace(OTS_STATE_SENTENCES.ANCHORED, ""), f, { reportVersion: 1 });
  assert.ok(noSentence.some((x) => x.check === "OTS_ANCHORED"));
  const noTitle = checkRenderedReportText(goodText(f).replace("Bitcoin anchoring Anchored", "Anchored"), f, { reportVersion: 1 });
  assert.ok(noTitle.some((x) => x.check === "OTS_ANCHORED"));
  const noBoundary = checkRenderedReportText(goodText(f).replace(OTS_ANCHORED_BOUNDARY, ""), f, { reportVersion: 1 });
  assert.ok(noBoundary.some((x) => x.check === "OTS_BOUNDARY"));
  // A proof that is not anchored may never read as anchored.
  const over = checkRenderedReportText(`${goodText(pending)}\n${OTS_STATE_SENTENCES.ANCHORED}`, pending, { reportVersion: 1 });
  assert.ok(over.some((x) => x.check === "OTS_OVERCLAIM"));
  // The retired chain-verifier / attestation wording is refused in every state, anchored included.
  for (const retired of [
    "Attestation recorded",
    "Bitcoin attestation independently verified",
    "independently verified against the Bitcoin blockchain",
    "OpenTimestamps Bitcoin anchoring verified",
    "OpenTimestamps proof anchored to a Bitcoin block",
    "OTS ANCHORED AT (UTC)",
    "not independently chain-verified",
  ]) {
    assert.ok(checkRenderedReportText(`${goodText(f)} ${retired}`, f, { reportVersion: 1 }).some((x) => x.check === "OTS_RETIRED_WORDING"), retired);
    assert.ok(
      checkRenderedReportText(`${goodText(pending)} ${retired}`, pending, { reportVersion: 1 }).some((x) => x.check === "OTS_RETIRED_WORDING"),
      retired,
    );
  }
  // A validated timestamp must carry the qualification boundary.
  const missing = checkRenderedReportText(goodText(f).replace(TSA_VALIDATED_QUALIFICATION_STATEMENT, ""), f, { reportVersion: 1 });
  assert.ok(missing.some((x) => x.check === "TSA_VALIDATED"));
  // An unvalidated timestamp may never read as validated.
  const unvalidated = record({ tsaValidatedAtUtc: null, tsaStatus: "FAILED", tsaFailureCode: "tsa_trust_anchor_not_configured" });
  const tsaOver = checkRenderedReportText(`${goodText(unvalidated)}\nRFC 3161 timestamp verified`, unvalidated, { reportVersion: 1 });
  assert.ok(tsaOver.some((x) => x.check === "TSA_OVERCLAIM"));
  // Raw codes, storage keys, a missing digest or version are findings.
  const raw = checkRenderedReportText(`${goodText(f)}\nORGANIZATION_ACCOUNT reports/00000000-0000-4000-8000-000000000000/v1/x.pdf`, f, { reportVersion: 1 });
  assert.ok(raw.some((x) => x.check === "RAW_CODE"));
  assert.ok(raw.some((x) => x.check === "INFRASTRUCTURE"));
  assert.ok(checkRenderedReportText(`${goodText(f)}\nCHAIN_VERIFIED`, f, { reportVersion: 1 }).some((x) => x.check === "RAW_CODE"));
  assert.ok(checkRenderedReportText("nothing", f, { reportVersion: 3 }).some((x) => x.check === "REPORT_VERSION"));
  // A score, a weighted point or an overall verdict is a finding; so is a
  // report without the verification limitation.
  for (const claim of ["Score 96/100", "STRONGLY_VERIFIED", "Reviewer reliance: High", "Passed signals: Core integrity"]) {
    assert.ok(checkRenderedReportText(`${goodText(f)}\n${claim}`, f, { reportVersion: 1 }).some((x) => x.check === "FORBIDDEN_CLAIM"), claim);
  }
  assert.ok(checkRenderedReportText(goodText(f).replace(VERIFICATION_LIMITATION, ""), f, { reportVersion: 1 }).some((x) => x.check === "LIMITATION"));
  // The PENDING sentence beside an anchored proof is a contradiction; the
  // retired "still being prepared" sentence is refused outright.
  const contradiction = checkRenderedReportText(`${goodText(f)}\n${OTS_STATE_SENTENCES.PENDING}`, f, { reportVersion: 1 });
  assert.ok(contradiction.some((x) => x.check === "OTS_CONTRADICTION"));
  const prepared = checkRenderedReportText(`${goodText(f)}\nThe anchoring proof is still being prepared.`, f, { reportVersion: 1 });
  assert.ok(prepared.some((x) => x.check === "OTS_RETIRED_WORDING"));
  // (2026-10-13) A retired matrix card is refused.
  for (const card of ["Pre-PROOVRA provenance", "Package completeness", "Public Verify publication"]) {
    assert.ok(
      checkRenderedReportText(`${goodText(f)}\n${card} Not checked`, f, { reportVersion: 1 }).some((x) => x.check === "RETIRED_SIGNAL"),
      card,
    );
  }
  // A line break after a hyphen is layout: the qualification still reads whole.
  const wrapped = goodText(f).replace("qualified-service", "qualified-\nservice");
  assert.deepEqual(checkRenderedReportText(wrapped, f, { reportVersion: 1 }), []);
});

const matrixDoc = (otsState, otsStatus) => ({
  schema: VERIFICATION_MATRIX_SCHEMA,
  rows: [
    { key: "ots_anchoring", label: "OTS", status: otsStatus, otsState, statement: "", measuredAtUtc: null },
    { key: "tsa_token", label: "TSA", status: "VERIFIED", statement: "", measuredAtUtc: null },
  ],
  summary: "",
  limitation: "",
});

test("AFTER SEALING: sealed documents that disagree with the record are findings", () => {
  const f = record();
  const docs = new Map([
    ["package-manifest.json", { otsState: "ANCHORED", evidenceFileSha256: SHA }],
    ["trust-decision.json", matrixDoc("ANCHORED", "VERIFIED")],
    ["opentimestamps.json", { state: "ANCHORED", proof: { sha256: ANCHORED_PROOF.proofSha256 } }],
    ["timestamp-validation.json", { trustState: "PASSED" }],
    ["case-metadata.json", { submitter: { acquisitionIdentity: { basis: "OBSERVED_AT_CAPTURE", actorKind: "ACCOUNT_USER", accountRole: "SUBMITTER", workspaceKind: "PERSONAL", emailVerified: true, organizationVerified: null } } }],
  ]);
  assert.deepEqual(checkSealedPackageFacts(docs, f), []);
  // The documents agree with each other but not with the record: caught.
  const wrong = new Map(docs);
  wrong.set("package-manifest.json", { otsState: "PENDING", evidenceFileSha256: SHA });
  wrong.set("trust-decision.json", matrixDoc("PENDING", "NOT_CHECKED"));
  wrong.set("opentimestamps.json", { state: "PENDING", proof: { sha256: proofSha256(REAL.boundProofBase64) } });
  assert.equal(checkSealedPackageFacts(wrong, f).filter((x) => x.check === "OTS_STATE").length, 3);
  // The retired field is flagged even when it says false.
  const retired = new Map(docs);
  retired.set("package-manifest.json", { otsState: "ANCHORED", publicAnchoringVerified: false, evidenceFileSha256: SHA });
  assert.deepEqual(checkSealedPackageFacts(retired, f).map((x) => x.check), ["OTS_RETIRED_FIELD"]);
  // A manifest without otsState is not the record's state.
  const noState = new Map(docs);
  noState.set("package-manifest.json", { evidenceFileSha256: SHA });
  assert.deepEqual(checkSealedPackageFacts(noState, f).map((x) => x.check), ["OTS_STATE"]);
  // opentimestamps.json is required whenever anchoring was requested, and must carry the record's proof.
  const noOts = new Map(docs);
  noOts.delete("opentimestamps.json");
  assert.deepEqual(checkSealedPackageFacts(noOts, f).map((x) => x.check), ["OTS_RECORD"]);
  const otherProof = new Map(docs);
  otherProof.set("opentimestamps.json", { state: "ANCHORED", proof: { sha256: upgradedProof({ blockHeight: 1 }).proofSha256 } });
  assert.deepEqual(checkSealedPackageFacts(otherProof, f).map((x) => x.check), ["OTS_PROOF"]);
  // A legacy matrix row without its state reads Unavailable — never anchored.
  const legacyRow = new Map(docs);
  legacyRow.set("trust-decision.json", matrixDoc(undefined, "VERIFIED"));
  assert.ok(checkSealedPackageFacts(legacyRow, f).some((x) => x.check === "OTS_STATE"));
  const identity = new Map(docs);
  identity.set("case-metadata.json", { submitter: { acquisitionIdentity: { basis: "OBSERVED_AT_CAPTURE", actorKind: "INTAKE_CONTRIBUTOR", accountRole: "SUBMITTER", workspaceKind: "PERSONAL", emailVerified: true, organizationVerified: null } } });
  assert.ok(checkSealedPackageFacts(identity, f).some((x) => x.check === "IDENTITY"));
});

test("DIGEST BINDING from real proof bytes: only a proof committing to the fingerprint digest is usable", () => {
  assert.equal(pendingRecord().otsState, "PENDING");
  assert.equal(record().otsState, "ANCHORED");
  // A real proof that commits to another digest is FAILED whatever the status
  // column claims — and so is a Bitcoin-attested proof for that other digest.
  for (const otsProofBase64 of [REAL.otherProofBase64, upgradedProof({ base64: REAL.otherProofBase64 }).base64]) {
    for (const otsStatus of ["PENDING", "ANCHORED"]) {
      const other = record({ otsStatus, otsProofBase64 });
      assert.equal(other.otsState, "FAILED");
      assert.equal(other.otsFailureCode, "PROOF_HASH_MISMATCH");
    }
  }
  // The record's OTS hash naming another digest is a mismatch too.
  const otsHash = record({ otsHash: REAL.otherDigest });
  assert.equal(otsHash.otsState, "FAILED");
  assert.equal(otsHash.otsFailureCode, "PROOF_HASH_MISMATCH");
  // Unreadable bytes are FAILED MALFORMED_PROOF; a proof with no digest to bind is UNAVAILABLE.
  const unreadable = record({ otsProofBase64: "cHJvb2Y=" });
  assert.equal(unreadable.otsState, "FAILED");
  assert.equal(unreadable.otsFailureCode, "MALFORMED_PROOF");
  const noDigest = record({ fingerprintHash: null, otsHash: null });
  assert.equal(noDigest.otsState, "UNAVAILABLE");
  assert.equal(noDigest.otsFailureCode, "FINGERPRINT_MISSING");
});
