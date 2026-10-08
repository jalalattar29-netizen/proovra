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
      fingerprintHash: "b".repeat(64),
      signatureBase64: "c2ln",
      signingKeyId: "k1",
      publicKeyPem: "-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----",
      signatureVerified: true,
      custodyChainValid: true,
      tsaStatus: "STAMPED",
      tsaValidatedAtUtc: "2026-10-01T00:00:01.000Z",
      otsStatus: "ANCHORED",
      otsAnchoredAtUtc: "2026-10-01T02:00:00Z",
      otsBitcoinTxid: "c".repeat(64),
      otsAnchorCheck: "PROOF_STRUCTURE",
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

test("an unchecked OTS proof is NOT_CHECKED — never verified, passed or scored", () => {
  for (const otsAnchorCheck of ["PROOF_STRUCTURE", null]) {
    const m = matrix({ evidence: { otsAnchorCheck } });
    const ots = rowOf(m, "ots_anchoring");
    assert.equal(ots.status, "NOT_CHECKED");
    assert.match(ots.statement, /PROOVRA has not checked the proof against the Bitcoin chain/);
    assert.doesNotMatch(ots.statement, /verified against the Bitcoin chain/);
    const json = JSON.stringify(m);
    assert.doesNotMatch(json, /"(points|maxPoints|score|verdict)"/);
    assert.deepEqual(findForbiddenCustomerClaims(json), []);
  }
  // Pending and stale are not checked either.
  assert.equal(statusOf(matrix({ evidence: { otsStatus: "PENDING", otsAnchoredAtUtc: null, otsBitcoinTxid: null, otsAnchorCheck: null, otsProofPresent: true, otsSubmittedAtUtc: new Date().toISOString() } }), "ots_anchoring"), "NOT_CHECKED");
  // Only a recorded chain check with a txid is VERIFIED.
  assert.equal(statusOf(matrix({ evidence: { otsAnchorCheck: "BITCOIN_VERIFIED", otsAnchorCheckedAtUtc: "2026-10-01T03:00:00Z" } }), "ots_anchoring"), "VERIFIED");
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
    "Cryptographic integrity and PROOVRA custody checks passed for the preserved bytes. Any signal marked NOT_CHECKED was not independently verified. This record does not by itself establish authorship, factual truth, pre-PROOVRA history or legal admissibility.",
  );
  assert.equal(m.limitation, VERIFICATION_LIMITATION);
  // A failed check is named, and nothing says the bytes passed.
  const failed = matrix({ evidence: { signatureVerified: false } });
  assert.match(failed.summary, /^Record signature FAILED\. Do not rely on the preserved bytes/);
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
  assert.equal(d.signals.find((s) => s.key === "bitcoin_anchoring").state, "PRESENT_NOT_INDEPENDENTLY_VERIFIED");
  assert.equal(d.anchoringState, "present_not_verified");
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

test("OTS projection per state: pending, present, verified, failed and not requested each say exactly what is true", () => {
  const ots = (evidence) => rowOf(matrix({ evidence }), "ots_anchoring");
  const pending = ots({ otsStatus: "PENDING", otsAnchoredAtUtc: null, otsBitcoinTxid: null, otsAnchorCheck: null, otsProofPresent: false, otsSubmittedAtUtc: new Date().toISOString() });
  assert.equal(pending.status, "NOT_CHECKED");
  assert.match(pending.statement, /Bitcoin anchoring is pending/);
  assert.match(pending.statement, /has not been independently chain-verified/);
  assert.doesNotMatch(pending.statement, /verified against the Bitcoin chain|anchored in Bitcoin/i);

  const present = ots({});
  assert.equal(present.status, "NOT_CHECKED");
  assert.match(present.statement, /not independently chain-verified/);

  assert.equal(ots({ otsAnchorCheck: "BITCOIN_VERIFIED", otsAnchorCheckedAtUtc: "2026-10-01T03:00:00Z" }).status, "VERIFIED");

  const failedMatrix = matrix({ evidence: { otsStatus: "FAILED", otsAnchoredAtUtc: null, otsBitcoinTxid: null, otsAnchorCheck: null, otsFailureReason: "calendar unreachable" } });
  const failed = rowOf(failedMatrix, "ots_anchoring");
  assert.equal(failed.status, "FAILED");
  assert.match(failed.statement, /Bitcoin anchoring only/);
  // An OTS failure never falsely fails integrity, signature or custody.
  for (const key of ["file_integrity", "record_signature", "custody_chain"]) assert.equal(statusOf(failedMatrix, key), "VERIFIED", key);

  const none = ots({ otsStatus: null, otsAnchoredAtUtc: null, otsBitcoinTxid: null, otsAnchorCheck: null });
  assert.equal(none.status, "UNAVAILABLE");
  assert.equal(none.statement, "Bitcoin anchoring was not requested or is not available for this record.");
});
