/**
 * UC-STR-001 — ONE capture bound, everywhere.
 *
 * The native recorders cannot import packages/shared/src/capture-limits.ts, so
 * they carry its values by hand. This parses the Kotlin and Swift constants and
 * the JS binding clamp and fails the moment any of them drifts from THE source.
 *
 * RED on the pre-remediation tree: Kotlin clamped maxSegments to 600, Swift
 * defaulted to 600 and the shared stream bound was 600 — against a part writer
 * that accepts indexes 0..199.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  CAPTURE_LIMITS,
  MAX_EVIDENCE_PARTS,
  SCREEN_CONTINUOUS_STREAM_BOUNDS,
  SCREEN_CONTINUOUS_MANIFEST_BOUNDS,
} from "@proovra/shared";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(HERE, rel), "utf8");
const KT = "../modules/proovra-screen-capture/android/src/main/java/com/proovra/screencapture";
const service = read(`${KT}/ContinuousScreenCaptureService.kt`);
const module = read(`${KT}/ProovraScreenCaptureModule.kt`);
const handler = read("../plugins/broadcast-extension/SampleHandler.swift");
const shared = read("../modules/proovra-screen-capture/ios/ProovraBroadcastShared.swift");
const iosModule = read("../modules/proovra-screen-capture/ios/ProovraScreenCaptureModule.swift");

const num = (src, re, what) => {
  const m = src.match(re);
  assert.ok(m, `${what} not found`);
  return Number(m[1].replace(/_/g, "").replace(/L/g, ""));
};
const product = (src, re, what) => {
  const m = src.match(re);
  assert.ok(m, `${what} not found`);
  return m[1].split("*").map((x) => Number(x.trim().replace(/L$/, ""))).reduce((a, b) => a * b, 1);
};

test("THE source: segments + the manifest part fit the record's part bound", () => {
  assert.equal(CAPTURE_LIMITS.maxEvidenceParts, MAX_EVIDENCE_PARTS);
  assert.equal(CAPTURE_LIMITS.maxContinuousSegments, MAX_EVIDENCE_PARTS - 1);
  assert.equal(SCREEN_CONTINUOUS_STREAM_BOUNDS.maxSegments, CAPTURE_LIMITS.maxContinuousSegments);
  assert.equal(SCREEN_CONTINUOUS_MANIFEST_BOUNDS.maxSegments, CAPTURE_LIMITS.maxContinuousSegments);
});

test("Kotlin carries THE capture limits by value", () => {
  assert.equal(num(service, /const val MAX_SEGMENTS = (\d+)/, "MAX_SEGMENTS"), CAPTURE_LIMITS.maxContinuousSegments);
  assert.equal(num(service, /const val DEFAULT_SEGMENT_MS = (\d+)/, "DEFAULT_SEGMENT_MS"), CAPTURE_LIMITS.defaultContinuousSegmentMs);
  assert.equal(num(service, /const val MIN_SEGMENT_MS = (\d+)/, "MIN_SEGMENT_MS"), CAPTURE_LIMITS.minContinuousSegmentMs);
  assert.equal(num(service, /const val MAX_SEGMENT_MS = (\d+)/, "MAX_SEGMENT_MS"), CAPTURE_LIMITS.maxContinuousSegmentMs);
  assert.equal(product(service, /MAX_SESSION_MS = ([\dL *]+)\n/, "MAX_SESSION_MS"), CAPTURE_LIMITS.maxContinuousSessionMs);
  assert.equal(product(service, /MAX_SEGMENT_BYTES = ([\dL *]+)\n/, "MAX_SEGMENT_BYTES"), CAPTURE_LIMITS.maxContinuousSegmentBytes);
  assert.equal(num(service, /BITRATE = ([\d_]+)/, "BITRATE"), SCREEN_CONTINUOUS_STREAM_BOUNDS.videoBitrateBps);
  assert.equal(num(service, /FRAME_RATE = (\d+)/, "FRAME_RATE"), SCREEN_CONTINUOUS_STREAM_BOUNDS.videoFrameRate);
  // The module clamps with those constants — no second literal ceiling.
  assert.match(module, /coerceIn\(1, ContinuousScreenCaptureService\.MAX_SEGMENTS\)/);
  assert.ok(!/coerceIn\(1, 600\)/.test(module), "the 600 literal is back");
});

test("Swift (extension + app) carries THE capture limits by value", () => {
  assert.equal(num(handler, /maxSegmentsLimit = (\d+)/, "SampleHandler.maxSegmentsLimit"), CAPTURE_LIMITS.maxContinuousSegments);
  assert.equal(num(handler, /defaultSegmentMs = (\d+)/, "SampleHandler.defaultSegmentMs"), CAPTURE_LIMITS.defaultContinuousSegmentMs);
  assert.equal(num(handler, /minSegmentMs = (\d+)/, "SampleHandler.minSegmentMs"), CAPTURE_LIMITS.minContinuousSegmentMs);
  assert.equal(num(handler, /maxSegmentMsLimit = (\d+)/, "SampleHandler.maxSegmentMsLimit"), CAPTURE_LIMITS.maxContinuousSegmentMs);
  assert.equal(num(shared, /static let maxSegments = (\d+)/, "ProovraBroadcastLimits.maxSegments"), CAPTURE_LIMITS.maxContinuousSegments);
  assert.equal(num(shared, /static let defaultSegmentMs = (\d+)/, "ProovraBroadcastLimits.defaultSegmentMs"), CAPTURE_LIMITS.defaultContinuousSegmentMs);
  assert.ok(!/\?\? 600\b/.test(iosModule + handler), "a 600 default is back");
});
