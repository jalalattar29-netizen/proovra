/**
 * UC-PROV-003 — validated manifest facts are a persisted projection, and the
 * public form never carries the source URL or title.
 * UC-AND-011 / UC-AND-012 — the UC-2 frame manifest names a frame failure for
 * what it is and records a rotation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CAPTURE_MANIFEST_FACTS_SCHEMA,
  CAPTURE_MANIFEST_FACTS_STAGE,
  SCREEN_CAPTURE_LIMITATION_CODES,
  SCREEN_CAPTURE_MANIFEST_SCHEMA_VERSION,
  SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION,
  WEB_CAPTURE_MANIFEST_SCHEMA_VERSION,
  continuousCaptureManifestFacts,
  publicCaptureManifestFacts,
  readCaptureManifestFacts,
  screenCaptureManifestFacts,
  selectCaptureManifestFacts,
  validateScreenCaptureManifest,
  validateWebCaptureManifest,
  webCaptureManifestFacts,
} from "../dist/index.js";

const SHA = "c".repeat(64);

function webManifest(over = {}) {
  return {
    schemaVersion: WEB_CAPTURE_MANIFEST_SCHEMA_VERSION,
    captureMode: "FULL_PAGE",
    captureSessionId: "11111111-1111-4111-8111-111111111111",
    captureStartedAtUtc: "2026-09-17T10:00:00.000Z",
    captureEndedAtUtc: "2026-09-17T10:00:02.000Z",
    page: { domain: "Example.com", sourceUrlPrivate: "https://example.com/a?token=secret", title: "Private title" },
    browser: { name: "Chrome", versionBucket: "140", os: "Windows", viewportW: 1280, viewportH: 800, devicePixelRatio: 1 },
    extensionVersion: "1.2.3",
    artifacts: [
      { role: "viewport_screenshot", partIndex: 0, expectedSha256: "a".repeat(64), sizeBytes: 1000, mediaType: "image/png", completeness: "PARTIAL" },
    ],
    completeness: "PARTIAL",
    pageMutatedDuringCapture: true,
    limitations: ["PAGE_MUTATED_DURING_CAPTURE", "CROSS_ORIGIN_IFRAME_NOT_CAPTURED"],
    notes: [],
    ...over,
  };
}

function frameManifest(over = {}) {
  return {
    schemaVersion: SCREEN_CAPTURE_MANIFEST_SCHEMA_VERSION,
    captureSessionId: "11111111-1111-4111-8111-111111111111",
    captureStartedAtUtc: "2026-09-17T10:00:00.000Z",
    captureEndedAtUtc: "2026-09-17T10:00:02.000Z",
    device: { platform: "android", osVersion: "14", model: "Pixel 7", appVersion: "1.0.0", screenW: 1080, screenH: 2400, densityDpi: 420, orientation: "portrait" },
    osConsentGranted: true,
    artifacts: [
      { role: "screen_frame", partIndex: 0, frameIndex: 0, expectedSha256: "a".repeat(64), sizeBytes: 1000, mediaType: "image/png", widthPx: 1080, heightPx: 2400, capturedAtOffsetMs: 0, completeness: "CAPTURED" },
      { role: "screen_frame", partIndex: 1, frameIndex: 1, expectedSha256: "b".repeat(64), sizeBytes: 1000, mediaType: "image/png", widthPx: 2400, heightPx: 1080, capturedAtOffsetMs: 500, completeness: "CAPTURED" },
    ],
    completeness: "CAPTURED",
    stopReason: "USER_STOPPED",
    limitations: ["ORIENTATION_CHANGED_DURING_CAPTURE"],
    notes: [],
    ...over,
  };
}

test("UC-PROV-003: web facts carry URL, title, browser, extension version, window, completeness, mutation, limitations", () => {
  const v = validateWebCaptureManifest(webManifest());
  assert.equal(v.ok, true);
  const f = webCaptureManifestFacts(v.manifest, { manifestSha256: SHA, manifestPartIndex: 1 });
  assert.equal(f.schema, CAPTURE_MANIFEST_FACTS_SCHEMA);
  assert.equal(f.reportedBy, "CAPTURE_CLIENT");
  assert.equal(f.web.sourceUrlPrivate, "https://example.com/a?token=secret");
  assert.equal(f.web.titlePrivate, "Private title");
  assert.equal(f.web.domain, "example.com");
  assert.equal(f.web.pageMutatedDuringCapture, true);
  assert.equal(f.client.appVersion, "1.2.3");
  assert.equal(f.client.browserName, "Chrome");
  assert.deepEqual(f.clientCaptureWindow, { startedAtUtc: "2026-09-17T10:00:00.000Z", endedAtUtc: "2026-09-17T10:00:02.000Z" });
  assert.equal(f.completeness, "PARTIAL");
  assert.equal(f.reportedComplete, false);
  assert.deepEqual(f.limitations, ["PAGE_MUTATED_DURING_CAPTURE", "CROSS_ORIGIN_IFRAME_NOT_CAPTURED"]);
});

test("UC-PROV-003: the public form carries the domain only — no URL, no title", () => {
  const v = validateWebCaptureManifest(webManifest());
  const pub = publicCaptureManifestFacts(webCaptureManifestFacts(v.manifest, { manifestSha256: SHA, manifestPartIndex: 1 }));
  const json = JSON.stringify(pub);
  assert.ok(!json.includes("token=secret"));
  assert.ok(!json.includes("Private title"));
  assert.equal(pub.web.domain, "example.com");
});

test("UC-PROV-003: persisted facts round-trip through a trust-event payload and the selector", () => {
  const v = validateWebCaptureManifest(webManifest());
  const facts = webCaptureManifestFacts(v.manifest, { manifestSha256: SHA, manifestPartIndex: 1 });
  const payload = JSON.parse(JSON.stringify({ stage: CAPTURE_MANIFEST_FACTS_STAGE, facts }));
  assert.deepEqual(readCaptureManifestFacts(payload), facts);
  const events = [
    { code: "CAPTURE_ARTIFACT_RECEIVED", payload: { stage: "part_declared", partIndex: 0 } },
    { code: "CAPTURE_ARTIFACT_RECEIVED", payload },
    { code: "CAPTURE_SESSION_BOUND", payload: {} },
  ];
  assert.deepEqual(selectCaptureManifestFacts(events), facts);
  assert.equal(selectCaptureManifestFacts(events, { manifestSha256: "d".repeat(64) }), null);
  assert.equal(readCaptureManifestFacts({ stage: CAPTURE_MANIFEST_FACTS_STAGE, facts: { ...facts, schema: "OTHER" } }), null);
  assert.equal(readCaptureManifestFacts(null), null);
});

test("UC-PROV-003: continuous facts state completeness, recorded count and limitations", () => {
  const f = continuousCaptureManifestFacts(
    {
      schemaVersion: SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION,
      captureSessionId: "s",
      captureStartedAtUtc: "2026-09-17T10:00:00.000Z",
      captureEndedAtUtc: "2026-09-17T10:00:12.000Z",
      device: { platform: "ios", osVersion: "17.5", model: "iPhone", appVersion: "1.0.0", screenW: 1179, screenH: 2556, densityDpi: 480, orientation: "portrait" },
      osConsentGranted: true,
      totalDurationMs: 12000,
      recordedSegmentCount: 3,
      segments: [{}, {}],
      sessionCompleteness: "INTERRUPTED_SESSION",
      terminationReason: "USER_STOPPED",
      limitations: ["SEGMENT_UPLOAD_LOST"],
      notes: [],
    },
    { manifestSha256: SHA, manifestPartIndex: 2 },
  );
  assert.equal(f.kind, "SCREEN_CONTINUOUS");
  assert.equal(f.reportedComplete, false);
  assert.equal(f.screen.recordedSegmentCount, 3);
  assert.equal(f.screen.artifactCount, 2);
  assert.equal(f.client.platform, "ios");
  assert.deepEqual(readCaptureManifestFacts({ stage: CAPTURE_MANIFEST_FACTS_STAGE, facts: f }), f);
});

test("UC-AND-012: frames of both orientations need ORIENTATION_CHANGED_DURING_CAPTURE", () => {
  assert.equal(validateScreenCaptureManifest(frameManifest()).ok, true);
  const silent = validateScreenCaptureManifest(frameManifest({ limitations: [] }));
  assert.equal(silent.ok, false);
  assert.match(silent.error, /orientation transition/);
});

test("UC-AND-011: a failed frame read is FRAME_CAPTURE_FAILED, a code of its own", () => {
  assert.ok(SCREEN_CAPTURE_LIMITATION_CODES.includes("FRAME_CAPTURE_FAILED"));
  const m = frameManifest({ limitations: ["ORIENTATION_CHANGED_DURING_CAPTURE", "FRAME_CAPTURE_FAILED"] });
  const v = validateScreenCaptureManifest(m);
  assert.equal(v.ok, true);
  const f = screenCaptureManifestFacts(v.manifest, { manifestSha256: SHA, manifestPartIndex: 2 });
  assert.equal(f.kind, "SCREEN_FRAMES");
  assert.equal(f.screen.artifactCount, 2);
  assert.ok(f.limitations.includes("FRAME_CAPTURE_FAILED"));
});

test("UC-EXT-004: DOM_SNAPSHOT_MISSING exists, and any limitation makes a CAPTURED claim invalid", () => {
  const w = webManifest({ completeness: "PARTIAL", pageMutatedDuringCapture: false, limitations: ["DOM_SNAPSHOT_MISSING"] });
  assert.equal(validateWebCaptureManifest(w).ok, true);
  const lying = validateWebCaptureManifest(webManifest({ completeness: "CAPTURED", limitations: ["DOM_SNAPSHOT_MISSING"] }));
  assert.equal(lying.ok, false);
  assert.match(lying.error, /cannot be CAPTURED/);
  assert.equal(validateWebCaptureManifest(webManifest({ completeness: "CAPTURED", pageMutatedDuringCapture: false, limitations: [] })).ok, true);
});
