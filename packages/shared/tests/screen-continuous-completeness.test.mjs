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
