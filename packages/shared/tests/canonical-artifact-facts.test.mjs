/**
 * CANONICAL ARTIFACT FACTS — outputs are checked against the RECORD, not
 * against the projection that produced them (2026-10-07).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  TSA_VALIDATED_QUALIFICATION_STATEMENT,
  checkRenderedReportText,
  checkSealedPackageFacts,
  compareCanonicalFacts,
  deriveCanonicalArtifactFacts,
} from "../dist/index.js";

const SHA = "a".repeat(64);
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
  assert.equal(record({ otsAnchorCheck: "BITCOIN_VERIFIED" }).otsState, "PASSED");
  // A STAMPED row without a validation time is not a validated timestamp.
  assert.notEqual(record({ tsaValidatedAtUtc: null }).tsaState, "PASSED");
});

test("BEFORE RENDERING: a payload that disagrees with the record is refused", () => {
  assert.deepEqual(compareCanonicalFacts(record(), record()), []);
  const findings = compareCanonicalFacts(record(), record({ otsAnchorCheck: "BITCOIN_VERIFIED" }));
  assert.ok(findings.some((f) => f.check === "OTS_STATE"));
  const identity = compareCanonicalFacts(record(), { ...record(), acquisition: { ...record().acquisition, identityLevel: "ORGANIZATION_ACCOUNT" } });
  assert.ok(identity.some((f) => f.check === "IDENTITY"));
});

const goodText = (facts) =>
  [
    "PROOVRA Verification Report v1",
    `SHA-256 ${SHA}`,
    facts.tsaState === "PASSED" ? `RFC 3161 timestamp validated. ${TSA_VALIDATED_QUALIFICATION_STATEMENT}` : "Timestamp token obtained; not validated",
    "Anchoring proof present; not independently chain-verified",
  ].join("\n");

test("AFTER RENDERING: the PDF text states the facts and nothing stronger", () => {
  const f = record();
  assert.deepEqual(checkRenderedReportText(goodText(f), f, { reportVersion: 1 }), []);
  // An anchor not chain-checked may never read as verified.
  const over = checkRenderedReportText(`${goodText(f)}\nAnchored in Bitcoin; verified against the Bitcoin chain`, f, { reportVersion: 1 });
  assert.ok(over.some((x) => x.check === "OTS_OVERCLAIM"));
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
});

test("AFTER SEALING: sealed documents that disagree with the record are findings", () => {
  const f = record();
  const docs = new Map([
    ["package-manifest.json", { publicAnchoringVerified: false, evidenceFileSha256: SHA }],
    ["trust-decision.json", { signals: [{ key: "bitcoin_anchoring", state: "PRESENT_NOT_INDEPENDENTLY_VERIFIED" }, { key: "trusted_timestamp", state: "PASSED" }] }],
    ["timestamp-validation.json", { trustState: "PASSED" }],
    ["case-metadata.json", { submitter: { acquisitionIdentity: { basis: "OBSERVED_AT_CAPTURE", actorKind: "ACCOUNT_USER", accountRole: "SUBMITTER", workspaceKind: "PERSONAL", emailVerified: true, organizationVerified: null } } }],
  ]);
  assert.deepEqual(checkSealedPackageFacts(docs, f), []);
  // The documents agree with each other but not with the record: caught.
  const wrong = new Map(docs);
  wrong.set("package-manifest.json", { publicAnchoringVerified: true, evidenceFileSha256: SHA });
  wrong.set("trust-decision.json", { signals: [{ key: "bitcoin_anchoring", state: "PASSED" }, { key: "trusted_timestamp", state: "PASSED" }] });
  const findings = checkSealedPackageFacts(wrong, f);
  assert.ok(findings.filter((x) => x.check === "OTS_STATE").length >= 2);
  const identity = new Map(docs);
  identity.set("case-metadata.json", { submitter: { acquisitionIdentity: { basis: "OBSERVED_AT_CAPTURE", actorKind: "INTAKE_CONTRIBUTOR", accountRole: "SUBMITTER", workspaceKind: "PERSONAL", emailVerified: true, organizationVerified: null } } });
  assert.ok(checkSealedPackageFacts(identity, f).some((x) => x.check === "IDENTITY"));
});
