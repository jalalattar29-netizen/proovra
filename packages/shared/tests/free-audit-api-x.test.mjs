/**
 * FREE-USER AUDIT 0ea0 — API-X (shared): the shared halves of the client
 * lanes' cross-lane requests.
 *
 *   B5B-F-102  FULL_PACKAGE_REQUIRES_ORIGINAL_ACCESS has its own sentence.
 *   R1-F-01    Evidence Request refusals have user-facing entries.
 *   B4-F-102   a captured page address never carries a credential value or a
 *              fragment in the facts (new or stored).
 *   B4-F-103   a capture-window refusal is distinguishable.
 *   B4-F-206   a video part without audio states it (detail or generic).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveArtifactDownloadFailure,
  userFacingErrorFor,
  redactCapturedPageAddress,
  validateWebCaptureManifest,
  webCaptureManifestFacts,
  readCaptureManifestFacts,
  WEB_CAPTURE_MANIFEST_SCHEMA_VERSION,
  partAudioNotRecordedStatement,
  PART_AUDIO_NOT_RECORDED_STATEMENT,
} from "../dist/index.js";

const SHA = "c".repeat(64);

function webManifest(over = {}) {
  return {
    schemaVersion: WEB_CAPTURE_MANIFEST_SCHEMA_VERSION,
    captureMode: "VIEWPORT",
    captureSessionId: "11111111-1111-4111-8111-111111111111",
    captureStartedAtUtc: "2026-09-17T10:00:00.000Z",
    captureEndedAtUtc: "2026-09-17T10:00:02.000Z",
    page: {
      domain: "example.com",
      sourceUrlPrivate:
        "https://cdn.example.com/a/file.pdf?X-Amz-Signature=abc123&X-Amz-Credential=AKIA%2Fx&page=2&code=oauth-code#access_token=frag",
      title: "Example",
    },
    browser: { name: "Chrome", versionBucket: "140", os: "Windows", viewportW: 1280, viewportH: 800, devicePixelRatio: 1 },
    extensionVersion: "1.0.0",
    artifacts: [
      { role: "viewport_screenshot", partIndex: 0, expectedSha256: "a".repeat(64), sizeBytes: 1000, mediaType: "image/png", completeness: "CAPTURED" },
    ],
    completeness: "CAPTURED",
    pageMutatedDuringCapture: false,
    limitations: [],
    notes: [],
    ...over,
  };
}

test("B5B-F-102 — FULL_PACKAGE_REQUIRES_ORIGINAL_ACCESS points to the external disclosure package, not to holds", () => {
  const out = resolveArtifactDownloadFailure("verificationPackage", { statusCode: 403, code: "FULL_PACKAGE_REQUIRES_ORIGINAL_ACCESS" });
  assert.ok(out);
  assert.match(out.message, /original files/);
  assert.match(out.message, /external disclosure package is available instead/);
  assert.doesNotMatch(out.message, /hold/);
  assert.equal(out.retryable, false);
  assert.equal(out.action, "NONE");
  assert.equal(out.report, false);
});

test("R1-F-01 — Evidence Request refusal codes have user-facing entries (case-insensitive lookup)", () => {
  for (const code of ["transition_not_allowed", "internal_recipient_requires_assignee", "response_already_reviewed", "request_terminal"]) {
    const entry = userFacingErrorFor(code);
    assert.ok(entry, code);
    assert.ok(entry.title.length > 0 && entry.message.length > 0, code);
  }
});

test("B4-F-102 — the captured address keeps its path and harmless parameters, redacts credential values, drops the fragment", () => {
  assert.equal(
    redactCapturedPageAddress(
      "https://cdn.example.com/a/file.pdf?X-Amz-Signature=abc123&X-Amz-Credential=AKIA%2Fx&page=2&code=oauth-code#access_token=frag",
    ),
    "https://cdn.example.com/a/file.pdf?X-Amz-Signature=REDACTED&X-Amz-Credential=REDACTED&page=2&code=REDACTED",
  );
  assert.equal(redactCapturedPageAddress("https://example.com/plain"), "https://example.com/plain");
  assert.equal(redactCapturedPageAddress("https://example.com/p?"), "https://example.com/p");
  assert.equal(redactCapturedPageAddress("https://example.com/p?a%5Fb=1&api%5Fkey=s"), "https://example.com/p?a%5Fb=1&api%5Fkey=REDACTED");
});

test("B4-F-102 — new facts and facts stored before the redaction both read redacted", () => {
  const v = validateWebCaptureManifest(webManifest());
  assert.equal(v.ok, true);
  const facts = webCaptureManifestFacts(v.manifest, { manifestSha256: SHA, manifestPartIndex: 1 });
  assert.equal(
    facts.web.sourceUrlPrivate,
    "https://cdn.example.com/a/file.pdf?X-Amz-Signature=REDACTED&X-Amz-Credential=REDACTED&page=2&code=REDACTED",
  );
  // A legacy stored payload with the raw address.
  const stored = JSON.parse(JSON.stringify(facts));
  stored.web.sourceUrlPrivate = "https://example.com/doc?token=raw-secret&x=1";
  const read = readCaptureManifestFacts(stored);
  assert.ok(read);
  assert.equal(read.web.sourceUrlPrivate, "https://example.com/doc?token=REDACTED&x=1");
});

test("B4-F-103 — an impossible capture window is flagged as such; another manifest error is not", () => {
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const window = validateWebCaptureManifest(webManifest({ captureStartedAtUtc: new Date().toISOString(), captureEndedAtUtc: future }));
  assert.equal(window.ok, false);
  assert.equal(window.captureWindow, true);
  const other = validateWebCaptureManifest(webManifest({ captureMode: "NOT_A_MODE" }));
  assert.equal(other.ok, false);
  assert.notEqual(other.captureWindow, true);
});

test("B4-F-206 — a part without audio states it: the reason for the record's own surfaces, generic for public Verify", () => {
  const signals = { audioTracks: [], audioNotCapturedReason: "MICROPHONE_PERMISSION_DENIED" };
  assert.match(partAudioNotRecordedStatement(signals, { detail: "reason" }), /microphone permission was denied/);
  assert.equal(partAudioNotRecordedStatement(signals), PART_AUDIO_NOT_RECORDED_STATEMENT);
  assert.equal(partAudioNotRecordedStatement({ audioNotCapturedReason: "SOMETHING_NEW" }, { detail: "reason" }), PART_AUDIO_NOT_RECORDED_STATEMENT);
  assert.equal(partAudioNotRecordedStatement({ audioTracks: ["MICROPHONE"] }), null);
  assert.equal(partAudioNotRecordedStatement(null), null);
  assert.equal(partAudioNotRecordedStatement("x"), null);
});

test("B5A-F-13 (residual pass) — REPORT_REQUIRES_LOCATION_ACCESS names the location and the external package, not holds", () => {
  const out = resolveArtifactDownloadFailure("report", { statusCode: 403, code: "REPORT_REQUIRES_LOCATION_ACCESS" });
  assert.ok(out);
  assert.match(out.message, /exact capture location/);
  assert.match(out.message, /external disclosure package is available instead/);
  assert.doesNotMatch(out.message, /hold/);
  assert.equal(out.retryable, false);
  assert.equal(out.action, "NONE");
});
