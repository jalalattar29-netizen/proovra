/**
 * THE VERIFICATION MATRIX — what every customer-facing surface states.
 *
 * Per-signal statuses only (VERIFIED | FAILED | NOT_CHECKED | NOT_APPLICABLE |
 * UNAVAILABLE), no score, a bounded summary and a fixed limitation. These
 * cases pin the claims policy of 2026-10-08.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  TSA_VALIDATED_QUALIFICATION_STATEMENT,
  VERIFICATION_LIMITATION,
  buildEvidenceTrustDecision,
  buildVerificationMatrix,
  findForbiddenCustomerClaims,
  parseVerificationMatrix,
} from "../dist/index.js";

import { REAL, upgradedProof } from "./helpers/ots-fixtures.mjs";

/**
 * (2026-10-13) The OTS row is the canonical anchoring state resolved from real
 * proof bytes: by default the record carries a real `ots stamp` proof
 * upgraded with a Bitcoin branch (ANCHORED); the bare stamped proof is PENDING.
 */
const FP = REAL.boundFingerprintHash;
const ANCHORED_PROOF = upgradedProof();

const forensic = Array.from({ length: 6 }, (_, i) => ({
  eventType: `FORENSIC_${i}`,
  category: "forensic",
  prevEventHash: i ? `h${i - 1}` : null,
  eventHash: `h${i}`,
}));

function signals(overrides = {}) {
  return buildEvidenceTrustDecision({
    evidence: {
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
      recordedIntegrityVerifiedAtUtc: "2026-10-01T00:00:00.000Z",
      fileSha256: "a".repeat(64),
      fingerprintHash: FP,
      signatureBase64: "c2ln",
      signingKeyId: "k1",
      publicKeyPem: "-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----",
      signatureVerified: true,
      custodyChainValid: true,
      tsaStatus: "STAMPED",
      tsaValidatedAtUtc: "2026-10-01T00:00:01.000Z",
      otsStatus: "ANCHORED",
      otsAnchoredAtUtc: "2026-10-01T02:00:00Z",
      otsProofBase64: ANCHORED_PROOF.base64,
      ...overrides,
    },
    custodyEvents: forensic,
  }).signals;
}

const EMAIL_PERSONAL = {
  basis: "OBSERVED_AT_CAPTURE",
  recordedAtUtc: "2026-10-01T00:00:00.000Z",
  actorKind: "ACCOUNT_USER",
  contributorEmailProvided: null,
  authProvider: "EMAIL",
  emailVerified: true,
  identityLevel: "VERIFIED_EMAIL",
  workspaceKind: "PERSONAL",
  organizationVerified: null,
};

function matrix(overrides = {}) {
  return buildVerificationMatrix({
    signals: signals(overrides.evidence),
    identity: overrides.identity === undefined ? EMAIL_PERSONAL : overrides.identity,
    acquisitionMode: "acquisitionMode" in overrides ? overrides.acquisitionMode : "PROOVRA_WEB_UPLOAD",
    packageSeal: overrides.packageSeal ?? { kind: "SELF" },
    publication: overrides.publication ?? { kind: "DOCUMENT" },
  });
}

const statusOf = (m, key) => m.rows.find((r) => r.key === key).status;
const rowOf = (m, key) => m.rows.find((r) => r.key === key);

test("every required signal is a row, in one of the five statuses", () => {
  const m = matrix();
  for (const key of [
    "file_integrity",
    "custody_chain",
    "package_signature",
    "package_completeness",
    "tsa_token",
    "ots_anchoring",
    "account_identity",
    "organization_verification",
    "capture_method",
    "pre_proovra_provenance",
    "public_verify_publication",
  ]) {
    assert.ok(rowOf(m, key), key);
  }
  for (const r of m.rows) {
    assert.ok(["VERIFIED", "FAILED", "NOT_CHECKED", "NOT_APPLICABLE", "UNAVAILABLE"].includes(r.status), r.key);
  }
});

