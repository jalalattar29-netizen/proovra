/**
 * UC-TRUST-001 / 002 / 005 / 008 and UC-PROV-001 at the shared authorities.
 *
 *   TRUST-008  a passing stored-bytes check is "Verified" only inside the
 *              short freshness window; older is STALE ("last verified").
 *   TRUST-005  the Basic Verify headline incorporates the stored bytes: a
 *              missing / substituted original is never a verified headline.
 *   TRUST-001  the expected digest is read from the SIGNED fingerprint, and
 *              columns that disagree with it are an integrity failure.
 *   TRUST-002  one OTS state, resolved from the stored proof bytes: a pending
 *              proof is never "anchored" (whatever the status column, txid or
 *              time says); a legacy unvalidated TSA token is never "validated".
 *   PROV-001   the server-received time is never presented as a device-
 *              declared capture time.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import * as shared from "../dist/index.js";
import { REAL, chainRecordFor, upgradedProof } from "./helpers/ots-fixtures.mjs";

const sha = (t) => createHash("sha256").update(t).digest("hex");
const HOUR = 60 * 60 * 1000;
const now = new Date("2026-10-01T12:00:00.000Z");

function facts(over = {}) {
  return {
    rejected: false,
    lastVerifiedAtUtc: null,
    lastCheckedAtUtc: null,
    lastOutcome: null,
    lastFailureCode: null,
    recheckRequestedAtUtc: null,
    ...over,
  };
}

test("TRUST-008: a passing check 3 days old is STALE, not Verified (30-day cadence no longer means current)", () => {
  const at = new Date(now.getTime() - 72 * HOUR);
  const s = shared.resolveStoredBytesIntegrity(
    facts({ lastVerifiedAtUtc: at, lastCheckedAtUtc: at, lastOutcome: "VERIFIED" }),
    now,
  );
  assert.equal(s.state, "verified_stale");
  assert.equal(s.checkStatus, "STALE");
  const row = shared.storedBytesVerificationRow(s);
  assert.notEqual(row.badge, "Verified");
  assert.match(row.label, /last verified/i);
});

test("TRUST-008: a passing check inside the freshness window is VERIFIED", () => {
  const at = new Date(now.getTime() - 2 * HOUR);
  const s = shared.resolveStoredBytesIntegrity(
    facts({ lastVerifiedAtUtc: at, lastCheckedAtUtc: at, lastOutcome: "VERIFIED", pinnedVersionId: "v1", recordedDigest: "a".repeat(64) }),
    now,
  );
  assert.equal(s.checkStatus, "VERIFIED");
  assert.equal(s.pinnedVersionId, "v1");
  assert.equal(shared.storedBytesVerificationRow(s).badge, "Verified");
});

test("TRUST-008: a fresh pass over an UNPINNED object (unversioned store) is never current — the object can be replaced in place", () => {
  const at = new Date(now.getTime() - 60 * 1000);
  const s = shared.resolveStoredBytesIntegrity(
    facts({ lastVerifiedAtUtc: at, lastCheckedAtUtc: at, lastOutcome: "VERIFIED", pinnedVersionId: null, recordedDigest: "a".repeat(64) }),
    now,
  );
  assert.equal(s.state, "verified_stale");
  assert.equal(s.checkStatus, "STALE");
  assert.equal(s.staleReason, "UNPINNED_VERSION");
  const row = shared.storedBytesVerificationRow(s);
  assert.notEqual(row.badge, "Verified");
  // "Last verified at" wording, and the true reason — never "outside the window".
  assert.match(row.label, /last verified/i);
  assert.match(row.detail, /no immutable version/);
  assert.doesNotMatch(row.detail, /outside the/);
});

test("TRUST-008: a pinned pass older than the window is STALE for that reason, with its time", () => {
  const at = new Date(now.getTime() - 30 * HOUR);
  const s = shared.resolveStoredBytesIntegrity(
    facts({ lastVerifiedAtUtc: at, lastCheckedAtUtc: at, lastOutcome: "VERIFIED", pinnedVersionId: "v1" }),
    now,
  );
  assert.equal(s.staleReason, "OUTSIDE_WINDOW");
  const row = shared.storedBytesVerificationRow(s);
  assert.equal(row.badge, "Stale");
  assert.match(row.detail, /outside the 24-hour freshness window/);
});

test("TRUST-008: a multi-part record whose every part is pinned is current inside the window", () => {
  const at = new Date(now.getTime() - 60 * 1000);
  const s = shared.resolveStoredBytesIntegrity(
    facts({ lastVerifiedAtUtc: at, lastCheckedAtUtc: at, lastOutcome: "VERIFIED", pinnedVersionId: null, versionPinned: true }),
    now,
  );
  assert.equal(s.checkStatus, "VERIFIED");
});

test("TRUST-008: substituted bytes -> MISMATCH; missing version -> UNAVAILABLE", () => {
  const mismatch = shared.resolveStoredBytesIntegrity(facts({ lastOutcome: "FAILED", lastFailureCode: "DIGEST_MISMATCH" }), now);
  assert.equal(mismatch.checkStatus, "MISMATCH");
  assert.equal(shared.storedBytesVerificationRow(mismatch).badge, "Mismatch");
  const gone = shared.resolveStoredBytesIntegrity(facts({ lastOutcome: "FAILED", lastFailureCode: "OBJECT_VERSION_MISSING" }), now);
  assert.equal(gone.checkStatus, "UNAVAILABLE");
  assert.equal(shared.storedBytesVerificationRow(gone).badge, "Unavailable");
});

function basic(storedBytes, extra = {}) {
  return shared.buildBasicVerification({
    now,
    integrity: { fingerprintMatches: true, signatureValid: true, custodyChainValid: true },
    fileSha256: "a".repeat(64),
    fingerprintHash: "b".repeat(64),
    storedBytes,
    capturedAtUtc: new Date("2026-09-01T10:00:00Z"),
    signedAtUtc: new Date("2026-09-01T10:01:00Z"),
    tsaStatus: null,
    tsaImprintMatches: null,
    tsaGenTimeUtc: null,
    ots: { status: "PENDING", proofBase64: REAL.boundProofBase64, fingerprintHash: REAL.boundFingerprintHash },
    latestReport: null,
    pairedPackage: null,
    ...extra,
  });
}

test("TRUST-005: OBJECT_VERSION_MISSING makes the original and the headline failed", () => {
  const gone = shared.resolveStoredBytesIntegrity(facts({ lastOutcome: "FAILED", lastFailureCode: "OBJECT_VERSION_MISSING" }), now);
  const b = basic(gone);
  assert.equal(b.original.state, "failed");
  assert.equal(b.verdict.state, "failed");
});

test("TRUST-005: never-rechecked stored bytes keep the headline at recorded_only", () => {
  const unknown = shared.resolveStoredBytesIntegrity(facts(), now);
  const b = basic(unknown);
  assert.equal(b.original.state, "verified");
  assert.equal(b.verdict.state, "recorded_only");
  assert.doesNotMatch(b.verdict.label, /re-verified/);
});

test("TRUST-001: expected digest comes from the signed fingerprint; columns that disagree fail", () => {
  const p0 = sha("part0");
  const p1 = sha("part1");
  const fp = JSON.stringify({
    v: 1,
    file: {
      multipart: true,
      parts: [
        { partIndex: 0, storageBucket: "b", storageKey: "k0", sizeBytes: 1, mimeType: "x", sha256: p0 },
        { partIndex: 1, storageBucket: "b", storageKey: "k1", sizeBytes: 1, mimeType: "x", sha256: p1 },
      ],
    },
  });
  const signed = shared.signedDigestsFromFingerprint(fp);
  assert.equal(signed.kind, "multipart");
  const composite = shared.signedRecordDigest(signed, sha);
  assert.equal(composite, sha(`${p0}|${p1}`));
  const good = shared.digestColumnsMatchSignedFingerprint(
    { fingerprintCanonicalJson: fp, fileSha256: composite, parts: [{ partIndex: 0, sha256: p0 }, { partIndex: 1, sha256: p1 }] },
    sha,
  );
  assert.equal(good, true);
  // An insider rewrote the columns consistently for substituted bytes.
  const evil = sha("evil");
  const bad = shared.digestColumnsMatchSignedFingerprint(
    { fingerprintCanonicalJson: fp, fileSha256: sha(`${evil}|${p1}`), parts: [{ partIndex: 0, sha256: evil }, { partIndex: 1, sha256: p1 }] },
    sha,
  );
  assert.equal(bad, false);
  const single = shared.signedDigestsFromFingerprint(JSON.stringify({ v: 1, file: { multipart: false, sha256: p0 } }));
  assert.deepEqual(single, { kind: "single", sha256: p0 });
  assert.equal(shared.signedDigestsFromFingerprint("not json"), null);
  // Basic Verify: columns disagreeing with the fingerprint fail the original.
  const b = basic(null, { digestColumnsMatchSignedFingerprint: false });
  assert.equal(b.original.state, "failed");
});

test("TRUST-002: a PENDING OTS proof is never anchored; unvalidated STAMPED is not validated", () => {
  const FP = REAL.boundFingerprintHash;
  // The real pending proof: PENDING, with its calendars and no Bitcoin facts.
  const pending = basic(null).anchoring;
  assert.equal(pending.otsState, "PENDING");
  assert.equal(pending.state, "pending");
  assert.equal(pending.status, "Pending");
  assert.equal(pending.attestationType, "PENDING_CALENDAR");
  assert.equal(pending.bitcoinTxid, null);
  assert.equal(pending.bitcoinBlockHeight, null);
  assert.equal(pending.anchoredAtUtc, null);
  // A stored ANCHORED status with an anchored-at time over the same pending bytes is still PENDING.
  const claimed = basic(null, {
    ots: { status: "ANCHORED", proofBase64: REAL.boundProofBase64, fingerprintHash: FP, anchoredAtUtc: now },
  }).anchoring;
  assert.equal(claimed.otsState, "PENDING");
  assert.equal(claimed.anchoredAtUtc, null);
  // Only a valid upgraded proof is ANCHORED, with the facts its path yields —
  // an attestation recorded, "not_checked", never "verified" without a chain check.
  const up = upgradedProof();
  const anchored = basic(null, { ots: { status: "ANCHORED", proofBase64: up.base64, fingerprintHash: FP, anchoredAtUtc: now } }).anchoring;
  assert.equal(anchored.otsState, "ANCHORED");
  assert.equal(anchored.otsVerification, "ATTESTATION_RECORDED");
  assert.equal(anchored.state, "not_checked");
  assert.equal(anchored.status, "Attestation recorded");
  assert.equal(anchored.secondaryStatus, "Not independently checked against Bitcoin");
  assert.equal(anchored.sentence, `The proof names Bitcoin block ${up.blockHeight}; PROOVRA has not checked it against the Bitcoin main chain.`);
  const verified = basic(null, { ots: { status: "ANCHORED", proofBase64: up.base64, fingerprintHash: FP, anchoredAtUtc: now, chain: chainRecordFor(up) } }).anchoring;
  assert.equal(verified.state, "verified");
  assert.equal(verified.otsVerification, "CHAIN_VERIFIED");
  assert.equal(verified.label, "Independently verified against the Bitcoin main chain");
  assert.equal(verified.chain.blockHeight, up.blockHeight);
  assert.equal(anchored.bitcoinTxid, up.txid);
  assert.equal(anchored.bitcoinBlockHeight, up.blockHeight);
  assert.equal(anchored.anchoredAtUtc, now.toISOString());
  // A proof bound to another digest is FAILED; status without proof is UNAVAILABLE; nothing requested is not issued.
  const other = basic(null, { ots: { status: "ANCHORED", proofBase64: REAL.otherProofBase64, fingerprintHash: FP } }).anchoring;
  assert.equal(other.otsState, "FAILED");
  assert.equal(other.failureCode, "PROOF_HASH_MISMATCH");
  const missing = basic(null, { ots: { status: "ANCHORED", proofBase64: null, fingerprintHash: FP } }).anchoring;
  assert.equal(missing.otsState, "UNAVAILABLE");
  assert.equal(missing.failureCode, "PROOF_MATERIAL_MISSING");
  assert.equal(basic(null, { ots: { status: null, proofBase64: null, fingerprintHash: FP } }).anchoring.state, "not_issued");
  // TSA: a stamped token without a validation time is recorded, not validated.
  assert.equal(shared.resolveTsaProofStatus({ tsaStatus: "STAMPED", tsaValidatedAtUtc: null }), "RECORDED_NOT_VALIDATED");
  assert.equal(shared.resolveTsaProofStatus({ tsaStatus: "STAMPED", tsaValidatedAtUtc: now }), "VALIDATED");
  // The provenance timeline only carries an OTS anchoring entry for an ANCHORED proof.
  const timeline = (ots) => shared.buildProvenanceTimeline({ serverReceivedAtUtc: now, ots }).entries.filter((e) => e.kind === "OTS_ANCHORED");
  assert.equal(timeline({ status: "ANCHORED", proofBase64: REAL.boundProofBase64, fingerprintHash: FP, anchoredAtUtc: now }).length, 0);
  assert.equal(timeline({ status: "ANCHORED", proofBase64: up.base64, fingerprintHash: FP, anchoredAtUtc: now }).length, 1);
});

test("PROV-001: the server-received time is never a device-declared capture time", () => {
  const b = basic(null);
  assert.equal(b.original.serverReceivedAtUtc, "2026-09-01T10:00:00.000Z");
  assert.equal(b.original.deviceDeclaredCaptureAtUtc, null);
  assert.equal(b.original.captureTimeStatement, "Capture time not available");
  const withDevice = basic(null, { deviceTimeIso: "2026-09-01T09:59:00.000Z" });
  assert.equal(withDevice.original.deviceDeclaredCaptureAtUtc, "2026-09-01T09:59:00.000Z");
  const t = shared.buildProvenanceTimeline({ serverReceivedAtUtc: now, recordCreatedAtUtc: now, finalizedAtUtc: now });
  assert.equal(t.captureTime, null);
  assert.equal(t.captureTimeStatement, "Capture time not available");
  assert.equal(t.entries.find((e) => e.kind === "SERVER_RECEIVED").label, "Server received at");
  const app = shared.buildProvenanceTimeline({
    serverReceivedAtUtc: now,
    applicationCaptureStartedAtUtc: "2026-09-30T10:00:00Z",
    applicationCaptureEndedAtUtc: "2026-09-30T10:05:00Z",
    tsa: { status: "STAMPED", validatedAtUtc: null, genTimeUtc: now },
  });
  assert.equal(app.captureTime.kind, "APPLICATION_OBSERVED");
  assert.equal(app.captureTime.confidence, "CLIENT_REPORTED");
  assert.equal(app.entries.find((e) => e.kind === "TSA").confidence, "RECORDED_NOT_VALIDATED");
});
