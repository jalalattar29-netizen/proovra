/**
 * UC-STR-001 / UC-STR-002 / UC-IOS-001 / UC-IOS-004 — the continuity manifest
 * must not let a truncated recording pass as COMPLETE, and its bounds must fit
 * the part writer.
 *
 * RED on the V1 contract: a manifest listing 3 of 4 recorded segments sealed as
 * COMPLETE_SESSION (runtime/probes/continuous-ios.json#missingTail), the
 * validator accepted 600 segments against a 200-part record, and the iOS device
 * block the Swift extension actually wrote was refused as `invalid device.screenW`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  validateScreenContinuousManifest,
  SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION,
  SCREEN_CONTINUOUS_MANIFEST_BOUNDS,
  SCREEN_CONTINUOUS_STREAM_BOUNDS,
  SCREEN_CONTINUOUS_LIMITATION_CODES,
  SCREEN_CONTINUOUS_TERMINATION_REASONS,
  CAPTURE_LIMITS,
  MAX_EVIDENCE_PARTS,
  validateContinuousDeviceBlock,
} from "../dist/index.js";

function segment(i, over = {}) {
  return {
    role: "screen_segment",
    partIndex: i,
    sequence: i,
    expectedSha256: String.fromCharCode(97 + (i % 6)).repeat(64),
    sizeBytes: 2048,
    mediaType: "video/mp4",
    startedAtOffsetMs: i * 6000,
    durationMs: 6000,
    widthPx: 1080,
    heightPx: 2400,
    orientation: "portrait",
    ...over,
  };
}

function manifest(n, over = {}) {
  return {
    schemaVersion: SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION,
    captureSessionId: "11111111-1111-4111-8111-111111111111",
    captureStartedAtUtc: "2026-09-17T10:00:00.000Z",
    captureEndedAtUtc: new Date(Date.parse("2026-09-17T10:00:00.000Z") + n * 6000).toISOString(),
    device: {
      platform: "android",
      osVersion: "14",
      model: "Pixel 7",
      appVersion: "1.0.0",
      screenW: 1080,
      screenH: 2400,
      densityDpi: 420,
      orientation: "portrait",
    },
    osConsentGranted: true,
    totalDurationMs: n * 6000,
    recordedSegmentCount: n,
    segments: Array.from({ length: n }, (_, i) => segment(i)),
    sessionCompleteness: "COMPLETE_SESSION",
    terminationReason: "USER_STOPPED",
    limitations: [],
    notes: [],
    ...over,
  };
}

test("UC-STR-001: one bound — segments + the manifest part fit the part writer", () => {
  assert.equal(MAX_EVIDENCE_PARTS, 200);
  assert.equal(CAPTURE_LIMITS.maxContinuousSegments, MAX_EVIDENCE_PARTS - 1);
  assert.ok(SCREEN_CONTINUOUS_STREAM_BOUNDS.maxSegments + 1 <= MAX_EVIDENCE_PARTS);
  assert.ok(SCREEN_CONTINUOUS_MANIFEST_BOUNDS.maxSegments + 1 <= MAX_EVIDENCE_PARTS);
  assert.equal(SCREEN_CONTINUOUS_STREAM_BOUNDS.maxSessionMs, CAPTURE_LIMITS.maxContinuousSessionMs);
  assert.equal(SCREEN_CONTINUOUS_STREAM_BOUNDS.maxSessionBytes, CAPTURE_LIMITS.maxContinuousSessionBytes);
  const over = manifest(1);
  over.segments = Array.from({ length: MAX_EVIDENCE_PARTS }, (_, i) => segment(i));
  over.recordedSegmentCount = MAX_EVIDENCE_PARTS;
  over.totalDurationMs = MAX_EVIDENCE_PARTS * 6000;
  over.captureEndedAtUtc = new Date(Date.parse(over.captureStartedAtUtc) + over.totalDurationMs).toISOString();
  assert.equal(validateScreenContinuousManifest(over).ok, false);
});

test("the contract is versioned: V2 requires recordedSegmentCount", () => {
  assert.match(SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION, /_V2$/);
  const m = manifest(3);
  delete m.recordedSegmentCount;
  const r = validateScreenContinuousManifest(m);
  assert.equal(r.ok, false);
  assert.match(r.error, /recordedSegmentCount/);
  assert.equal(validateScreenContinuousManifest({ ...manifest(2), schemaVersion: "PROOVRA_SCREEN_CAPTURE_CONTINUOUS_MANIFEST_V1" }).ok, false);
});

test("UC-STR-002: a lost TAIL cannot seal as COMPLETE (recorded 4, listed 3)", () => {
  const m = manifest(4);
  m.segments = m.segments.slice(0, 3);
  const r = validateScreenContinuousManifest(m);
  assert.equal(r.ok, false);
  assert.match(r.error, /recordedSegmentCount|recorded/);
});

test("UC-STR-002: COMPLETE whose last segment ends short of totalDurationMs is refused (tail coverage)", () => {
  const m = manifest(3, { totalDurationMs: 3 * 6000 + SCREEN_CONTINUOUS_MANIFEST_BOUNDS.maxGapMs + 1 });
  m.captureEndedAtUtc = new Date(Date.parse(m.captureStartedAtUtc) + m.totalDurationMs).toISOString();
  const r = validateScreenContinuousManifest(m);
  assert.equal(r.ok, false);
  assert.match(r.error, /tail|totalDurationMs/);
});

test("UC-STR-002: COMPLETE whose first segment starts late is refused (head coverage)", () => {
  const m = manifest(2);
  m.segments = m.segments.map((s) => ({ ...s, startedAtOffsetMs: s.startedAtOffsetMs + 4000 }));
  m.totalDurationMs = 2 * 6000 + 4000;
  m.captureEndedAtUtc = new Date(Date.parse(m.captureStartedAtUtc) + m.totalDurationMs).toISOString();
  const r = validateScreenContinuousManifest(m);
  assert.equal(r.ok, false);
});

test("UC-STR-002: recorded > listed seals only as INTERRUPTED with SEGMENT_UPLOAD_LOST", () => {
  assert.ok(SCREEN_CONTINUOUS_LIMITATION_CODES.includes("SEGMENT_UPLOAD_LOST"));
  const lost = manifest(4, { sessionCompleteness: "INTERRUPTED_SESSION" });
  lost.segments = lost.segments.slice(0, 3);
  assert.equal(validateScreenContinuousManifest(lost).ok, false, "a silent loss must name its limitation");
  lost.limitations = ["SEGMENT_UPLOAD_LOST"];
  assert.equal(validateScreenContinuousManifest(lost).ok, true);
});

test("UC-STR-002: a lost MIDDLE segment is an INTERRUPTED gap, never COMPLETE", () => {
  const m = manifest(4);
  m.segments = [m.segments[0], m.segments[1], m.segments[3]];
  assert.equal(validateScreenContinuousManifest(m).ok, false);
  const honest = { ...m, sessionCompleteness: "INTERRUPTED_SESSION", limitations: ["SEGMENT_UPLOAD_LOST"] };
  assert.equal(validateScreenContinuousManifest(honest).ok, true);
  const unlabelled = { ...m, sessionCompleteness: "INTERRUPTED_SESSION", limitations: ["CAPTURE_INTERRUPTED"] };
  assert.equal(validateScreenContinuousManifest(unlabelled).ok, false, "a sequence gap needs SEGMENT_UPLOAD_LOST");
});

test("UC-STR-002: duplicate sequence and same sequence/different digest are refused by name", () => {
  const m = manifest(3);
  m.segments[2] = { ...m.segments[2], sequence: 1, partIndex: 2 };
  const r = validateScreenContinuousManifest(m);
  assert.equal(r.ok, false);
  assert.match(r.error, /duplicate segment\.sequence|partIndex must equal/);
  const d = manifest(2);
  d.segments.push({ ...d.segments[1], expectedSha256: "f".repeat(64) });
  assert.equal(validateScreenContinuousManifest(d).ok, false);
});

test("UC-STR-002: a segment's partIndex is its sequence (the manifest covers the declared parts from 0)", () => {
  const m = manifest(2);
  m.segments[1] = { ...m.segments[1], partIndex: 5 };
  const r = validateScreenContinuousManifest(m);
  assert.equal(r.ok, false);
  assert.match(r.error, /partIndex/);
});

test("UC-STR-002: conflicting terminal state — COMPLETE carrying an interruption/loss limitation", () => {
  for (const code of ["CAPTURE_INTERRUPTED", "SEGMENT_UPLOAD_LOST", "SEGMENT_WRITE_FAILED", "BROADCAST_PAUSED"]) {
    assert.ok(SCREEN_CONTINUOUS_LIMITATION_CODES.includes(code), code);
    const r = validateScreenContinuousManifest(manifest(2, { limitations: [code] }));
    assert.equal(r.ok, false, code);
  }
  assert.equal(validateScreenContinuousManifest(manifest(2, { terminationReason: "INTERRUPTED" })).ok, false);
});

test("UC-IOS-006: an UNKNOWN termination is only ever INTERRUPTED", () => {
  assert.ok(SCREEN_CONTINUOUS_TERMINATION_REASONS.includes("UNKNOWN"));
  assert.equal(validateScreenContinuousManifest(manifest(2, { terminationReason: "UNKNOWN" })).ok, false);
  assert.equal(
    validateScreenContinuousManifest(
      manifest(2, { terminationReason: "UNKNOWN", sessionCompleteness: "INTERRUPTED_SESSION", limitations: ["CAPTURE_INTERRUPTED"] }),
    ).ok,
    true,
  );
});

test("UC-IOS-001: the device block is ONE contract with specific errors", () => {
  const ok = validateContinuousDeviceBlock(manifest(1).device);
  assert.equal(ok.ok, true);
  const swiftV1 = { platform: "ios", osVersion: "17.5", model: "iPhone", appVersion: "1.0.0" };
  const r = validateContinuousDeviceBlock(swiftV1);
  assert.equal(r.ok, false);
  assert.equal(r.error, "invalid device.screenW");
  assert.equal(validateContinuousDeviceBlock({ ...manifest(1).device, orientation: "sideways" }).error, "invalid device.orientation");
  assert.equal(validateContinuousDeviceBlock({ ...manifest(1).device, densityDpi: 0 }).error, "invalid device.densityDpi");
  assert.equal(validateContinuousDeviceBlock({ ...manifest(1).device, screenW: 2400 }).error, "device.orientation does not match its dimensions");
});

// ---------------------------------------------------------------- AUD-017
//
// Completeness is the client's statement. The server refuses what it CAN see
// (sequence holes, bad offsets, a duration longer than its own session window,
// a recorded count below the running count declared with the segments) and
// every surface states the rest as client-reported.

const interrupted = (n, over = {}) =>
  manifest(n, { sessionCompleteness: "INTERRUPTED_SESSION", terminationReason: "INTERRUPTED", limitations: ["CAPTURE_INTERRUPTED"], ...over });

test("AUD-017: a hidden tail with a lowered recorded count passes the shape check — and is only ever client-reported", async () => {
  const { continuousCaptureManifestFacts, captureCompletenessRows, captureCompletenessNote } = await import("../dist/index.js");
  // The recorder made 5, the client uploaded 2 and claims it recorded 2.
  const m = manifest(2);
  const v = validateScreenContinuousManifest(m);
  assert.equal(v.ok, true, "the server cannot see segments that were never declared");
  const facts = continuousCaptureManifestFacts(v.manifest, { manifestSha256: "a".repeat(64), manifestPartIndex: 2 });
  const rows = captureCompletenessRows(facts);
  assert.deepEqual(rows, [
    { label: "Completeness (client-reported)", value: "Reported complete by the capture client" },
    { label: "Segments (client-reported)", value: "Segments delivered 2 of 2 recorded (client-reported)" },
  ]);
  for (const r of rows) assert.doesNotMatch(r.value, /verified|independent|proven/i);
  assert.match(captureCompletenessNote(facts), /cannot verify segments the client never declared/);
});

test("AUD-017: an internal sequence hole is refused unless named as a loss, whatever the completeness", () => {
  const m = interrupted(4);
  m.segments = [m.segments[0], m.segments[1], m.segments[3]];
  assert.match(validateScreenContinuousManifest(m).error, /not contiguous/);
  assert.match(validateScreenContinuousManifest({ ...m, sessionCompleteness: "COMPLETE_SESSION", terminationReason: "USER_STOPPED", limitations: [] }).error, /not contiguous|recorded/);
});

test("AUD-017: overlapping or non-monotonic offsets are refused for an INTERRUPTED session too", () => {
  const overlap = interrupted(3);
  overlap.segments[1] = { ...overlap.segments[1], startedAtOffsetMs: 6000 - SCREEN_CONTINUOUS_MANIFEST_BOUNDS.maxOverlapMs - 1 };
  assert.match(validateScreenContinuousManifest(overlap).error, /overlap/);
  const backwards = interrupted(3);
  backwards.segments[2] = { ...backwards.segments[2], startedAtOffsetMs: 0 };
  assert.match(validateScreenContinuousManifest(backwards).error, /overlap/);
});

test("AUD-017: a segment ending after totalDurationMs is refused for every session (0 stays the iOS 'unknown' fallback)", () => {
  const m = interrupted(3, { totalDurationMs: 2 * 6000 });
  assert.match(validateScreenContinuousManifest(m).error, /ends after totalDurationMs/);
  assert.equal(validateScreenContinuousManifest(interrupted(3, { totalDurationMs: 0 })).ok, true);
  assert.equal(validateScreenContinuousManifest(interrupted(3)).ok, true);
});

test("AUD-017: a duration (or a segment) longer than the server-observed session window is refused", () => {
  const opened = Date.parse("2026-09-17T09:59:59.000Z");
  const B = SCREEN_CONTINUOUS_MANIFEST_BOUNDS;
  // 3 x 6 s claimed, but the server saw the session open for only 10 s.
  const shortWindow = { openedAtMs: opened, nowMs: opened + 10_000 };
  for (const m of [manifest(3), interrupted(3)]) {
    assert.match(validateScreenContinuousManifest(m, { sessionWindow: shortWindow }).error, /server-observed session window/);
  }
  const zeroDuration = interrupted(3, { totalDurationMs: 0 });
  assert.match(validateScreenContinuousManifest(zeroDuration, { sessionWindow: shortWindow }).error, /server-observed session window/);
  // Within the slack it holds.
  const enough = { openedAtMs: opened, nowMs: opened + 18_000 - B.timingSlackMs };
  assert.equal(validateScreenContinuousManifest(manifest(3), { sessionWindow: enough }).ok, true);
});

test("AUD-017: a recorded count below the running recordedThrough the client declared is refused", () => {
  for (const m of [manifest(2), interrupted(2)]) {
    const r = validateScreenContinuousManifest(m, { declaredRecordedThroughMax: 5 });
    assert.equal(r.ok, false);
    assert.match(r.error, /below the recorder count declared/);
  }
  assert.equal(validateScreenContinuousManifest(manifest(2), { declaredRecordedThroughMax: 2 }).ok, true);
  const lost = manifest(5, { sessionCompleteness: "INTERRUPTED_SESSION", terminationReason: "INTERRUPTED", limitations: ["SEGMENT_UPLOAD_LOST"] });
  lost.segments = lost.segments.slice(0, 2);
  assert.equal(validateScreenContinuousManifest(lost, { declaredRecordedThroughMax: 5 }).ok, true, "the honest loss seals");
});

test("AUD-017: a legacy client without recordedThrough is accepted and stays client-reported", async () => {
  const { continuousCaptureManifestFacts, readCaptureManifestFacts, captureCompletenessRows } = await import("../dist/index.js");
  assert.equal(validateScreenContinuousManifest(manifest(2), { declaredRecordedThroughMax: null }).ok, true);
  const facts = continuousCaptureManifestFacts(manifest(2), { manifestSha256: "a".repeat(64), manifestPartIndex: 2 });
  assert.equal(facts.screen.declaredRecordedThroughMax, null);
  // Facts recorded before AUD-017 carry no such field and read back as null.
  const historical = JSON.parse(JSON.stringify(facts));
  delete historical.screen.declaredRecordedThroughMax;
  const read = readCaptureManifestFacts(historical);
  assert.equal(read.screen.declaredRecordedThroughMax, null);
  assert.equal(captureCompletenessRows(read)[1].value, "Segments delivered 2 of 2 recorded (client-reported)");
});

test("AUD-017: the segment line is ONE wording — delivered of the larger recorded count; none for other kinds", async () => {
  const { continuousSegmentCountsText, captureCompletenessRows, captureCompletenessNote } = await import("../dist/index.js");
  const base = { kind: "SCREEN_CONTINUOUS", completeness: "INTERRUPTED_SESSION", reportedComplete: false };
  assert.equal(
    continuousSegmentCountsText({ ...base, screen: { artifactCount: 2, recordedSegmentCount: 4, declaredRecordedThroughMax: 3 } }),
    "Segments delivered 2 of 4 recorded (client-reported)",
  );
  assert.equal(
    continuousSegmentCountsText({ ...base, screen: { artifactCount: 2, recordedSegmentCount: 2, declaredRecordedThroughMax: 5 } }),
    "Segments delivered 2 of 5 recorded (client-reported)",
  );
  assert.equal(
    continuousSegmentCountsText({ ...base, screen: { artifactCount: 2, recordedSegmentCount: null } }),
    "Segments delivered 2; recorded count not reported (client-reported)",
  );
  assert.equal(captureCompletenessRows({ ...base, screen: { artifactCount: 2, recordedSegmentCount: 4 } })[0].value,
    "Reported not complete by the capture client (Interrupted session)");
  const frames = { kind: "SCREEN_FRAMES", completeness: "CAPTURED", reportedComplete: true, screen: { artifactCount: 3, recordedSegmentCount: null } };
  assert.equal(continuousSegmentCountsText(frames), null);
  assert.equal(captureCompletenessRows(frames).length, 1);
  assert.equal(captureCompletenessNote(frames), null);
});