test("a pending OTS proof is NOT_CHECKED — never verified, passed or scored; only a valid upgraded proof is VERIFIED", () => {
  // A stored ANCHORED status over the real pending proof, and a plain pending record.
  for (const evidence of [{ otsProofBase64: REAL.boundProofBase64 }, { otsStatus: "PENDING", otsAnchoredAtUtc: null, otsProofBase64: REAL.boundProofBase64 }]) {
    const m = matrix({ evidence });
    const ots = rowOf(m, "ots_anchoring");
    assert.equal(ots.status, "NOT_CHECKED");
    assert.equal(ots.otsState, "PENDING");
    assert.equal(ots.statusLabel, "Pending");
    assert.equal(ots.statement, "OpenTimestamps proof is awaiting Bitcoin anchoring.");
    assert.doesNotMatch(ots.statement, /independently verified|anchored in Bitcoin/i);
    const json = JSON.stringify(m);
    assert.doesNotMatch(json, /"(points|maxPoints|score|verdict)"/);
    assert.doesNotMatch(json, /Attestation recorded/);
    assert.deepEqual(findForbiddenCustomerClaims(json), []);
  }
  // Only a valid upgraded proof is VERIFIED — with or without a derivable txid.
  assert.equal(statusOf(matrix(), "ots_anchoring"), "VERIFIED");
  assert.equal(statusOf(matrix({ evidence: { otsProofBase64: upgradedProof({ withTransaction: false }).base64 } }), "ots_anchoring"), "VERIFIED");
  // Status ANCHORED with no proof bytes is UNAVAILABLE, never verified.
  assert.equal(statusOf(matrix({ evidence: { otsProofBase64: null } }), "ots_anchoring"), "UNAVAILABLE");
});

test("genuinely verified integrity, custody, record signature and TSA stay VERIFIED", () => {
  const m = matrix();
  assert.equal(statusOf(m, "file_integrity"), "VERIFIED");
  assert.equal(statusOf(m, "custody_chain"), "VERIFIED");
  assert.equal(statusOf(m, "record_signature"), "VERIFIED");
  assert.equal(statusOf(m, "tsa_token"), "VERIFIED");
  // What was validated, then the one approved bounded sentence — never "qualified".
  assert.equal(rowOf(m, "tsa_token").statement, `RFC 3161 timestamp validated. ${TSA_VALIDATED_QUALIFICATION_STATEMENT}`);
  assert.ok(
    rowOf(m, "tsa_token").statement.endsWith(
      "Timestamp token and certificate chain validated; qualified-service status was not independently evaluated.",
    ),
  );
  // An unvalidated token is not.
  assert.equal(statusOf(matrix({ evidence: { tsaValidatedAtUtc: null } }), "tsa_token"), "NOT_CHECKED");
});

test("the bounded summary and the fixed limitation", () => {
  const m = matrix();
  assert.equal(
    m.summary,
    "Cryptographic integrity and PROOVRA custody checks passed for the preserved bytes. Any signal marked “Not checked” was not independently verified. This record does not by itself establish authorship, factual truth, pre-PROOVRA history or legal admissibility.",
  );
  assert.equal(m.limitation, VERIFICATION_LIMITATION);
  // A failed check is named, and nothing says the bytes passed.
  const failed = matrix({ evidence: { signatureVerified: false } });
  assert.match(failed.summary, /^Failed: Record signature. Do not rely on the preserved bytes/);
  assert.doesNotMatch(failed.summary, /checks passed/);
  assert.ok(failed.summary.endsWith(VERIFICATION_LIMITATION));
});

