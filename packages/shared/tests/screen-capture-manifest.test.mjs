import assert from "node:assert/strict";
import { test } from "node:test";

import {
  validateScreenCaptureManifest,
  SCREEN_CAPTURE_MANIFEST_SCHEMA_VERSION,
  SCREEN_CAPTURE_MANIFEST_BOUNDS,
} from "../dist/screen-capture-manifest.js";

function goodManifest(over = {}) {
  return {
    schemaVersion: SCREEN_CAPTURE_MANIFEST_SCHEMA_VERSION,
    captureSessionId: "11111111-1111-4111-8111-111111111111",
    captureStartedAtUtc: "2026-09-17T10:00:00.000Z",
    captureEndedAtUtc: "2026-09-17T10:00:02.000Z",
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
    artifacts: [
      {
        role: "screen_frame",
        partIndex: 0,
        frameIndex: 0,
        expectedSha256: "a".repeat(64),
        sizeBytes: 1000,
        mediaType: "image/png",
        widthPx: 1080,
        heightPx: 2400,
        capturedAtOffsetMs: 0,
        completeness: "CAPTURED",
      },
    ],
    completeness: "CAPTURED",
    stopReason: "USER_STOPPED",
    limitations: [],
    notes: [],
    ...over,
  };
}

test("accepts a well-formed screen-capture manifest", () => {
  const r = validateScreenCaptureManifest(goodManifest());
  assert.equal(r.ok, true);
});

test("binds to the expected session id", () => {
  const m = goodManifest();
  assert.equal(validateScreenCaptureManifest(m, { expectedSessionId: m.captureSessionId }).ok, true);
  assert.equal(
    validateScreenCaptureManifest(m, { expectedSessionId: "22222222-2222-4222-8222-222222222222" }).ok,
    false,
  );
});

test("rejects an unknown schema version", () => {
  assert.equal(validateScreenCaptureManifest(goodManifest({ schemaVersion: "OTHER" })).ok, false);
});

test("rejects a non-android platform", () => {
  const m = goodManifest();
  m.device = { ...m.device, platform: "ios" };
  assert.equal(validateScreenCaptureManifest(m).ok, false);
});

test("rejects a bad frame digest", () => {
  const m = goodManifest();
  m.artifacts[0].expectedSha256 = "not-a-hash";
  assert.equal(validateScreenCaptureManifest(m).ok, false);
});

test("rejects a duplicate partIndex and a duplicate frameIndex", () => {
  const dupPart = goodManifest({
    artifacts: [
      { role: "screen_frame", partIndex: 0, frameIndex: 0, expectedSha256: "a".repeat(64), sizeBytes: 1, mediaType: "image/png", widthPx: 1, heightPx: 1, capturedAtOffsetMs: 0, completeness: "CAPTURED" },
      { role: "screen_frame", partIndex: 0, frameIndex: 1, expectedSha256: "b".repeat(64), sizeBytes: 1, mediaType: "image/png", widthPx: 1, heightPx: 1, capturedAtOffsetMs: 1, completeness: "CAPTURED" },
    ],
  });
  assert.equal(validateScreenCaptureManifest(dupPart).ok, false);
});

test("rejects an empty and an oversized frame set", () => {
  assert.equal(validateScreenCaptureManifest(goodManifest({ artifacts: [] })).ok, false);
  const many = Array.from({ length: SCREEN_CAPTURE_MANIFEST_BOUNDS.maxFrames + 1 }, (_, i) => ({
    role: "screen_frame",
    partIndex: i,
    frameIndex: i,
    expectedSha256: "a".repeat(64),
    sizeBytes: 1,
    mediaType: "image/png",
    widthPx: 1,
    heightPx: 1,
    capturedAtOffsetMs: i,
    completeness: "CAPTURED",
  }));
  assert.equal(validateScreenCaptureManifest(goodManifest({ artifacts: many })).ok, false);
});

test("rejects an unknown limitation code and stop reason", () => {
  assert.equal(validateScreenCaptureManifest(goodManifest({ limitations: ["NONSENSE"] })).ok, false);
  assert.equal(validateScreenCaptureManifest(goodManifest({ stopReason: "NONSENSE" })).ok, false);
});
