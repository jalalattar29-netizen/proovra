/**
 * AUD-001 — a client-declared capture channel is the client's report.
 * AUD-015 — every channel states one receipt-onward observation boundary.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ACQUISITION_CHANNEL_AUTHORITIES,
  EVIDENCE_ACQUISITION_MODES,
  buildVerificationMatrix,
  findForbiddenCustomerClaims,
  resolveEvidenceAcquisition,
} from "../dist/index.js";

const CLIENT_DECLARED = [
  "PROOVRA_MOBILE_APP",
  "DIRECT_SCREEN_CAPTURE_ANDROID",
  "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS",
  "DIRECT_SCREEN_CAPTURE_IOS",
];

// ---------------------------------------------------------------- AUD-001

test("AUD-001: the app and screen channels are CLIENT_DECLARED and read as the client's report", () => {
  for (const mode of CLIENT_DECLARED) {
    const a = resolveEvidenceAcquisition({ acquisitionMode: mode });
    assert.equal(a.channelAuthority, "CLIENT_DECLARED", mode);
    assert.match(a.label, /^Reported by the client as /, mode);
    assert.match(a.statement, /^The submitting client reported this/, mode);
    assert.match(a.channelAuthorityLabel, /not verified by PROOVRA/, mode);
    for (const text of [a.label, a.statement, a.observedByProovra, a.attested, a.boundary]) {
      assert.deepEqual(findForbiddenCustomerClaims(text), [], `${mode}: ${text}`);
    }
  }
});

test("AUD-001: the mode string never makes a channel trusted; only a verified attestation does", () => {
  for (const mode of EVIDENCE_ACQUISITION_MODES) {
    const a = resolveEvidenceAcquisition({ acquisitionMode: mode });
    assert.notEqual(a.channelAuthority, "PLATFORM_ATTESTED", mode);
    assert.ok(ACQUISITION_CHANNEL_AUTHORITIES.includes(a.channelAuthority), mode);
    // An attestation that is not verified is ignored.
    assert.notEqual(resolveEvidenceAcquisition({ acquisitionMode: mode, verifiedChannelAttestation: { verified: false } }).channelAuthority, "PLATFORM_ATTESTED");
  }
  assert.equal(
    resolveEvidenceAcquisition({ acquisitionMode: "PROOVRA_MOBILE_APP", verifiedChannelAttestation: { verified: true } }).channelAuthority,
    "PLATFORM_ATTESTED",
  );
  // A server-route channel is never upgraded by an attestation.
  assert.equal(
    resolveEvidenceAcquisition({ acquisitionMode: "PROOVRA_WEB_UPLOAD", verifiedChannelAttestation: { verified: true } }).channelAuthority,
    "SERVER_ROUTE",
  );
  assert.equal(resolveEvidenceAcquisition({ acquisitionMode: null }).channelAuthority, "NOT_RECORDED");
});

test("AUD-001: the verification matrix never says PROOVRA software reported a client-declared capture", () => {
  for (const mode of ["DIRECT_SCREEN_CAPTURE_ANDROID", "DIRECT_SCREEN_CAPTURE_IOS", "PROOVRA_MOBILE_APP"]) {
    const m = buildVerificationMatrix({ signals: [], identity: null, acquisitionMode: mode, packageSeal: { kind: "SELF" }, publication: { kind: "DOCUMENT" } });
    const text = JSON.stringify(m);
    assert.doesNotMatch(text, /reported by PROOVRA software/i, mode);
    assert.deepEqual(findForbiddenCustomerClaims(text), [], mode);
  }
});

test("AUD-001: the forbidden-claim gate catches an unqualified PROOVRA capture-channel claim", () => {
  for (const claim of [
    "This material was submitted through the PROOVRA mobile app in a server-issued capture session.",
    "Captured by PROOVRA on an Android device.",
    "The PROOVRA iOS app reports that it recorded this device screen",
  ]) {
    assert.ok(findForbiddenCustomerClaims(claim).includes("unqualified PROOVRA capture channel"), claim);
  }
  assert.deepEqual(findForbiddenCustomerClaims("Reported by the client as a PROOVRA mobile app submission, not captured by PROOVRA."), []);
});

// ---------------------------------------------------------------- AUD-015

test("AUD-015: every channel has one concise receipt-onward boundary", () => {
  for (const mode of [...EVIDENCE_ACQUISITION_MODES, null]) {
    const b = resolveEvidenceAcquisition({ acquisitionMode: mode }).boundary;
    assert.match(b, /^PROOVRA proves /, String(mode));
    assert.match(b, /integrity and custody from (?:upload|intake) onward/, String(mode));
    assert.equal(b.split(/(?<=\.)\s/).length, 1, `${mode}: one sentence`);
  }
});