test("a verified email stays a verified email — never an organization, never OAuth", () => {
  const m = matrix();
  const account = rowOf(m, "account_identity");
  assert.equal(account.status, "VERIFIED");
  assert.match(account.statement, /^Authenticated email account: the account's email address was verified/);
  assert.match(account.statement, /identifies the account, not the person/);
  assert.doesNotMatch(JSON.stringify(m), /oauth/i);
  // A personal workspace is never an organization.
  const org = rowOf(m, "organization_verification");
  assert.equal(org.status, "NOT_APPLICABLE");
  assert.match(org.statement, /^Not established\. The record was created in a personal workspace\./);
  // A shared workspace without recorded verification: Not established.
  const shared = rowOf(matrix({ identity: { ...EMAIL_PERSONAL, workspaceKind: "SHARED" } }), "organization_verification");
  assert.equal(shared.status, "NOT_CHECKED");
  assert.equal(shared.statement, "Not established.");
  // Only a recorded organization verification is VERIFIED.
  assert.equal(statusOf(matrix({ identity: { ...EMAIL_PERSONAL, workspaceKind: "SHARED", organizationVerified: true } }), "organization_verification"), "VERIFIED");
  // An unverified email is not.
  assert.equal(statusOf(matrix({ identity: { ...EMAIL_PERSONAL, emailVerified: false, identityLevel: "BASIC_ACCOUNT" } }), "account_identity"), "NOT_CHECKED");
  // No snapshot: unavailable, never inferred.
  assert.equal(statusOf(matrix({ identity: null }), "account_identity"), "UNAVAILABLE");
});

test("account VERIFIED only from a submission-time snapshot that states the verification (2026-10-14)", () => {
  const acc = (identity) => statusOf(matrix({ identity: { ...EMAIL_PERSONAL, ...identity } }), "account_identity");
  assert.equal(acc({}), "VERIFIED");
  // An unknown verification state in a shared workspace (level ORGANIZATION_ACCOUNT) proves nothing.
  assert.equal(acc({ emailVerified: null, identityLevel: "ORGANIZATION_ACCOUNT", workspaceKind: "SHARED" }), "NOT_CHECKED");
  // A snapshot predating the field: the VERIFIED_EMAIL level was computed at the same moment.
  assert.equal(acc({ emailVerified: null }), "VERIFIED");
  // The record's own columns (not bound to the capture time) never verify.
  assert.equal(acc({ basis: "RECORDED_ON_RECORD", recordedAtUtc: null }), "NOT_CHECKED");
  assert.equal(acc({ basis: "RECORDED_ON_RECORD", authProvider: "GOOGLE", identityLevel: "OAUTH_BACKED_IDENTITY" }), "NOT_CHECKED");
  // An internally inconsistent snapshot never verifies.
  assert.equal(acc({ identityLevel: "OAUTH_BACKED_IDENTITY" }), "NOT_CHECKED");
  assert.equal(acc({ authProvider: "GOOGLE", identityLevel: "VERIFIED_EMAIL" }), "NOT_CHECKED");
  assert.equal(acc({ authProvider: "GOOGLE", identityLevel: "OAUTH_BACKED_IDENTITY" }), "VERIFIED");
});

test("upload is not capture: PROOVRA did not observe creation or editing before submission", () => {
  const m = matrix({ acquisitionMode: "PROOVRA_WEB_UPLOAD" });
  const method = rowOf(m, "capture_method");
  assert.equal(method.status, "NOT_APPLICABLE");
  assert.match(method.statement, /not captured by PROOVRA/);
  const provenance = rowOf(m, "pre_proovra_provenance");
  assert.equal(provenance.status, "NOT_CHECKED");
  assert.match(provenance.statement, /^PROOVRA did not observe creation or editing before submission\./);
  // A browser capture is client-attested — reported, not observed by the server.
  const web = rowOf(matrix({ acquisitionMode: "DIRECT_WEB_CAPTURE_EXTENSION" }), "capture_method");
  assert.equal(web.status, "NOT_CHECKED");
  assert.match(web.statement, /PROOVRA's server did not observe it/);
  // Pre-PROOVRA provenance is never VERIFIED, whatever the channel.
  for (const mode of ["PROOVRA_WEB_UPLOAD", "SECURE_INTAKE_LINK", "DIRECT_WEB_CAPTURE_EXTENSION", "DIRECT_SCREEN_CAPTURE_IOS"]) {
    assert.equal(statusOf(matrix({ acquisitionMode: mode }), "pre_proovra_provenance"), "NOT_CHECKED", mode);
  }
  assert.equal(statusOf(matrix({ acquisitionMode: null }), "capture_method"), "UNAVAILABLE");
});

test("package and publication rows say only what the surface can know", () => {
  assert.equal(statusOf(matrix({ packageSeal: { kind: "SELF" } }), "package_signature"), "NOT_APPLICABLE");
  const published = matrix({ packageSeal: { kind: "PUBLISHED", sealKeyId: "pkg", sealKeyVersion: 2 } });
  assert.equal(statusOf(published, "package_signature"), "VERIFIED");
  assert.match(rowOf(published, "package_signature").statement, /package-seal key pkg version 2/);
  assert.equal(statusOf(published, "package_completeness"), "VERIFIED");
  assert.equal(statusOf(matrix({ packageSeal: { kind: "LEGACY" } }), "package_signature"), "NOT_CHECKED");
  assert.equal(statusOf(matrix({ packageSeal: { kind: "NONE" } }), "package_signature"), "NOT_APPLICABLE");
  assert.equal(statusOf(matrix({ publication: { kind: "THIS_PAGE" } }), "public_verify_publication"), "VERIFIED");
  assert.equal(statusOf(matrix({ publication: { kind: "DOCUMENT" } }), "public_verify_publication"), "NOT_APPLICABLE");
});

test("a matrix round-trips through JSON unchanged", () => {
  const m = matrix();
  assert.deepEqual(parseVerificationMatrix(JSON.parse(JSON.stringify(m))), m);
  assert.equal(parseVerificationMatrix({ schema: "X", rows: [] }), null);
});

test("the forbidden-claims screen catches every banned form", () => {
  for (const text of ["STRONGLY_VERIFIED", "Score 95/100", "Trust score", "6 / 10 points", "Weighting: 75", "Passed signals: Core", "No degraded signals were recorded", "Reviewer reliance: High"]) {
    assert.notDeepEqual(findForbiddenCustomerClaims(text), [], text);
  }
  assert.deepEqual(findForbiddenCustomerClaims(matrix().summary), []);
});

test("an old stored snapshot is read back without its score, verdict or legacy anchoring pass", async () => {
  const { readStoredTrustDecision } = await import("../dist/index.js");
  const legacy = {
    verdict: "STRONGLY_VERIFIED",
    verdictLabel: "Recorded integrity verified",
    score: 96,
    maxScore: 100,
    scoreLabel: "96/100",
    relianceLevel: "high",
    confidenceLabel: "High",
    primaryReason: "Passed signals: Core integrity, Bitcoin anchoring. Degraded signals: No degraded signals were recorded.",
    passedSignals: 6,
    signals: [
      { key: "core_integrity", label: "Core integrity", status: "passed", points: 25, maxPoints: 25, summary: "Core integrity verified" },
      { key: "custody_chain", label: "Custody chain", status: "passed", points: 10, maxPoints: 10, summary: "hash chain verified" },
      { key: "bitcoin_anchoring", label: "Bitcoin anchoring", status: "passed", points: 10, maxPoints: 10, summary: "Anchored in Bitcoin" },
    ],
  };
  const d = readStoredTrustDecision(legacy);
  const json = JSON.stringify(d);
  assert.doesNotMatch(json, /"(points|maxPoints|score|scoreLabel|verdict|verdictLabel|relianceLevel|confidenceLabel|primaryReason|passedSignals)"/);
  assert.deepEqual(findForbiddenCustomerClaims(json), []);
  // A legacy anchoring "passed" (awarded for a txid on the row) reads UNAVAILABLE — never anchored.
  assert.equal(d.signals.find((s) => s.key === "bitcoin_anchoring").state, "UNAVAILABLE");
  assert.equal(d.anchoringState, "unavailable");
  assert.equal(d.anchoringStatusLabel, "Unavailable");
  assert.notEqual(d.presentationState, "VERIFIED_FINALIZED");
  assert.match(d.summary, /^Cryptographic integrity and PROOVRA custody checks passed/);
  assert.equal(readStoredTrustDecision(null), null);
});

test("a legacy timestamp pass without an explicit state is never re-read as validated", async () => {
  const { resolveSnapshotSignalState, toVerificationStatus } = await import("../dist/index.js");
  const state = resolveSnapshotSignalState({ key: "trusted_timestamp", status: "passed", summary: "Trusted timestamp recorded" });
  assert.equal(toVerificationStatus(state), "NOT_CHECKED");
  // An explicit PASSED (written from a recorded validation) stays VERIFIED.
  assert.equal(toVerificationStatus(resolveSnapshotSignalState({ key: "trusted_timestamp", state: "PASSED", status: "passed" })), "VERIFIED");
});

test("the BASIC tier withholds who submitted: identity rows are not disclosed, nothing else moves", async () => {
  const { withholdIdentityRows } = await import("../dist/index.js");
  const m = matrix();
  const w = withholdIdentityRows(m);
  for (const key of ["account_identity", "organization_verification"]) {
    assert.equal(statusOf(w, key), "NOT_APPLICABLE", key);
    assert.equal(rowOf(w, key).statement, "Not disclosed on this verification page.");
  }
  for (const r of m.rows.filter((x) => x.key !== "account_identity" && x.key !== "organization_verification")) {
    assert.deepEqual(rowOf(w, r.key), r);
  }
  assert.doesNotMatch(JSON.stringify(w), /Authenticated email account|personal workspace/i);
  assert.ok(w.summary.endsWith(VERIFICATION_LIMITATION));
});

test("OTS projection per state: pending, anchored, failed, unavailable and not requested each say exactly what is true", () => {
  const ots = (evidence) => rowOf(matrix({ evidence }), "ots_anchoring");
  const pending = ots({ otsStatus: "PENDING", otsAnchoredAtUtc: null, otsProofBase64: REAL.boundProofBase64 });
  assert.equal(pending.status, "NOT_CHECKED");
  assert.equal(pending.otsState, "PENDING");
  assert.equal(pending.statusLabel, "Pending");
  assert.equal(pending.statement, "OpenTimestamps proof is awaiting Bitcoin anchoring.");
  assert.doesNotMatch(pending.statement, /verified against the Bitcoin|anchored in Bitcoin|still being prepared/i);

  const anchored = ots({});
  assert.equal(anchored.status, "VERIFIED");
  assert.equal(anchored.otsState, "ANCHORED");
  assert.equal(anchored.statusLabel, "Anchored");
  assert.equal(anchored.statement, "OpenTimestamps proof anchored in Bitcoin.");
  assert.doesNotMatch(anchored.statement, /independently verified/i);

  // A proof that commits to another digest is FAILED on its own row …
  const failedMatrix = matrix({ evidence: { otsProofBase64: REAL.otherProofBase64 } });
  const failed = rowOf(failedMatrix, "ots_anchoring");
  assert.equal(failed.status, "FAILED");
  assert.equal(failed.otsState, "FAILED");
  assert.equal(failed.statusLabel, "Failed");
  assert.equal(failed.statement, "Bitcoin anchoring did not complete for this record.");
  // … and never fails integrity, signature or custody, nor tells the reader to distrust the bytes.
  for (const key of ["file_integrity", "record_signature", "custody_chain"]) assert.equal(statusOf(failedMatrix, key), "VERIFIED", key);
  assert.doesNotMatch(failedMatrix.summary, /Do not rely on the preserved bytes|Failed:/);
  assert.match(failedMatrix.summary, /^Cryptographic integrity and PROOVRA custody checks passed/);
  // A recorded failure (no proof) reads the same.
  const recorded = ots({ otsStatus: "FAILED", otsAnchoredAtUtc: null, otsProofBase64: null, otsFailureReason: "calendar unreachable" });
  assert.equal(recorded.status, "FAILED");
  assert.equal(recorded.statusLabel, "Failed");

  const unavailable = ots({ otsStatus: "ANCHORED", otsProofBase64: null });
  assert.equal(unavailable.status, "UNAVAILABLE");
  assert.equal(unavailable.otsState, "UNAVAILABLE");
  assert.equal(unavailable.statusLabel, "Unavailable");
  assert.equal(unavailable.statement, "The OpenTimestamps proof material cannot currently be read.");

  const none = ots({ otsStatus: null, otsAnchoredAtUtc: null, otsProofBase64: null });
  assert.equal(none.status, "NOT_APPLICABLE");
  assert.equal(none.otsState, "NOT_REQUESTED");
  assert.equal(none.statusLabel, "Not requested");
  assert.equal(none.statement, "No OpenTimestamps anchoring was requested for this record.");

  // Each row round-trips through a package read with its state; a legacy row without one is Unavailable.
  for (const row of [pending, anchored, failed, unavailable, none]) {
    const m = { schema: "PROOVRA_VERIFICATION_MATRIX_V1", rows: [row], summary: "", limitation: "" };
    assert.deepEqual(parseVerificationMatrix(JSON.parse(JSON.stringify(m))).rows[0], row, row.otsState);
  }
  const legacy = parseVerificationMatrix({ schema: "PROOVRA_VERIFICATION_MATRIX_V1", rows: [{ key: "ots_anchoring", label: "OTS", status: "VERIFIED", statement: "The proof was independently verified against the Bitcoin blockchain." }] });
  assert.equal(legacy.rows[0].otsState, "UNAVAILABLE");
  assert.equal(legacy.rows[0].status, "UNAVAILABLE");
  assert.equal(legacy.rows[0].statement, "The OpenTimestamps proof material cannot currently be read.");
});
